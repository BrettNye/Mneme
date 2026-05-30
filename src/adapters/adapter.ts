import type { Claim } from "../core/claim.js";
import type { ClaimId } from "../core/ids.js";

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
  status?: string[];
  scopeHash?: string;
  recordedAtMost?: number;
  runIds?: string[];   // match claims whose provenance.runId ∈ this set
}

export interface IdempotencyRecord {
  result: string;
  createdAt: number;
}

export interface StorageAdapter {
  insertClaim(claim: Claim): void;
  getClaim(id: ClaimId): Claim | undefined;
  deleteClaim(id: ClaimId): void;
  insertBatch(claims: Claim[]): void;
  query(plan: ExecutionPlan): Claim[];
  getIdempotencyRecord(scope: string, key: string): IdempotencyRecord | undefined;
  putIdempotencyRecord(scope: string, key: string, rec: IdempotencyRecord): void;
  capabilities(): AdapterCapabilities;
  transaction<T>(fn: () => T): T;
  maxRecordedSeq(): number;
  appendEvent(e: ClaimEvent): void;
  readEvents(filter?: { corpusId?: string; claimId?: string; since?: number }): ClaimEvent[];
  /** Return a scope-bound view: reads force corpus (and profile if set); writes stamp corpus. */
  scoped?(scope: AdapterScope): StorageAdapter;
  /** Release any underlying resources (e.g. file handles). Optional; in-memory adapters may omit it. */
  close?(): void;
}

export const valuePredicateLevel = (
  c: AdapterCapabilities,
  k: PredicateKind
): ValuePredicateLevel => c.valuePredicateSupport[k];
