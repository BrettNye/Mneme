import type { Source, Status, Claim } from "../core/claim.js";
import type { Value } from "../core/value.js";
import type { Confidence } from "../core/confidence.js";
import type { Scope } from "../core/scope.js";
import type { Interval } from "../core/time.js";
import type { Corpus, RankedCorpus, ComposedContext } from "../algebra/types.js";
import type { AggregateResult } from "../algebra/aggregation.js";
import type { ContradictionPolicy, Corpus as CorpusDef } from "../catalog/corpus.js";
import type { Mneme } from "../mneme.js";
import type { EmbeddingState } from "./recall.js";
import { validateKeyCardinality } from "../catalog/schema.js";

/** Boilerplate-free write input; the session fills the rest of CandidateClaim. */
export interface WriteRecord {
  subject: string;
  key: string;
  value: Value;
  confidence?: number | Confidence; // bare number => scalar p
  scope?: Scope;
  valid?: Interval;
  source?: Source;
  status?: Status;
  tags?: string[];
}

export interface WriteOutcome {
  id: string;
  status: "committed" | "rejected" | "duplicate";
}

export interface ImportStats {
  total: number; committed: number; rejected: number; duplicate: number;
  skipped: number; elapsedMs: number; claimsPerSec: number;
}

/**
 * Per-source pseudocounts for scalar→Beta coercion, from canonical Appendix A.1
 * trust tiers. Spec-authored priors, UNCALIBRATED — the bio efficacy instrument
 * sweeps this dial (flat-2 vs tiered is one config via the CorpusSpec override).
 * An explicit surface declaration: §3.2's no-silent-default MUST stays intact at
 * the substrate (pseudocountFor still throws on missing sources).
 *
 * Sibling A.1 tables — SOURCE_WEIGHT / HALF_LIFE_DAYS — live in
 * src/core/source-trust.ts and are independently calibrated; an A.1 retune
 * touches both files.
 */
export const DEFAULT_SCALAR_PSEUDOCOUNT: Record<Source, number> = {
  manual: 10,
  verification: 10,
  workflow: 5,
  heuristic: 5,
  llm: 2,
  imported: 2,
};

/** Ergonomic corpus creation input; the session expands it to a full CorpusDef. */
export interface CorpusSpec {
  id: string;
  displayName?: string;
  subjects?: string[];
  scopeFields?: Record<string, unknown>;
  schemaVersion?: string;
  /** Corpus default contradiction policy. Defaults to `{ kind: "always_accept" }`. */
  contradictionPolicy?: ContradictionPolicy;
  /** Per-source scalar→Beta pseudocounts; merged over DEFAULT_SCALAR_PSEUDOCOUNT. */
  scalarPseudocount?: Partial<Record<Source, number>>;
  /** Per-key cardinality declaration. Undeclared keys default to "single" (⊥-eligible).
   *  Persisted into ClaimSchema.keyCardinality; honored per-corpus by the read path. */
  keyCardinality?: Record<string, "single" | "multi">;
}

/** Pure CorpusSpec→CorpusDef expansion — the ONE home for corpus-shape defaults.
 *  Throws on invalid scalarPseudocount overrides (finite, >= 0) and bad keyCardinality. */
export function corpusDefFromSpec(spec: CorpusSpec): CorpusDef {
  // Validate override values before merging (principles-audit finding 13):
  // NaN/Infinity survive the undefined-strip but JSON.stringify persists them as
  // null — a non-empty map the backfill can't repair, slipping pseudocountFor's
  // `=== undefined` check; negatives survive round-trip and produce negative α/β.
  // 0 is legal (trust-the-prior-only, well-defined in scalarToBeta).
  for (const [src, v] of Object.entries(spec.scalarPseudocount ?? {})) {
    if (v !== undefined && (!Number.isFinite(v) || v < 0)) {
      throw new Error(
        `invalid scalarPseudocount for source "${src}": ${v} (must be a finite number >= 0)`
      );
    }
  }
  // Strip explicit-undefined entries BEFORE spreading: a naive spread copies
  // `{ llm: undefined }` over the default (re-arming pseudocountFor's throw) and
  // JSON.stringify then drops the key — persisting a 5-key NON-EMPTY map the
  // load-time backfill predicate can never repair. (Spec audit finding 2.5.)
  const pcOverrides = Object.fromEntries(
    Object.entries(spec.scalarPseudocount ?? {}).filter(([, v]) => v !== undefined)
  );
  if (spec.keyCardinality) validateKeyCardinality(spec.keyCardinality);
  const version = spec.schemaVersion ?? SURFACE_DEFAULTS.schemaVersion;
  return {
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
      scalarPseudocount: { ...DEFAULT_SCALAR_PSEUDOCOUNT, ...pcOverrides },
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
  } as CorpusDef;
}

export interface SessionOptions {
  dbPath?: string; writer?: string; profile?: string;
  workspace?: string; source?: Source;
}

/** Shared read-op deps: embeddings state + optional per-key cardinality.
 *  Neutral home for the deps shape used by recall, census, and reconcile. */
export interface ReadDeps {
  embeddings: EmbeddingState;
  keyCardinality?: Record<string, "single" | "multi">;
}

export type QueryResult = Corpus | RankedCorpus | ComposedContext | AggregateResult;

export interface Session {
  readonly mneme: Mneme; // escape hatch to the raw facade
  createCorpus(spec: CorpusSpec): void;
  /** Declare per-key cardinality for a corpus (create-or-patch, merge). Validates values;
   *  creates the corpus if absent, else merges into schema.keyCardinality and re-persists the
   *  def (claims untouched). Returns the effective keyCardinality map after the merge. */
  declareCardinality(corpusId: string, cardinality: Record<string, "single" | "multi">): Record<string, "single" | "multi">;
  listCorpora(): { id: string; displayName: string }[];
  inspectCorpus(corpusId: string): unknown;
  write(corpusId: string, rec: WriteRecord): WriteOutcome;
  writeMany(corpusId: string, recs: Iterable<WriteRecord>, opts?: { batchSize?: number }): ImportStats;
  q(corpusId: string, dsl: string): QueryResult;
  inspect(corpusId: string, claimId: string): Claim | undefined;
  replay(corpusId: string, claimId: string): { status: string };
  close(): void;
}

export const SURFACE_DEFAULTS = {
  dbPath: "./mneme.db",
  writer: "cli",
  profile: "cli",
  source: "manual" as Source,
  importSource: "imported" as Source,
  schemaVersion: "1",
  validInterval: { from: 0, to: Infinity } as Interval,
} as const;

/** Default confidence when a WriteRecord omits it: full scalar certainty. */
export function defaultConfidence(): Confidence {
  return { distribution: "scalar", parameters: { p: 1 }, raw: 1 };
}
