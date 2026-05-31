import { createMneme, createSqliteAdapter } from "../index.js";
import type { CorpusDef, CandidateClaim, Confidence, BatchResult } from "../index.js";
import { scalarConfidence } from "../core/confidence.js";
import { parseDsl, normalizeDsl } from "./dsl.js";
import { loadCorpora, saveCorpora, ensureDir } from "./corpus-store.js";
import { SURFACE_DEFAULTS, defaultConfidence } from "./types.js";
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
  const defs: CorpusDef[] = loadCorpora(dbPath);
  for (const d of defs) mneme.createCorpus(d);

  // Track schema version per corpus so write() can build "corpusId@version".
  const versionOf = new Map<string, string>(defs.map((d) => [d.id, d.schema.version]));

  function toConfidence(c: WriteRecord["confidence"]): Confidence {
    if (c == null) return defaultConfidence();
    if (typeof c === "number") {
      return scalarConfidence(c);
    }
    return c;
  }

  function buildCandidate(corpusId: string, rec: WriteRecord): CandidateClaim {
    return {
      profile: (opts.profile ?? SURFACE_DEFAULTS.profile) as never,
      workspace: (opts.workspace ?? corpusId) as never,
      subject: rec.subject as never,
      key: rec.key as never,
      scope: rec.scope ?? {},
      value: rec.value,
      confidence: toConfidence(rec.confidence),
      valid: rec.valid ?? SURFACE_DEFAULTS.validInterval,
      source: rec.source ?? opts.source ?? SURFACE_DEFAULTS.source,
      provenance: {},
      evidence: [],
      tags: rec.tags ?? [],
      schema: `${corpusId}@${versionOf.get(corpusId) ?? SURFACE_DEFAULTS.schemaVersion}`,
      status: rec.status,
    };
  }

  const session: Session = {
    mneme,

    createCorpus(spec: CorpusSpec): void {
      const version = spec.schemaVersion ?? SURFACE_DEFAULTS.schemaVersion;
      const def: CorpusDef = {
        id: spec.id,
        displayName: spec.displayName ?? spec.id,
        schema: {
          version,
          subjects: spec.subjects ?? [],
          // CorpusSpec.scopeFields is Record<string, unknown>; ClaimSchema.scopeFields is
          // Record<string, "string">. Cast via unknown to satisfy both: the surface layer
          // only accepts valid string-typed scope field descriptors anyway.
          scopeFields: (spec.scopeFields ?? {}) as Record<string, "string">,
          required: [],
          scalarPseudocount: {},
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
      saveCorpora(dbPath, mneme.listCorpora());
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
