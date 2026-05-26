import { valuePredicateLevel, type AdapterCapabilities, type StorageAdapter, type ExecutionPlan, type IdempotencyRecord, type ClaimEvent } from "./adapter.js";
import type { Claim } from "../core/claim.js";
import type { ClaimId } from "../core/ids.js";

it("reads the per-kind value-predicate level for equality", () => {
  const caps = { valuePredicateSupport: { equality: "native_unindexed" } } as AdapterCapabilities;
  expect(valuePredicateLevel(caps, "equality")).toBe("native_unindexed");
});

it("reads the per-kind value-predicate level for range", () => {
  const caps: AdapterCapabilities = {
    valuePredicateSupport: {
      equality: "native_indexed",
      range: "native_unindexed",
      set_membership: "fallback_in_memory",
      regex: "unsupported",
      structural_pattern: "fallback_in_memory",
      null_check: "native_indexed",
    },
  };
  expect(valuePredicateLevel(caps, "range")).toBe("native_unindexed");
  expect(valuePredicateLevel(caps, "regex")).toBe("unsupported");
  expect(valuePredicateLevel(caps, "null_check")).toBe("native_indexed");
});

// Type-level conformance test: a typed stub object assigned to StorageAdapter proves the interface shape compiles
it("StorageAdapter interface is satisfied by a stub implementation", () => {
  const stub: StorageAdapter = {
    insertClaim(_claim: Claim): void {},
    getClaim(_id: ClaimId): Claim | undefined { return undefined; },
    deleteClaim(_id: ClaimId): void {},
    insertBatch(_claims: Claim[]): void {},
    query(_plan: ExecutionPlan): Claim[] { return []; },
    getIdempotencyRecord(_scope: string, _key: string): IdempotencyRecord | undefined { return undefined; },
    putIdempotencyRecord(_scope: string, _key: string, _rec: IdempotencyRecord): void {},
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
    transaction<T>(fn: () => T): T { return fn(); },
    maxRecordedSeq(): number { return 0; },
    appendEvent(_e: ClaimEvent): void {},
    readEvents(_filter?: { corpusId?: string; claimId?: string; since?: number }): ClaimEvent[] { return []; },
  };
  // The stub satisfies the interface; query returns an empty array
  expect(stub.query({ corpusId: "c1" })).toEqual([]);
});

it("ExecutionPlan carries pushable leaf filters", () => {
  const plan: ExecutionPlan = {
    corpusId: "corpus-1",
    subject: "person:123",
    key: "age",
    status: ["validated", "provisional"],
    scopeHash: "abc123",
    recordedAtMost: 1700000000000,
  };
  expect(plan.corpusId).toBe("corpus-1");
  expect(plan.subject).toBe("person:123");
  expect(plan.status).toEqual(["validated", "provisional"]);
});
