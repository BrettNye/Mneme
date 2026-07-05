import type { Claim } from "../core/claim.js";
import type { ClaimId } from "../core/ids.js";
import type {
  ExecutionPlan,
  AdapterCapabilities,
  IdempotencyRecord,
  ClaimEvent,
  AnchoredRootRow,
  AdapterScope,
} from "./adapter-types.js";

// Async twin of StorageAdapter (see ./adapter.ts). Member-for-member mirror:
// every storage method returns a Promise; capabilities() stays synchronous
// (static metadata); transaction/maxRecordedSeq carry an explicit corpusId.
export interface AsyncStorageAdapter {
  insertClaim(claim: Claim): Promise<void>;
  getClaim(id: ClaimId): Promise<Claim | undefined>;
  deleteClaim(id: ClaimId): Promise<void>;
  insertBatch(claims: Claim[]): Promise<void>;
  query(plan: ExecutionPlan): Promise<Claim[]>;
  getIdempotencyRecord(scope: string, key: string): Promise<IdempotencyRecord | undefined>;
  putIdempotencyRecord(scope: string, key: string, rec: IdempotencyRecord): Promise<void>;
  capabilities(): AdapterCapabilities;
  transaction<T>(corpusId: string, fn: () => Promise<T>): Promise<T>;
  maxRecordedSeq(corpusId: string): Promise<number>;
  appendEvent(e: ClaimEvent): Promise<void>;
  readEvents(filter?: { corpusId?: string; claimId?: string; since?: number }): Promise<ClaimEvent[]>;
  /** Store an anchored Merkle root for a corpus+epoch. Optional: not all adapters implement anchoring. */
  putAnchoredRoot?(row: AnchoredRootRow): Promise<void>;
  /** Retrieve anchored roots for a corpus, optionally filtered by epochId or since timestamp. */
  getAnchoredRoots?(corpusId: string, range?: { epochId?: string; since?: number }): Promise<AnchoredRootRow[]>;
  /** Return a scope-bound view: reads force corpus (and profile if set); writes stamp corpus. */
  scoped?(scope: AdapterScope): AsyncStorageAdapter;
  /** Release any underlying resources (e.g. file handles). Optional; in-memory adapters may omit it. */
  close?(): Promise<void>;
}
