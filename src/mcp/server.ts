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
import { remember, recall, listCorpora } from "./tools.js";
import { initEmbeddings } from "./embeddings.js";

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
          }),
        ),
      },
    },
    async (a) => {
      // Minimal compile bridge: wrap bare EmbeddingState into RecallDeps.
      // The server task will integrate this properly.
      const r = await recall(session, {
        about: a.about,
        subject: a.subject,
        key: a.key,
        maxTokens: a.maxTokens,
        limit: a.limit,
        corpus: a.corpus ?? defaultCorpus,
      }, { embeddings: await initEmbeddings() });
      const matchLines = r.matches
        .map((m) => `- ${m.subject} ${m.key} = ${JSON.stringify(m.value)} (p=${m.confidence.toFixed(2)}, score=${m.score.toFixed(2)})`)
        .join("\n");
      const text = `# Recall: ${a.about}\n\n${r.content || "(no composed context)"}\n\n## Top matches\n${matchLines || "(none)"}`;
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: { corpus: r.corpus, content: r.content, matches: r.matches },
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
