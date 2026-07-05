import type { AsyncStorageAdapter } from "./async-adapter.js";
import type { AdapterCapabilities, ExecutionPlan, IdempotencyRecord, ClaimEvent } from "./adapter-types.js";
import type { Claim } from "../core/claim.js";
import type { ClaimId } from "../core/ids.js";

// Type-level conformance test: a fully Promise-returning stub object assigned to
// AsyncStorageAdapter proves the interface shape compiles as the async mirror of
// StorageAdapter (member-for-member), with capabilities() staying synchronous and
// transaction/maxRecordedSeq carrying an explicit corpusId.
it("AsyncStorageAdapter interface is satisfied by a Promise-returning stub implementation", async () => {
  const stub: AsyncStorageAdapter = {
    async insertClaim(_claim: Claim): Promise<void> {},
    async getClaim(_id: ClaimId): Promise<Claim | undefined> { return undefined; },
    async deleteClaim(_id: ClaimId): Promise<void> {},
    async insertBatch(_claims: Claim[]): Promise<void> {},
    async query(_plan: ExecutionPlan): Promise<Claim[]> { return []; },
    async getIdempotencyRecord(_scope: string, _key: string): Promise<IdempotencyRecord | undefined> { return undefined; },
    async putIdempotencyRecord(_scope: string, _key: string, _rec: IdempotencyRecord): Promise<void> {},
    capabilities(): AdapterCapabilities {
      return {
        valuePredicateSupport: {
          equality: "native_indexed",
          range: "native_unindexed",
          set_membership: "fallback_in_memory",
          regex: "unsupported",
          structural_pattern: "fallback_in_memory",
          null_check: "native_indexed",
        },
      };
    },
    async transaction<T>(_corpusId: string, fn: () => Promise<T>): Promise<T> { return fn(); },
    async maxRecordedSeq(_corpusId: string): Promise<number> { return 0; },
    async appendEvent(_e: ClaimEvent): Promise<void> {},
    async readEvents(_filter?: { corpusId?: string; claimId?: string; since?: number }): Promise<ClaimEvent[]> { return []; },
  };

  expect(await stub.query({ corpusId: "c1" })).toEqual([]);
  expect(stub.capabilities().valuePredicateSupport.equality).toBe("native_indexed");
  expect(await stub.transaction("corpus-1", async () => 42)).toBe(42);
  expect(await stub.maxRecordedSeq("corpus-1")).toBe(0);
});

it("optional members (putAnchoredRoot, getAnchoredRoots, scoped, close) are omittable", async () => {
  const stub: AsyncStorageAdapter = {
    async insertClaim(_claim: Claim): Promise<void> {},
    async getClaim(_id: ClaimId): Promise<Claim | undefined> { return undefined; },
    async deleteClaim(_id: ClaimId): Promise<void> {},
    async insertBatch(_claims: Claim[]): Promise<void> {},
    async query(_plan: ExecutionPlan): Promise<Claim[]> { return []; },
    async getIdempotencyRecord(_scope: string, _key: string): Promise<IdempotencyRecord | undefined> { return undefined; },
    async putIdempotencyRecord(_scope: string, _key: string, _rec: IdempotencyRecord): Promise<void> {},
    capabilities(): AdapterCapabilities {
      return { valuePredicateSupport: { equality: "unsupported", range: "unsupported", set_membership: "unsupported", regex: "unsupported", structural_pattern: "unsupported", null_check: "unsupported" } };
    },
    async transaction<T>(_corpusId: string, fn: () => Promise<T>): Promise<T> { return fn(); },
    async maxRecordedSeq(_corpusId: string): Promise<number> { return 0; },
    async appendEvent(_e: ClaimEvent): Promise<void> {},
    async readEvents(_filter?: { corpusId?: string; claimId?: string; since?: number }): Promise<ClaimEvent[]> { return []; },
  };

  expect(stub.putAnchoredRoot).toBeUndefined();
  expect(stub.getAnchoredRoots).toBeUndefined();
  expect(stub.scoped).toBeUndefined();
  expect(stub.close).toBeUndefined();
});

it("a Promise-returning object structurally satisfies AsyncStorageAdapter", () => {
  const stub = { transaction: async (_c: string, f: () => Promise<unknown>) => f() } as Partial<AsyncStorageAdapter>;
  expect(typeof stub.transaction).toBe("function");
});
