// Backend-agnostic value types shared by both the sync (StorageAdapter) and
// async adapter contracts. Kept neutral (no interface with method signatures)
// so both contracts can import from here without drift.

export interface AdapterScope {
  corpus: string;
  profile?: string;
}

export interface ClaimEvent {
  op: "commit" | "supersede" | "promote";
  corpusId: string;
  writer: string;
  claimId: string;
  deprecatedId?: string;   // supersede
  toStatus?: string;       // promote
  reason?: string;         // promote
  recorded: number;
  recordedSeq: number;
  /** SHA-256 hash of canonical(event) + prevHash, hex-encoded. Set by the adapter on write. */
  entryHash?: string;
  /** The entryHash of the previous event in the same corpus, or "" for the genesis event. */
  prevHash?: string;
}

export interface AnchoredRootRow {
  corpusId: string;
  epochId: string;
  root: string;
  signature: string | null;
  guarantee: string;
  at: number;
}

export type PredicateKind =
  | "equality"
  | "range"
  | "set_membership"
  | "regex"
  | "structural_pattern"
  | "null_check";

export type ValuePredicateLevel =
  | "native_indexed"
  | "native_unindexed"
  | "fallback_in_memory"
  | "unsupported";

export interface AdapterCapabilities {
  valuePredicateSupport: Record<PredicateKind, ValuePredicateLevel>;
}

export interface ExecutionPlan {
  corpusId: string;
  subject?: string;
  key?: string;
  /** Match claims whose key is in this set (SQL: key IN (...)). May be combined
   *  with `key` — all plan fields AND together. CAUTION: an EMPTY array emits NO
   *  condition (matches everything, mirroring status/runIds), whereas the in-memory
   *  σ predicate keyIn([]) matches NOTHING — hint builders must OMIT the field
   *  instead of passing []. */
  keys?: string[];
  status?: string[];
  scopeHash?: string;
  recordedAtMost?: number;
  runIds?: string[];   // match claims whose provenance.runId is in this set
}

export interface IdempotencyRecord {
  result: string;
  createdAt: number;
}

export const valuePredicateLevel = (
  c: AdapterCapabilities,
  k: PredicateKind
): ValuePredicateLevel => c.valuePredicateSupport[k];
