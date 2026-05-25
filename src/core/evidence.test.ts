import { wouldCreateCycle } from "./evidence.js";
import type { ClaimId } from "./ids.js";

const id = (s: string) => s as ClaimId;

it("detects self-citation", () => {
  expect(wouldCreateCycle(id("A"), [{ kind: "claim", claimId: id("A") }], () => [])).toBe(true);
});

it("detects transitive cycle A->B->A", () => {
  // A cites B; B cites A (via edgesOf)
  const edgesOf = (claimId: ClaimId) => {
    if (claimId === id("B")) {
      return [{ kind: "claim" as const, claimId: id("A") }];
    }
    return [];
  };
  expect(wouldCreateCycle(id("A"), [{ kind: "claim", claimId: id("B") }], edgesOf)).toBe(true);
});

it("returns false for acyclic chain A->B->C", () => {
  const edgesOf = (claimId: ClaimId) => {
    if (claimId === id("B")) {
      return [{ kind: "claim" as const, claimId: id("C") }];
    }
    return [];
  };
  expect(wouldCreateCycle(id("A"), [{ kind: "claim", claimId: id("B") }], edgesOf)).toBe(false);
});

it("ignores document refs in cycle detection", () => {
  const refs = [
    { kind: "document" as const, sourceDocumentId: "doc-1", extractionMethod: "manual" },
    { kind: "claim" as const, claimId: id("B") },
  ];
  const edgesOf = (_claimId: ClaimId) => [];
  // B does not cycle back, so no cycle
  expect(wouldCreateCycle(id("A"), refs, edgesOf)).toBe(false);
});

it("ignores external refs in cycle detection", () => {
  const refs = [
    { kind: "external" as const, uri: "https://example.com", contentHash: "abc123" },
  ];
  const edgesOf = (_claimId: ClaimId) => [];
  expect(wouldCreateCycle(id("A"), refs, edgesOf)).toBe(false);
});

it("does not flag non-cyclic claim refs", () => {
  // A cites B, B cites C (no cycle)
  const edgesOf = (claimId: ClaimId) => {
    if (claimId === id("B")) {
      return [{ kind: "claim" as const, claimId: id("C") }];
    }
    return [];
  };
  expect(wouldCreateCycle(id("A"), [{ kind: "claim", claimId: id("B") }], edgesOf)).toBe(false);
});
