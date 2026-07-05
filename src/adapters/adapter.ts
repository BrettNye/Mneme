import type { Claim } from "../core/claim.js";
import type { ClaimId } from "../core/ids.js";
import type {
  ClaimEvent,
  ExecutionPlan,
  AdapterCapabilities,
  IdempotencyRecord,
  AnchoredRootRow,
  AdapterScope,
} from "./adapter-types.js";

// Backend-agnostic value types now live in ./adapter-types.js so the sync
// (StorageAdapter, below) and async adapter contracts can share one
// definition without drift. Re-exported here for byte-compatibility with
// existing importers.
export type {
  ClaimEvent,
  ExecutionPlan,
  AdapterCapabilities,
  IdempotencyRecord,
  AnchoredRootRow,
  AdapterScope,
  PredicateKind,
  ValuePredicateLevel,
} from "./adapter-types.js";
export { valuePredicateLevel } from "./adapter-types.js";

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
  /** Store an anchored Merkle root for a corpus+epoch. Optional: not all adapters implement anchoring. */
  putAnchoredRoot?(row: AnchoredRootRow): void;
  /** Retrieve anchored roots for a corpus, optionally filtered by epochId or since timestamp. */
  getAnchoredRoots?(corpusId: string, range?: { epochId?: string; since?: number }): AnchoredRootRow[];
  /** Return a scope-bound view: reads force corpus (and profile if set); writes stamp corpus. */
  scoped?(scope: AdapterScope): StorageAdapter;
  /** Release any underlying resources (e.g. file handles). Optional; in-memory adapters may omit it. */
  close?(): void;
}
