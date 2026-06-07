/**
 * Mneme MCP server — a thin stdio shell over the `Session` facade exposing
 * remember / recall / list_corpora tools. The agent gets a frictionless,
 * algebra-backed memory; the heavy lifting lives in ./tools.ts and the surface.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { basename } from "node:path";
import { openSession } from "../surface/index.js";
import { remember, recall, listCorpora, keyCensus } from "./tools.js";
import { initEmbeddings } from "./embeddings.js";
import { loadMnemeConfig } from "./config.js";
import { appendRecallLog } from "./recall-log.js";

export interface McpServerOptions {
  dbPath?: string;
  defaultCorpus?: string;
}

/** Build the configured McpServer (does not connect a transport — caller does). */
export function createMnemeMcpServer(opts: McpServerOptions = {}): {
  server: McpServer;
  defaultCorpus: string;
  dbPath: string;
} {
  const dbPath = opts.dbPath ?? process.env.MNEME_DB ?? "./.mneme/store.db";
  // Per-repo corpus: prefer Claude Code's CLAUDE_PROJECT_DIR (the stable project
  // root it sets on spawned MCP servers) over raw cwd, so one user-scoped server
  // partitions claims by repo automatically. MNEME_CORPUS overrides per repo.
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const defaultCorpus =
    opts.defaultCorpus ?? process.env.MNEME_CORPUS ?? (basename(projectDir) || "default");

  // Config at startup: bad config prevents the server from reaching ready state.
  // loadMnemeConfig throws on invalid config — intentionally NOT wrapped in try/catch.
  const config = loadMnemeConfig(dbPath);

  const session = openSession({ dbPath, writer: "mcp" });
  const server = new McpServer({ name: "mneme", version: "0.2.0" });

  server.registerTool(
    "remember",
    {
      title: "Remember a claim",
      description:
        "Store a typed claim (subject, key, value) with optional confidence and tags. Use for durable facts, decisions, or context worth recalling later.",
      inputSchema: {
        subject: z.string().describe("the entity the claim is about, e.g. 'project:mneme' or 'host:web-01'"),
        key: z.string().describe("the attribute/predicate, e.g. 'decision', 'status', 'owner'"),
        value: z.string().describe("the claim value"),
        confidence: z.number().min(0).max(1).optional().describe("0..1 certainty; defaults to 1"),
        tags: z.array(z.string()).optional(),
        corpus: z.string().optional().describe(`corpus to write to; defaults to '${defaultCorpus}'`),
        scope: z
          .record(z.string(), z.string())
          .optional()
          .describe("optional scope fields for this claim, e.g. { project: 'mneme', context: 'prod' }"),
        validFrom: z
          .string()
          .optional()
          .describe("optional ISO-8601 date-time string for the start of the validity interval, e.g. '2026-01-01T00:00:00Z'"),
      },
      // Append-only write: not read-only, but non-destructive (never overwrites or deletes)
      // and not idempotent (each call commits a new claim).
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      outputSchema: {
        id: z.string().describe("the committed claim's id"),
        status: z.string().describe("committed | rejected | duplicate"),
        corpus: z.string().describe("the corpus the claim was written to"),
      },
    },
    async (a) => {
      const r = remember(session, {
        subject: a.subject,
        key: a.key,
        value: a.value,
        confidence: a.confidence,
        tags: a.tags,
        corpus: a.corpus ?? defaultCorpus,
        scope: a.scope,
        validFrom: a.validFrom,
      });
      const structuredContent = { id: r.id, status: r.status, corpus: r.corpus };
      return {
        content: [{ type: "text" as const, text: `${r.status} ${r.id} in corpus '${r.corpus}'` }],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "recall",
    {
      title: "Recall relevant claims",
      description:
        "Similarity-rank stored claims against a query and return a token-bounded context plus the top matches with their confidence. Optionally filter by subject and/or key first.",
      inputSchema: {
        about: z.string().describe("what you want to recall, free text"),
        subject: z.string().optional().describe("restrict to this subject before ranking"),
        key: z.string().optional().describe("restrict to this key before ranking"),
        maxTokens: z.number().int().positive().optional().describe("token budget for the composed context (default 2000)"),
        limit: z.number().int().positive().optional().describe("how many top matches to return (default 5)"),
        corpus: z.string().optional().describe(`corpus to read; defaults to '${defaultCorpus}'`),
        abstainBelowTop: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("abstention threshold 0..1: if the top score is strictly below this value, the entire result is suppressed and abstained=true (default 0 = off)"),
        relevanceFloor: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("per-entry precision floor 0..1: entries with score below this are dropped; abstained stays false even if floor empties the result (default 0 = off)"),
      },
      // Pure read: no state change, repeatable.
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      outputSchema: {
        corpus: z.string(),
        content: z.string().describe("the composed, token-bounded context (markdown)"),
        matches: z.array(
          z.object({
            subject: z.string(),
            key: z.string(),
            value: z.any().describe("the claim value (any JSON)"),
            confidence: z.number().describe("point estimate of the claim's confidence, 0..1"),
            score: z.number().describe("similarity score against the query"),
            id: z.string().describe("claim id — provenance handle to cite the exact claim"),
            tags: z.array(z.string()).describe("claim tags (e.g. session:...) — attribution handle"),
          }),
        ),
        topScore: z.number().optional().describe("pre-knob top similarity score; present when the corpus has at least one scored claim"),
        abstained: z.boolean().describe("true when abstainBelowTop was applied and the top score was below the threshold"),
        rankFn: z.string().describe("the similarity function name used for ranking (e.g. 'jaccard' or 'hybrid')"),
        warnings: z.array(z.string()).optional().describe("non-fatal warnings from alias loading or cardinality checking"),
        coverage: z.object({
          entities: z.array(z.object({ text: z.string(), supported: z.boolean() })),
          missing: z.array(z.string()),
        }).describe("entity-coverage facts over the pre-knob survivors; agents decide refusal"),
      },
    },
    async (a) => {
      const resolvedCorpus = a.corpus ?? defaultCorpus;

      // Embeddings lazy: first recall pays the init cost; boot stays instant.
      // RecallDeps includes keyCardinality from config loaded at startup.
      const embeddings = await initEmbeddings();
      const r = await recall(session, {
        about: a.about,
        subject: a.subject,
        key: a.key,
        maxTokens: a.maxTokens,
        limit: a.limit,
        corpus: resolvedCorpus,
        abstainBelowTop: a.abstainBelowTop,
        relevanceFloor: a.relevanceFloor,
      }, { embeddings, keyCardinality: config.keyCardinality });

      // Append recall-log entry (best-effort, synchronous, never throws into handler).
      appendRecallLog(dbPath, {
        ts: new Date().toISOString(),
        corpus: resolvedCorpus,
        about: a.about,
        topScore: r.topScore,
        matchCount: r.matches.length,
        abstained: r.abstained,
        rankFn: r.rankFn,
      });

      // Surface warnings to stderr (house convention: tools stay pure; server does I/O).
      if (r.warnings && r.warnings.length > 0) {
        for (const w of r.warnings) {
          console.error(`[mneme/recall] ${w}`);
        }
      }

      const matchLines = r.matches
        .map((m) => `- ${m.subject} ${m.key} = ${JSON.stringify(m.value)} (p=${m.confidence.toFixed(2)}, score=${m.score.toFixed(2)})`)
        .join("\n");
      const text = `# Recall: ${a.about}\n\n${r.content || "(no composed context)"}\n\n## Top matches\n${matchLines || "(none)"}`;
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: {
          corpus: r.corpus,
          content: r.content,
          matches: r.matches,
          topScore: r.topScore,
          abstained: r.abstained,
          rankFn: r.rankFn,
          coverage: r.coverage,
          warnings: r.warnings,
        },
      };
    },
  );

  server.registerTool(
    "list_corpora",
    {
      title: "List corpora",
      description: "List the claim corpora available in this Mneme store.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      outputSchema: {
        corpora: z.array(z.object({ id: z.string(), displayName: z.string() })),
      },
    },
    async () => {
      const r = listCorpora(session);
      const text = r.corpora.map((c) => `${c.id} (${c.displayName})`).join("\n") || "(no corpora yet)";
      return { content: [{ type: "text" as const, text }], structuredContent: { corpora: r.corpora } };
    },
  );

  server.registerTool(
    "key_census",
    {
      title: "Key census",
      description:
        "Census the distinct keys in a corpus, score all key-pairs for similarity, and surface alias candidates. Use to audit key proliferation and ratify key aliases.",
      inputSchema: {
        corpus: z.string().optional().describe(`corpus to census; defaults to '${defaultCorpus}'`),
        limit: z.number().int().positive().optional().describe("max key-pair candidates to return (default 20)"),
      },
      // Pure read: no state change, repeatable.
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      outputSchema: {
        corpus: z.string(),
        keys: z.array(z.object({ key: z.string(), claims: z.number() })).describe("distinct live keys with per-key claim counts"),
        candidates: z.array(z.object({ a: z.string(), b: z.string(), score: z.number() })).describe("top key-pair similarity candidates sorted descending, truncated to limit"),
        aliases: z.record(z.string()).describe("resolved alias map: variant → canonical"),
        unratified: z.array(z.string()).describe("self-alias keys (un-ratified — variant maps to itself)"),
        warnings: z.array(z.string()).describe("non-fatal warnings from alias loading or key-pair scoring"),
        rankFn: z.string().describe("similarity function used for key-pair scoring"),
        content: z.string().describe("composed human-readable census report with ratification affordance"),
      },
    },
    async (a) => {
      const resolvedCorpus = a.corpus ?? defaultCorpus;

      // Embeddings lazy: first census pays the init cost; boot stays instant.
      const embeddings = await initEmbeddings();
      const r = await keyCensus(session, {
        corpus: resolvedCorpus,
        limit: a.limit,
      }, { embeddings, keyCardinality: config.keyCardinality });

      // Surface warnings to stderr (house convention: tools stay pure; server does I/O).
      if (r.warnings.length > 0) {
        for (const w of r.warnings) {
          console.error(`[mneme/key_census] ${w}`);
        }
      }

      return {
        content: [{ type: "text" as const, text: r.content || "(empty corpus — no keys found)" }],
        structuredContent: {
          corpus: r.corpus,
          keys: r.keys,
          candidates: r.candidates,
          aliases: r.aliases,
          unratified: r.unratified,
          warnings: r.warnings,
          rankFn: r.rankFn,
          content: r.content,
        },
      };
    },
  );

  return { server, defaultCorpus, dbPath };
}

/** Start the server on stdio (the bin entry point). */
export async function runStdio(): Promise<void> {
  const { server, defaultCorpus, dbPath } = createMnemeMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the MCP channel.
  console.error(`mneme MCP server on stdio — default corpus '${defaultCorpus}', db ${dbPath}`);
}
