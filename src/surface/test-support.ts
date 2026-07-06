/**
 * Shared test fixtures for src/mcp/ tests.
 *
 * freshSession():      opens a throw-away SQLite session in a tmp dir.
 * jaccardDeps:         RecallDeps wrapping EmbeddingState with rankFn="jaccard"
 *                      (no adapter, no cache).
 * makeFakeHybridDeps(): builds a fake RecallDeps with rankFn="hybrid" by
 *                       running initEmbeddings with a deterministic fake adapter
 *                       factory. Each call uses a unique adapter id so the global
 *                       embedding-adapter registry does not collide across invocations.
 *
 * Strategy for makeFakeHybridDeps: delegate to initEmbeddings so that the
 * similarity registry ("cosine", "hybrid") is populated exactly the same way the
 * production server does it. The returned state.adapter / state.cache are the
 * objects whose closure cosineOver holds, so warmValues(adapter, cache, ...) will
 * correctly populate the cache that the registered fn reads.
 *
 * Stale-closure note (documented-intentional): after the first successful
 * initEmbeddings call the "cosine" / "hybrid" slots are locked to that first
 * adapter's cache. Tests that need independent warm-up should call
 * _resetEmbeddingsForTest() between invocations (as the embeddings.test.ts does).
 * For the recall tests the stale closure is harmless — every test that exercises
 * the hybrid path calls makeFakeHybridDeps() once per test, and the warm-up
 * populates the correct cache.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "./session.js";
import { createMneme, createSqliteAdapter } from "../index.js";
import type { CorpusDef } from "../index.js";
import { validateKeyCardinality } from "../catalog/schema.js";
import { parseDsl, normalizeDsl } from "./dsl.js";
import { SURFACE_DEFAULTS, DEFAULT_SCALAR_PSEUDOCOUNT } from "./types.js";
import { buildCandidateClaim } from "./candidate.js";
import type {
  Session,
  WriteRecord,
  WriteOutcome,
  ImportStats,
  CorpusSpec,
  QueryResult,
} from "./types.js";
import type { StorageAdapter } from "../adapters/adapter.js";
import type { ExecutionPlan, AdapterScope } from "../adapters/adapter-types.js";
import type { Claim } from "../core/claim.js";
import type { RecallDeps } from "./recall.js";
import { initEmbeddings } from "./embeddings.js";
import type { EmbeddingAdapter } from "../algebra/embedding.js";

export function freshSession(): Session {
  const db = join(mkdtempSync(join(tmpdir(), "mneme-mcp-")), "store.db");
  return openSession({ dbPath: db, writer: "test" });
}

/** Jaccard-only deps — no warm-up needed, no adapter/cache. */
export const jaccardDeps: RecallDeps = { embeddings: { rankFn: "jaccard" } };

let _fakeAdapterSeq = 0;

/**
 * Build a deterministic fake RecallDeps with rankFn="hybrid".
 *
 * Uses initEmbeddings with a fake factory that returns a constant [0.5, 0.5]
 * vector for every text. Each call generates a new unique adapter id to avoid
 * the global adapter-registry collision (same-id, different-object → throws).
 *
 * Returns RecallDeps wrapping the EmbeddingState produced by initEmbeddings
 * (rankFn="hybrid", adapter, cache all set). The adapter+cache in the wrapped
 * state are the SAME objects closed over by the registered "cosine"/"hybrid"
 * similarity fns (on the first call; subsequent calls may reuse the same fns
 * due to registerIfAbsent — see stale-closure note above).
 */
export async function makeFakeHybridDeps(): Promise<RecallDeps> {
  const id = `fake-hybrid-adapter-${++_fakeAdapterSeq}`;
  const adapter: EmbeddingAdapter = {
    id,
    version: "v1",
    dim: 2,
    embed: async (texts) => texts.map(() => [0.5, 0.5]),
  };
  const embeddings = await initEmbeddings(async () => adapter);
  return { embeddings };
}

// ── makeSpySession — the ONE spy-session helper (downstream pushdown tasks import this) ──
//
// `openSession` hardcodes its own adapter (createSqliteAdapter(dbPath) + file-backed
// corpus persistence), so there is no seam to observe the ExecutionPlan an adapter
// actually receives. This helper hand-builds a Session over
// `createMneme({ adapter: spyWrap(createSqliteAdapter(":memory:")), availableTiers })`,
// mirroring `openSession`'s write/createCorpus/etc logic (minus file persistence, since
// the underlying store is ephemeral in-memory sqlite) so callers get a fully-functional
// Session — remember()/ensureCorpus() and friends work unchanged against it.

export interface SpySession {
  session: Session;
  /** Every ExecutionPlan the wrapped adapter saw, in call order (post-transformPlan). */
  plansSeen: ExecutionPlan[];
  /** Total rows returned by plans matching the filter (default: all plans). */
  rowsHydrated(match?: (p: ExecutionPlan) => boolean): number;
}

interface SpyState {
  plansSeen: ExecutionPlan[];
  rowCounts: number[];
}

function spyWrap(
  base: StorageAdapter,
  state: SpyState,
  transformPlan?: (p: ExecutionPlan) => ExecutionPlan,
): StorageAdapter {
  return {
    ...base,
    query(plan: ExecutionPlan): Claim[] {
      const effective = transformPlan ? transformPlan(plan) : plan;
      const rows = base.query(effective);
      state.plansSeen.push(effective);
      state.rowCounts.push(rows.length);
      return rows;
    },
    scoped(scope: AdapterScope): StorageAdapter {
      return spyWrap(base.scoped!(scope), state, transformPlan);
    },
  };
}

