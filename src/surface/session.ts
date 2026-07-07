import { createMneme, createSqliteAdapter } from "../index.js";
import type { CorpusDef, BatchResult } from "../index.js";
import { validateKeyCardinality } from "../catalog/schema.js";
import { parseDsl, normalizeDsl } from "./dsl.js";
import { loadCorpora, saveCorpora, ensureDir } from "./corpus-store.js";
import { SURFACE_DEFAULTS, DEFAULT_SCALAR_PSEUDOCOUNT, corpusDefFromSpec } from "./types.js";
import { buildCandidateClaim } from "./candidate.js";
import type {
  Session,
  SessionOptions,
  WriteRecord,
  WriteOutcome,
  ImportStats,
  CorpusSpec,
  QueryResult,
} from "./types.js";

export function openSession(opts: SessionOptions = {}): Session {
  const dbPath = opts.dbPath ?? SURFACE_DEFAULTS.dbPath;
  const writer = opts.writer ?? SURFACE_DEFAULTS.writer;
  ensureDir(dbPath);
  const adapter = createSqliteAdapter(dbPath);
  const mneme = createMneme({ adapter, availableTiers: [{ kind: "core" }] });

  // Re-register any corpora persisted from a previous session.
  // Repair any defs carrying the C7 bug signature (absent-OR-empty scalarPseudocount).
  const defs: CorpusDef[] = loadCorpora(dbPath);
  let repaired = false;
  for (const d of defs) {
    const pc = d.schema.scalarPseudocount;
    if (pc == null || Object.keys(pc).length === 0) {
      // C7 bug signature: surface used to persist {} (and older sidecars may lack
      // the field). Post-task-1, createCorpus always persists a complete map, so
      // this predicate stays forever-unambiguous.
      d.schema.scalarPseudocount = { ...DEFAULT_SCALAR_PSEUDOCOUNT };
      console.error(
        `${dbPath}.corpora.json: backfilled scalarPseudocount for '${d.id}' (C7 repair, A.1 defaults)`
      );
      repaired = true;
    }
    mneme.createCorpus(d);
  }
  if (repaired) saveCorpora(dbPath, mneme.listCorpora());

  // Track schema version per corpus so write() can build "corpusId@version".
  const versionOf = new Map<string, string>(defs.map((d) => [d.id, d.schema.version]));

  function buildCandidate(corpusId: string, rec: WriteRecord) {
    return buildCandidateClaim(rec, {
      corpusId,
      schemaVersion: versionOf.get(corpusId) ?? SURFACE_DEFAULTS.schemaVersion,
      profile: opts.profile,
      workspace: opts.workspace,
      source: opts.source,
    });
  }

  const session: Session = {
    mneme,

    createCorpus(spec: CorpusSpec): void {
      const def = corpusDefFromSpec(spec);
      mneme.createCorpus(def);
      versionOf.set(spec.id, def.schema.version);
      saveCorpora(dbPath, mneme.listCorpora());
    },

    declareCardinality(corpusId, cardinality) {
      validateKeyCardinality(cardinality);
      const existing = mneme.listCorpora((c) => c.id === corpusId)[0] as CorpusDef | undefined;
      if (!existing) {
        session.createCorpus({ id: corpusId, keyCardinality: cardinality });
        return { ...cardinality };
      }
      const merged = { ...(existing.schema.keyCardinality ?? {}), ...cardinality };
      // Overwrite the DEF only (Catalog.createCorpus is corpora.set) — claims are stored
      // separately in the adapter and are NOT touched.
      mneme.createCorpus({ ...existing, schema: { ...existing.schema, keyCardinality: merged } });
      saveCorpora(dbPath, mneme.listCorpora());
      return merged;
    },

    write(corpusId: string, rec: WriteRecord): WriteOutcome {
      const candidate = buildCandidate(corpusId, rec);
      const result = mneme.commit(corpusId, candidate, { writer });
      return result as WriteOutcome;
    },

    writeMany(
      corpusId: string,
      recs: Iterable<WriteRecord>,
      _opts?: { batchSize?: number }
    ): ImportStats {
      const start = Date.now();
      const recsArray = Array.from(recs);
      const claims = recsArray.map((rec) => buildCandidate(corpusId, rec));

      const batchResult: BatchResult = mneme.commitBatch(corpusId, claims, { writer });

      let committed = 0;
      let rejected = 0;
      let duplicate = 0;
      let skipped = 0;

      for (const r of batchResult.results) {
        if (r.status === "committed") committed++;
        else if (r.status === "rejected") rejected++;
        else if (r.status === "duplicate") duplicate++;
        else skipped++; // "error" maps to skipped
      }

      const total = recsArray.length;
      const elapsedMs = Date.now() - start;
      const claimsPerSec = elapsedMs > 0 ? (total / elapsedMs) * 1000 : 0;

      return { total, committed, rejected, duplicate, skipped, elapsedMs, claimsPerSec };
    },

    q(corpusId: string, dsl: string): QueryResult {
      // Auto-promote: if the DSL uses a kappa (as …) stage but has no preceding
      // rank (rho) stage, the pipeline would present a Corpus where RankedCorpus
      // is expected. Inject `rank exact ""` just before the first `as` clause so
      // callers can write simple `where … | as text N` pipelines without needing
      // to understand the Corpus→RankedCorpus type boundary.
      const normalized = normalizeDsl(dsl);
      const pipeline = parseDsl(corpusId, normalized);
      return mneme.query<QueryResult>(corpusId, pipeline);
    },

    listCorpora(): { id: string; displayName: string }[] {
      return mneme.listCorpora().map((c) => ({ id: c.id, displayName: c.displayName }));
    },

    inspectCorpus(corpusId: string): unknown {
      return mneme.listCorpora((c) => c.id === corpusId)[0];
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
      // Sidecar is already flushed on createCorpus; release the DB file handle
      // so the underlying file can be reopened/removed (notably on Windows).
      adapter.close?.();
    },
  };

  return session;
}
