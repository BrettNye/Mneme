import type { Source, Status, Claim } from "../core/claim.js";
import type { Value } from "../core/value.js";
import type { Confidence } from "../core/confidence.js";
import type { Scope } from "../core/scope.js";
import type { Interval } from "../core/time.js";
import type { Corpus, RankedCorpus, ComposedContext } from "../algebra/types.js";
import type { AggregateResult } from "../algebra/aggregation.js";
import type { ContradictionPolicy } from "../catalog/corpus.js";
import type { Mneme } from "../mneme.js";

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

/** Ergonomic corpus creation input; the session expands it to a full CorpusDef. */
export interface CorpusSpec {
  id: string;
  displayName?: string;
  subjects?: string[];
  scopeFields?: Record<string, unknown>;
  schemaVersion?: string;
  /** Corpus default contradiction policy. Defaults to `{ kind: "always_accept" }`. */
  contradictionPolicy?: ContradictionPolicy;
}

export interface SessionOptions {
  dbPath?: string; writer?: string; profile?: string;
  workspace?: string; source?: Source;
}

export type QueryResult = Corpus | RankedCorpus | ComposedContext | AggregateResult;

export interface Session {
  readonly mneme: Mneme; // escape hatch to the raw facade
  createCorpus(spec: CorpusSpec): void;
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
