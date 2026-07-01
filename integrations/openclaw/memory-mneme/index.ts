/**
 * OpenClaw "memory" plugin backed by mneme's typed-claim algebra.
 *
 * Wiring only: config resolution, one mneme engine per register() call, the four
 * MCP-shaped tools, and the before_agent_start auto-recall hook. Pure logic
 * (context envelope, scope overlay) lives in ./format.js. Writes are explicit —
 * there is no agent_end hook here.
 */
import { Type } from "@sinclair/typebox";
import { homedir } from "node:os";
import { join } from "node:path";
import { openMnemeEngine, remember, recall, listCorpora, keyCensus } from "mneme/mcp";
import { wrapMemories, mergeScope, coverageNote, provenanceFooter } from "./format.js";

const LOG_PREFIX = "[memory-mneme]";

interface MnemeMemoryConfig {
  dbPath: string;
  corpus: string;
  autoRecall: boolean;
  recallLimit: number;
  relevanceFloor: number;
  defaultScope?: Record<string, string>;
}

export function resolveConfig(raw: any): MnemeMemoryConfig {
  const v = raw ?? {};
  return {
    dbPath: v.dbPath ?? process.env.MNEME_DB ?? join(homedir(), ".mneme/knowledge.db"),
    corpus: v.corpus ?? process.env.MNEME_CORPUS ?? "openclaw",
    autoRecall: v.autoRecall !== false,
    recallLimit: v.recallLimit ?? 5,
    relevanceFloor: v.relevanceFloor ?? 0,
    defaultScope: v.defaultScope,
  };
}

/** House convention (src/mcp/server.ts): tools stay pure, the caller does I/O — log
 *  each non-fatal recall/keyCensus warning to stderr, prefixed like the registration line. */
function logWarnings(warnings?: string[]): void {
  if (!warnings?.length) return;
  for (const w of warnings) {
    console.error(`${LOG_PREFIX} ${w}`);
  }
}

export default {
  id: "memory-mneme",
  name: "Mneme Memory",
  kind: "memory" as const,

  register(api: any) {
    const cfg = resolveConfig(api.pluginConfig);
    const engine = openMnemeEngine({ dbPath: cfg.dbPath, corpus: cfg.corpus, writer: "openclaw" });
    const deps = async () => ({
      embeddings: await engine.initEmbeddings(),
      keyCardinality: engine.keyCardinality,
    });

    api.registerTool(
      {
        name: "memory_recall",
        parameters: Type.Object({
          about: Type.String(),
          subject: Type.Optional(Type.String()),
          key: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Number()),
          relevanceFloor: Type.Optional(Type.Number()),
        }),
        async execute(_id: string, p: any) {
          const r = await recall(
            engine.session,
            {
              about: p.about,
              corpus: cfg.corpus,
              subject: p.subject,
              key: p.key,
              limit: p.limit ?? cfg.recallLimit,
              relevanceFloor: p.relevanceFloor ?? cfg.relevanceFloor,
            },
            await deps(),
          );
          logWarnings(r.warnings);
          const base = r.content || `No relevant memories for "${p.about}"`;
          const text = `${base}${provenanceFooter(r.matches)}${coverageNote(r.coverage?.missing)}`;
          return {
            content: [{ type: "text" as const, text }],
          };
        },
      },
      { name: "memory_recall" },
    );

    api.registerTool(
      {
        name: "memory_remember",
        parameters: Type.Object({
          subject: Type.String(),
          key: Type.String(),
          value: Type.String(),
          confidence: Type.Optional(Type.Number()),
          tags: Type.Optional(Type.Array(Type.String())),
          scope: Type.Optional(Type.Record(Type.String(), Type.String())),
          validFrom: Type.Optional(Type.String()),
        }),
        async execute(_id: string, p: any) {
          const r = remember(engine.session, {
            subject: p.subject,
            key: p.key,
            value: p.value,
            corpus: cfg.corpus,
            confidence: p.confidence,
            tags: p.tags,
            scope: mergeScope(cfg.defaultScope, p.scope),
            validFrom: p.validFrom,
          });
          return { content: [{ type: "text" as const, text: `${r.status} ${r.id}` }] };
        },
      },
      { name: "memory_remember" },
    );

    api.registerTool(
      {
        name: "memory_key_census",
        parameters: Type.Object({ limit: Type.Optional(Type.Number()) }),
        async execute(_id: string, p: any) {
          const r = await keyCensus(engine.session, { corpus: cfg.corpus, limit: p.limit }, await deps());
          logWarnings(r.warnings);
          return {
            content: [
              { type: "text" as const, text: r.content || `No keys recorded yet in corpus "${cfg.corpus}"` },
            ],
          };
        },
      },
      { name: "memory_key_census" },
    );

    api.registerTool(
      {
        name: "memory_corpora",
        parameters: Type.Object({}),
        async execute(_id: string, _p: any) {
          const r = listCorpora(engine.session);
          const text =
            r.corpora.length > 0
              ? r.corpora.map((c) => `${c.id} (${c.displayName})`).join("\n")
              : "No corpora registered yet";
          return { content: [{ type: "text" as const, text }] };
        },
      },
      { name: "memory_corpora" },
    );

    // Explicit typed-claim writes only — no agent_end hook here.
    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event: any) => {
        const prompt = event.prompt ?? "";
        if (!prompt.trim()) return;
        const r = await recall(
          engine.session,
          { about: prompt, corpus: cfg.corpus, limit: cfg.recallLimit, relevanceFloor: cfg.relevanceFloor },
          await deps(),
        );
        logWarnings(r.warnings);
        const block = wrapMemories(r.content);
        if (!block) return;
        return { prependContext: `${block}${coverageNote(r.coverage?.missing)}` };
      });
    }

    console.error(`${LOG_PREFIX} registered (autoRecall=${cfg.autoRecall}, corpus=${cfg.corpus})`);
  },
};