/**
 * Session over `createMneme({ adapter: spyWrap(createSqliteAdapter(":memory:")),
 * availableTiers })`. `opts.transformPlan` rewrites each plan BEFORE execution — pass
 * `(p) => ({ corpusId: p.corpusId })` to strip hints (the differential's hints-off arm).
 */
export function makeSpySession(opts?: {
  transformPlan?: (p: ExecutionPlan) => ExecutionPlan;
}): SpySession {
  const state: SpyState = { plansSeen: [], rowCounts: [] };
  const base = createSqliteAdapter(":memory:");
  const adapter = spyWrap(base, state, opts?.transformPlan);
  const mneme = createMneme({ adapter, availableTiers: [{ kind: "core" }] });

  const versionOf = new Map<string, string>();

  function buildCandidate(corpusId: string, rec: WriteRecord) {
    return buildCandidateClaim(rec, {
      corpusId,
      schemaVersion: versionOf.get(corpusId) ?? SURFACE_DEFAULTS.schemaVersion,
      profile: "test",
    });
  }

  const session: Session = {
    mneme,

    createCorpus(spec: CorpusSpec): void {
      if (spec.keyCardinality) validateKeyCardinality(spec.keyCardinality);
      const version = spec.schemaVersion ?? SURFACE_DEFAULTS.schemaVersion;
      const def: CorpusDef = {
        id: spec.id,
        displayName: spec.displayName ?? spec.id,
        schema: {
          version,
          subjects: spec.subjects ?? [],
          scopeFields: (spec.scopeFields ?? {}) as Record<string, "string">,
          required: [],
          scalarPseudocount: { ...DEFAULT_SCALAR_PSEUDOCOUNT, ...(spec.scalarPseudocount ?? {}) },
          ...(spec.keyCardinality ? { keyCardinality: spec.keyCardinality } : {}),
        },
        defaults: {
          decayPolicy: { kind: "none" },
          confidenceThreshold: 0,
          contradictionPolicy: spec.contradictionPolicy ?? { kind: "always_accept" },
          defaultStatus: ["validated"],
        },
        requiredTiers: [{ kind: "core" }],
        metadata: {},
        createdAt: 0,
        updatedAt: 0,
      };
      mneme.createCorpus(def);
      versionOf.set(spec.id, version);
    },

    declareCardinality(corpusId, cardinality) {
      validateKeyCardinality(cardinality);
      const existing = mneme.listCorpora((c) => c.id === corpusId)[0] as CorpusDef | undefined;
      if (!existing) {
        session.createCorpus({ id: corpusId, keyCardinality: cardinality });
        return { ...cardinality };
      }
      const merged = { ...(existing.schema.keyCardinality ?? {}), ...cardinality };
      mneme.createCorpus({ ...existing, schema: { ...existing.schema, keyCardinality: merged } });
      return merged;
    },

    write(corpusId: string, rec: WriteRecord): WriteOutcome {
      const candidate = buildCandidate(corpusId, rec);
      const result = mneme.commit(corpusId, candidate, { writer: "test" });
      return result as WriteOutcome;
    },

    writeMany(
      corpusId: string,
      recs: Iterable<WriteRecord>,
      _opts?: { batchSize?: number },
    ): ImportStats {
      const start = Date.now();
      const recsArray = Array.from(recs);
      const claims = recsArray.map((rec) => buildCandidate(corpusId, rec));

      const batchResult = mneme.commitBatch(corpusId, claims, { writer: "test" });

      let committed = 0;
      let rejected = 0;
      let duplicate = 0;
      let skipped = 0;

      for (const r of batchResult.results) {
        if (r.status === "committed") committed++;
        else if (r.status === "rejected") rejected++;
        else if (r.status === "duplicate") duplicate++;
        else skipped++;
      }

      const total = recsArray.length;
      const elapsedMs = Date.now() - start;
      const claimsPerSec = elapsedMs > 0 ? (total / elapsedMs) * 1000 : 0;

      return { total, committed, rejected, duplicate, skipped, elapsedMs, claimsPerSec };
    },

    listCorpora(): { id: string; displayName: string }[] {
      return mneme.listCorpora().map((c) => ({ id: c.id, displayName: c.displayName }));
    },

    inspectCorpus(corpusId: string): unknown {
      return mneme.listCorpora((c) => c.id === corpusId)[0];
    },

    q(corpusId: string, dsl: string): QueryResult {
      const normalized = normalizeDsl(dsl);
      const pipeline = parseDsl(corpusId, normalized);
      return mneme.query<QueryResult>(corpusId, pipeline);
    },

    inspect(corpusId: string, claimId: string) {
      return mneme.readByIds(corpusId, [claimId as never])[0];
    },

    replay(corpusId: string, claimId: string): { status: string } {
      const c = mneme.readByIds(corpusId, [claimId as never])[0];
      if (!c) return { status: "missing" };
      return { status: mneme.replay(corpusId, c).status };
    },

    close(): void {
      base.close?.();
    },
  };

  return {
    session,
    plansSeen: state.plansSeen,
    rowsHydrated(match?: (p: ExecutionPlan) => boolean): number {
      let total = 0;
      for (let i = 0; i < state.plansSeen.length; i++) {
        if (!match || match(state.plansSeen[i])) total += state.rowCounts[i];
      }
      return total;
    },
  };
}
