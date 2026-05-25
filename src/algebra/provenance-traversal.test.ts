import { gamma } from "./provenance-traversal.js";
import type { RankedCorpus } from "./types.js";

// γ_0 identity: depth=0 returns same scored claims unchanged
it("gamma depth-0 is the identity (no traversal)", () => {
  const root = { id: "A", evidence: [] } as any;
  const rc: RankedCorpus = { scored: [{ claim: root, score: 0.9 }] };
  const out = gamma(0, (_id) => undefined)(rc);
  expect(out.scored).toHaveLength(1);
  expect(out.scored[0].claim.id).toBe("A");
  expect(out.scored[0].score).toBe(0.9);
});

// depth-1 pulls in directly-cited claims with no duplication
it("depth-1 pulls in directly-cited claims with no duplication", () => {
  const cited = { id: "B", evidence: [] } as any;
  const root = { id: "A", evidence: [{ kind: "claim", claimId: "B" }] } as any;
  const rc = { scored: [{ claim: root, score: 0.9 }] };
  const out = gamma(1, (id) => (id === "B" ? cited : undefined))(rc);
  expect(out.scored.map((s) => s.claim.id).sort()).toEqual(["A", "B"]);
});

// cited claims appended at score 0; original claims keep their scores
it("cited claims are appended at score 0; original scores are preserved", () => {
  const cited = { id: "B", evidence: [] } as any;
  const root = { id: "A", evidence: [{ kind: "claim", claimId: "B" }] } as any;
  const rc = { scored: [{ claim: root, score: 0.75 }] };
  const out = gamma(1, (id) => (id === "B" ? cited : undefined))(rc);
  const a = out.scored.find((s) => s.claim.id === "A")!;
  const b = out.scored.find((s) => s.claim.id === "B")!;
  expect(a.score).toBe(0.75);
  expect(b.score).toBe(0);
});

// transitive depth-2: A→B→C; depth 2 should pull in both B and C
it("depth-2 transitively follows claim edges (A→B→C)", () => {
  const c = { id: "C", evidence: [] } as any;
  const b = { id: "B", evidence: [{ kind: "claim", claimId: "C" }] } as any;
  const a = { id: "A", evidence: [{ kind: "claim", claimId: "B" }] } as any;
  const rc = { scored: [{ claim: a, score: 1.0 }] };
  const lookup = (id: string) => (id === "B" ? b : id === "C" ? c : undefined) as any;
  const out = gamma(2, lookup)(rc);
  expect(out.scored.map((s) => s.claim.id).sort()).toEqual(["A", "B", "C"]);
});

// depth-1 on same graph should NOT reach C
it("depth-1 does NOT transitively pull in second-level claims (A→B→C)", () => {
  const c = { id: "C", evidence: [] } as any;
  const b = { id: "B", evidence: [{ kind: "claim", claimId: "C" }] } as any;
  const a = { id: "A", evidence: [{ kind: "claim", claimId: "B" }] } as any;
  const rc = { scored: [{ claim: a, score: 1.0 }] };
  const lookup = (id: string) => (id === "B" ? b : id === "C" ? c : undefined) as any;
  const out = gamma(1, lookup)(rc);
  expect(out.scored.map((s) => s.claim.id).sort()).toEqual(["A", "B"]);
});

// monotonicity: C ⊆ γ_d(C) — original claims always present in output
it("monotonicity: all original scored claims are present in the output", () => {
  const root = { id: "A", evidence: [{ kind: "claim", claimId: "MISSING" }] } as any;
  const rc = { scored: [{ claim: root, score: 0.5 }] };
  const out = gamma(3, (_id) => undefined)(rc);
  expect(out.scored.some((s) => s.claim.id === "A")).toBe(true);
});

// missing citations are skipped, not fatal
it("missing citations (lookup returns undefined) are skipped gracefully", () => {
  const root = { id: "A", evidence: [{ kind: "claim", claimId: "MISSING" }] } as any;
  const rc = { scored: [{ claim: root, score: 0.9 }] };
  const out = gamma(1, (_id) => undefined)(rc);
  expect(out.scored).toHaveLength(1);
  expect(out.scored[0].claim.id).toBe("A");
});

// no duplication: if a claim is already in the corpus, don't add it again
it("no duplication: a claim already in the corpus is not duplicated by traversal", () => {
  const shared = { id: "B", evidence: [] } as any;
  const a = { id: "A", evidence: [{ kind: "claim", claimId: "B" }] } as any;
  const rc = { scored: [{ claim: a, score: 0.8 }, { claim: shared, score: 0.6 }] };
  const out = gamma(1, (id) => (id === "B" ? shared : undefined))(rc);
  const ids = out.scored.map((s) => s.claim.id);
  const bCount = ids.filter((id) => id === "B").length;
  expect(bCount).toBe(1);
});

// composition: γ_d1(γ_d2(C)) = γ_(d1+d2)(C)
it("composition law: gamma(d1)(gamma(d2)(C)) equals gamma(d1+d2)(C)", () => {
  const c = { id: "C", evidence: [] } as any;
  const b = { id: "B", evidence: [{ kind: "claim", claimId: "C" }] } as any;
  const a = { id: "A", evidence: [{ kind: "claim", claimId: "B" }] } as any;
  const rc = { scored: [{ claim: a, score: 1.0 }] };
  const lookup = (id: string) => (id === "B" ? b : id === "C" ? c : undefined) as any;

  // γ_1(γ_1(C)) should equal γ_2(C)
  const composed = gamma(1, lookup)(gamma(1, lookup)(rc));
  const direct = gamma(2, lookup)(rc);

  expect(composed.scored.map((s) => s.claim.id).sort()).toEqual(
    direct.scored.map((s) => s.claim.id).sort(),
  );
});

// non-claim evidence refs (document, external) are ignored
it("non-claim evidence refs (document, external) are ignored during traversal", () => {
  const root = {
    id: "A",
    evidence: [
      { kind: "document", sourceDocumentId: "doc1", extractionMethod: "pdf" },
      { kind: "external", uri: "https://example.com" },
    ],
  } as any;
  const rc = { scored: [{ claim: root, score: 0.9 }] };
  const out = gamma(2, (_id) => undefined)(rc);
  expect(out.scored).toHaveLength(1);
  expect(out.scored[0].claim.id).toBe("A");
});
