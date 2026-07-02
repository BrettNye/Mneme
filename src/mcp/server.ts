/**
 * Mneme MCP server — a thin stdio shell over the `Session` facade exposing
 * remember / recall / list_corpora tools. The agent gets a frictionless,
 * algebra-backed memory; the heavy lifting lives in the surface
 * (`../surface/recall.ts`, `../surface/remember.ts`).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { remember, recall, listCorpora, keyCensus, subjectCensus, reconcile, explainRecall, pointEstimate, type RecallTrace } from "../surface/index.js";
// Not (yet) re-exported from ../surface/index.js — imported directly per house
// convention (the mcp layer may import surface modules directly).
import { audit } from "../surface/audit.js";
import { lineageOf } from "../surface/history.js";
import { openMnemeEngine } from "./engine.js";
import { appendRecallLog } from "./recall-log.js";

/** Write discipline surfaced to clients as MCP server instructions (loaded per session). */
const MNEME_WRITE_SCHEMA = `Mneme stores typed claims (subject, key, value) as durable, confidence-scored memory. When writing with the remember tool:

- RECALL BEFORE YOU WRITE. Run recall for the claim first. If a close match exists, raise/adjust its confidence or write a refined claim — don't mint a near-duplicate. Key proliferation is a real cost (audit with key_census).
- subject = the entity, typed "type:name" — e.g. project:crewtracks, project:mneme, host:web-01. Reuse stable subjects.
- key = a kebab-case predicate, 1-4 dot-separated segments, most-general first — e.g. events.durability.in-memory-only, pagination.shape, decision, status. Reuse existing keys (check key_census) rather than minting variants.
- confidence = the default of 1 is almost always WRONG for a learned claim. Set it: ~0.7 for a fresh single observation, 0.85-0.95 when verified against code or seen repeatedly, 1.0 only for an unconditional fact. Lower it on near-misses.
- scope = { project, context } when the claim is project- or environment-specific. tags = lowercase topical labels.
- CAPTURE LESSONS, NOT TRANSIENTS. Store what stays true and generalizes ("specs here recurrently assume durable events — verify against the in-memory caveat"), not artifact-local findings that die on fix ("this spec's section 8 is wrong"). Test: still true and useful three artifacts from now?
- RECONCILE ENTITIES BEFORE MINTING. Before writing a new subject or key, run reconcile (and subject_census to audit) to reuse an existing canonical entity; entity fragmentation is the #1 ingestion failure mode.
- If recall/key_census warns that a single-cardinality key holds ≥2 distinct values that should coexist, declare it multi with declare_cardinality.
- Pass explain: true to recall to audit why each claim was served / merged / deprecated / dropped.
- Run audit periodically to review proposed canonicalizations (aliases / cardinality) — propose-then-confirm, never auto-applied.

The corpus auto-partitions per repo (default = project dir name); pass corpus only to cross that boundary.`;

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
  // Single bootstrap path shared with any embedding plugin: db path resolution,
  // per-repo corpus default, and config loading (throws on bad config at startup —
  // intentionally NOT wrapped in try/catch) all live in openMnemeEngine.
  const { session, dbPath, defaultCorpus, keyCardinality, initEmbeddings } = openMnemeEngine({
    dbPath: opts.dbPath,
    corpus: opts.defaultCorpus,
  });
  const server = new McpServer({ name: "mneme", version: "0.2.0" }, { instructions: MNEME_WRITE_SCHEMA });

  server.registerTool(
    "remember",
    {
      title: "Remember a claim",
      description:
        "Store a typed claim (subject, key, value) with optional confidence and tags. Use for durable facts, decisions, or context worth recalling later. " +
        "Reconcile the subject/key first (reconcile) to avoid fragmenting claims across near-duplicate entities.",
      inputSchema: {
        subject: z.string().describe("the entity the claim is about, e.g. 'project:mneme' or 'host:web-01'"),
        key: z.string().describe("kebab-case predicate, 1-4 dot segments, general->specific, e.g. 'events.durability.in-memory-only', 'decision'; reuse existing keys (key_census) over minting variants"),
        value: z.string().describe("the claim value"),
        confidence: z.number().min(0).max(1).optional().describe("0..1 certainty. Default 1 is rarely right for a learned claim — use ~0.7 fresh, 0.85+ when verified/repeated, 1 only for unconditional facts"),
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
        supersession: z
          .object({
            action: z.string().describe("committed | superseded | merged | duplicate"),
            deprecatedIds: z.array(z.string()).describe("live claims this write deprecated (action=superseded)"),
            mergedInto: z.string().optional().describe("action=merged/duplicate: the surviving claim it was absorbed into"),
            reason: z.any().optional().describe("vocabulary-aligned disposition reason"),
          })
          .optional()
          .describe("best-effort attribution of what this write did to its (subject,key) group"),
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
      const structuredContent = { id: r.id, status: r.status, corpus: r.corpus, supersession: r.supersession };
      let text = `${r.status} ${r.id} in corpus '${r.corpus}'`;
      if (r.supersession && r.supersession.action !== "committed") {
        if (r.supersession.action === "superseded") {
          const n = r.supersession.deprecatedIds.length;
          text += ` (superseded ${n} earlier claim${n === 1 ? "" : "s"})`;
        } else if (r.supersession.action === "merged" && r.supersession.mergedInto) {
          text += ` (merged into ${r.supersession.mergedInto})`;
        } else if (r.supersession.action === "duplicate" && r.supersession.mergedInto) {
          text += ` (duplicate of ${r.supersession.mergedInto})`;
        }
      }
      return {
        content: [{ type: "text" as const, text }],
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
        recencyAlpha: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("relevance↔recency blend 0..1 (default 0.5). 1 = pure similarity (recency off, exact prior behavior); 0 = pure recency"),
        recencyHalfLifeDays: z
          .number()
          .positive()
          .optional()
          .describe("exponential recency half-life in days (default 90)"),
        asOf: z
          .union([z.string(), z.number()])
          .optional()
          .describe("temporal scope: ISO-8601 string or epoch ms. Anchors BOTH which claims are valid and the recency term; default now"),
        explain: z
          .boolean()
          .optional()
          .describe("when true, also return a RecallTrace explaining why each candidate claim was served/merged/deprecated/dropped; best-effort, never changes the served result (default false)"),
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
            score: z.number().describe("blended ranking score against the query (similarity·alpha + recency·(1-alpha); pure similarity when recencyAlpha=1)"),
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
        trace: z
          .any()
          .optional()
          .describe("RecallTrace: per-stage counts + per-claim dispositions; present only when explain=true and re-derivation succeeded"),
      },
    },
    async (a) => {
      const resolvedCorpus = a.corpus ?? defaultCorpus;

      // Embeddings lazy: first recall pays the init cost; boot stays instant.
      // RecallDeps includes keyCardinality from config loaded at startup.
      const embeddings = await initEmbeddings();
      const recallArgs = {
        about: a.about,
        subject: a.subject,
        key: a.key,
        maxTokens: a.maxTokens,
        limit: a.limit,
        corpus: resolvedCorpus,
        abstainBelowTop: a.abstainBelowTop,
        relevanceFloor: a.relevanceFloor,
        recencyAlpha: a.recencyAlpha,
        recencyHalfLifeDays: a.recencyHalfLifeDays,
        asOf: a.asOf,
      };
      const r = await recall(session, recallArgs, { embeddings, keyCardinality });

      let trace: RecallTrace | undefined;
      if (a.explain) {
        try {
          trace = await explainRecall(session, recallArgs, { embeddings, keyCardinality });
        } catch (err) {
          // Best-effort: an explain failure never fails the recall.
          console.error(`[mneme/recall] explain failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Append recall-log entry (best-effort, synchronous, never throws into handler).
      appendRecallLog(dbPath, {
        ts: new Date().toISOString(),
        corpus: resolvedCorpus,
        about: a.about,
        topScore: r.topScore,
        matchCount: r.matches.length,
        abstained: r.abstained,
        rankFn: r.rankFn,
        // Observation-only enrichment (window-safe): all sourced from the
        // RecallResult the handler already holds — no new computation, no
        // effect on served results.
        missingCount: r.coverage.missing.length,
        missing: r.coverage.missing,
        warningCount: r.warnings?.length ?? 0,
        subject: a.subject,
        key: a.key,
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
      let text = `# Recall: ${a.about}\n\n${r.content || "(no composed context)"}\n\n## Top matches\n${matchLines || "(none)"}`;
      if (r.warnings?.length) {
        text += "\n\n## ⚠ Warnings\n" + r.warnings.map((w) => "- " + w).join("\n");
      }
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
          trace,
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
      }, { embeddings, keyCardinality });

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

  server.registerTool(
    "subject_census",
    {
      title: "Subject census",
      description:
        "Census the distinct subjects in a corpus, score all subject-pairs for similarity, and surface near-duplicate candidates. Advisory only — use reconcile to canonicalize subjects at ingest time.",
      inputSchema: {
        corpus: z.string().optional().describe(`corpus to census; defaults to '${defaultCorpus}'`),
        limit: z.number().int().positive().optional().describe("max subject-pair candidates to return (default 20)"),
      },
      // Pure read: no state change, repeatable.
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      outputSchema: {
        corpus: z.string(),
        subjects: z.array(z.object({ subject: z.string(), claims: z.number() })).describe("distinct live subjects with per-subject claim counts"),
        candidates: z.array(z.object({ a: z.string(), b: z.string(), score: z.number() })).describe("top subject-pair similarity candidates sorted descending, truncated to limit"),
        rankFn: z.string().describe("similarity function used for subject-pair scoring"),
        warnings: z.array(z.string()).describe("non-fatal warnings from alias loading or subject-pair scoring"),
        content: z.string().describe("composed human-readable census report (advisory only)"),
      },
    },
    async (a) => {
      const resolvedCorpus = a.corpus ?? defaultCorpus;

      // Embeddings lazy: first census pays the init cost; boot stays instant.
      const embeddings = await initEmbeddings();
      const r = await subjectCensus(session, {
        corpus: resolvedCorpus,
        limit: a.limit,
      }, { embeddings, keyCardinality });

      // Surface warnings to stderr (house convention: tools stay pure; server does I/O).
      if (r.warnings.length > 0) {
        for (const w of r.warnings) {
          console.error(`[mneme/subject_census] ${w}`);
        }
      }

      return {
        content: [{ type: "text" as const, text: r.content || "(empty corpus — no subjects found)" }],
        structuredContent: {
          corpus: r.corpus,
          subjects: r.subjects,
          candidates: r.candidates,
          rankFn: r.rankFn,
          warnings: r.warnings,
          content: r.content,
        },
      };
    },
  );

  server.registerTool(
    "reconcile",
    {
      title: "Reconcile candidate subjects/keys",
      description:
        "Score candidate subjects and/or keys against the corpus's live distinct entities and assign a reuse/uncertain/new disposition per thresholds. Never writes — use before remember to canonicalize entities and avoid fragmenting claims.",
      inputSchema: {
        corpus: z.string().optional().describe(`corpus to reconcile against; defaults to '${defaultCorpus}'`),
        subjects: z.array(z.string()).optional().describe("candidate subjects to score against existing subjects"),
        keys: z.array(z.string()).optional().describe("candidate keys to score against existing keys"),
        limit: z.number().int().positive().optional().describe("max suggestions per candidate (default 5)"),
        reuseThreshold: z.number().min(0).max(1).optional().describe("score >= this → 'reuse' (default 0.9, provisional, not calibrated)"),
        newThreshold: z.number().min(0).max(1).optional().describe("score <= this → 'new' (default 0.5)"),
      },
      // Pure read: no state change, repeatable.
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      outputSchema: {
        corpus: z.string(),
        subjects: z.array(
          z.object({
            candidate: z.string(),
            suggestions: z.array(z.object({ existing: z.string(), score: z.number() })),
            disposition: z.enum(["reuse", "uncertain", "new"]),
          }),
        ).describe("per-candidate-subject scored suggestions and disposition"),
        keys: z.array(
          z.object({
            candidate: z.string(),
            suggestions: z.array(z.object({ existing: z.string(), score: z.number() })),
            disposition: z.enum(["reuse", "uncertain", "new"]),
          }),
        ).describe("per-candidate-key scored suggestions and disposition"),
        rankFn: z.string().describe("similarity function used for scoring"),
        warnings: z.array(z.string()).describe("non-fatal warnings from alias loading or scoring"),
        content: z.string().describe("composed human-readable reconcile report"),
      },
    },
    async (a) => {
      const resolvedCorpus = a.corpus ?? defaultCorpus;

      // Embeddings lazy: first reconcile pays the init cost; boot stays instant.
      const embeddings = await initEmbeddings();
      const r = await reconcile(session, {
        corpus: resolvedCorpus,
        subjects: a.subjects,
        keys: a.keys,
        limit: a.limit,
        reuseThreshold: a.reuseThreshold,
        newThreshold: a.newThreshold,
      }, { embeddings, keyCardinality });

      // Surface warnings to stderr (house convention: tools stay pure; server does I/O).
      if (r.warnings.length > 0) {
        for (const w of r.warnings) {
          console.error(`[mneme/reconcile] ${w}`);
        }
      }

      return {
        content: [{ type: "text" as const, text: r.content || "(no candidates given)" }],
        structuredContent: {
          corpus: r.corpus,
          subjects: r.subjects,
          keys: r.keys,
          rankFn: r.rankFn,
          warnings: r.warnings,
          content: r.content,
        },
      };
    },
  );

  server.registerTool(
    "declare_cardinality",
    {
      title: "Declare key cardinality",
      description:
        "Declare which keys hold multiple coexisting values ('multi') vs a single latest value ('single'). " +
        "Use after a recall/key_census cardinality warning to stop a single-cardinality key from silently " +
        "deprecating distinct facts. Merges into any existing declaration; never touches stored claims.",
      inputSchema: {
        corpus: z.string().optional().describe(`corpus to declare on; defaults to '${defaultCorpus}'`),
        cardinality: z.record(z.string(), z.enum(["single", "multi"]))
          .describe("per-key cardinality map, e.g. { requirement: 'multi', status: 'single' }"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: {
        corpus: z.string(),
        keyCardinality: z.record(z.string()).describe("the effective per-key cardinality after the merge"),
      },
    },
    async (a) => {
      const resolvedCorpus = a.corpus ?? defaultCorpus;
      const declared = session.declareCardinality(resolvedCorpus, a.cardinality);
      return {
        content: [{ type: "text" as const, text: `declared on '${resolvedCorpus}': ${JSON.stringify(declared)}` }],
        structuredContent: { corpus: resolvedCorpus, keyCardinality: declared },
      };
    },
  );

  server.registerTool(
    "audit",
    {
      title: "Audit a corpus for canonicalization opportunities",
      description:
        "Whole-corpus maintenance pass: composes key_census, subject_census, and single-cardinality collisions into one ranked list of proposed canonicalizations " +
        "(key aliases, subject fragmentation, cardinality declarations). PROPOSE ONLY — never applies anything; review each suggestedAction and apply it explicitly " +
        "(e.g. declare_cardinality) to confirm.",
      inputSchema: {
        corpus: z.string().optional().describe(`corpus to audit; defaults to '${defaultCorpus}'`),
        limit: z.number().int().positive().optional().describe("max candidates per underlying census to consider (default 20)"),
      },
      // Pure read: no state change, repeatable. Charter I3 — propose-then-confirm,
      // never auto-applied.
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      outputSchema: {
        corpus: z.string(),
        proposals: z.array(
          z.object({
            kind: z.enum(["key-alias", "subject-fragmentation", "cardinality-declare"]),
            entities: z.array(z.string()).describe("key pair / subject pair / [subject, key], depending on kind"),
            score: z.number().optional().describe("similarity score for alias/fragmentation proposals"),
            claimsAffected: z.number().describe("ranking signal — claims touched by this proposal"),
            suggestedAction: z.string().describe("ready-to-apply action string — never auto-run by audit itself"),
            detail: z.string(),
          }),
        ).describe("ranked proposed canonicalizations, desc by claimsAffected then score"),
        rankFn: z.string().describe("similarity function used for scoring"),
        warnings: z.array(z.string()).describe("non-fatal warnings from alias loading or key/subject-pair scoring"),
        content: z.string().describe("composed human-readable maintenance report"),
      },
    },
    async (a) => {
      const resolvedCorpus = a.corpus ?? defaultCorpus;

      // Embeddings lazy: first audit pays the init cost; boot stays instant.
      const embeddings = await initEmbeddings();
      const r = await audit(session, {
        corpus: resolvedCorpus,
        limit: a.limit,
      }, { embeddings, keyCardinality });

      // Surface warnings to stderr (house convention: tools stay pure; server does I/O).
      if (r.warnings.length > 0) {
        for (const w of r.warnings) {
          console.error(`[mneme/audit] ${w}`);
        }
      }

      return {
        content: [{ type: "text" as const, text: r.content || "(empty corpus — no proposals)" }],
        structuredContent: {
          corpus: r.corpus,
          proposals: r.proposals,
          rankFn: r.rankFn,
          warnings: r.warnings,
          content: r.content,
        },
      };
    },
  );

  server.registerTool(
    "history",
    {
      title: "Lineage of a (subject,key)",
      description:
        "Return the full non-destructive lineage of one (subject,key): every committed version (served, deprecated, merged, tau-invalid) " +
        "tagged with its disposition and reason as of the given time. Use to see what changed and why, not just the latest served value.",
      inputSchema: {
        corpus: z.string().optional().describe(`corpus to read; defaults to '${defaultCorpus}'`),
        subject: z.string().describe("the subject to trace"),
        key: z.string().describe("the key to trace"),
        asOf: z
          .union([z.string(), z.number()])
          .optional()
          .describe("temporal scope: ISO-8601 string or epoch ms; default now"),
      },
      // Pure read: no state change, repeatable.
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      outputSchema: {
        corpus: z.string(),
        subject: z.string(),
        key: z.string(),
        asOf: z.number(),
        entries: z.array(
          z.object({
            id: z.string(),
            value: z.any().describe("the claim value (any JSON)"),
            confidence: z.number().describe("point estimate of the claim's confidence, 0..1"),
            valid: z.object({ from: z.number(), to: z.number() }),
            recordedSeq: z.number(),
            tags: z.array(z.string()),
            disposition: z.enum(["served", "deprecated", "merged", "tau-invalid"]),
            reason: z.any().describe("vocabulary-aligned disposition reason"),
          }),
        ).describe("every committed version of this (subject,key), oldest to newest"),
        content: z.string().describe("composed human-readable lineage report"),
      },
    },
    async (a) => {
      const r = lineageOf(session, {
        corpus: a.corpus ?? defaultCorpus,
        subject: a.subject,
        key: a.key,
        asOf: a.asOf,
      });
      return {
        content: [{ type: "text" as const, text: r.content || "(no lineage found)" }],
        structuredContent: {
          corpus: r.corpus,
          subject: r.subject,
          key: r.key,
          asOf: r.asOf,
          entries: r.entries,
          content: r.content,
        },
      };
    },
  );

  server.registerTool(
    "inspect",
    {
      title: "Inspect a raw claim",
      description:
        "Return the raw stored fields of one claim by id — subject, key, value, confidence, validity, provenance. Use for low-level " +
        "debugging/auditing when history's lineage view isn't specific enough.",
      inputSchema: {
        corpus: z.string().optional().describe(`corpus to read; defaults to '${defaultCorpus}'`),
        claimId: z.string().describe("the claim id to inspect"),
      },
      // Pure read: no state change, repeatable.
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      outputSchema: {
        found: z.boolean(),
        claimId: z.string().optional().describe("present when found=false: the id that was looked up"),
        id: z.string().optional(),
        subject: z.string().optional(),
        key: z.string().optional(),
        value: z.any().optional().describe("the claim value (any JSON)"),
        confidence: z.number().optional().describe("point estimate of the claim's confidence, 0..1"),
        valid: z.object({ from: z.number(), to: z.number() }).optional(),
        recordedSeq: z.number().optional(),
        source: z.string().optional(),
        tags: z.array(z.string()).optional(),
        status: z.string().optional(),
      },
    },
    async (a) => {
      const resolvedCorpus = a.corpus ?? defaultCorpus;
      const claim = session.inspect(resolvedCorpus, a.claimId);
      if (!claim) {
        return {
          content: [{ type: "text" as const, text: `no claim found for id '${a.claimId}' in corpus '${resolvedCorpus}'` }],
          structuredContent: { found: false, claimId: a.claimId },
        };
      }
      const structuredContent = {
        found: true,
        id: claim.id,
        subject: claim.subject,
        key: claim.key,
        value: claim.value,
        confidence: pointEstimate(claim.confidence),
        valid: { from: claim.valid.from, to: claim.valid.to },
        recordedSeq: claim.recordedSeq,
        source: claim.source,
        tags: [...claim.tags],
        status: claim.status,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
        structuredContent,
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
