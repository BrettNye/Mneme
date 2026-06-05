import { oplusDedupe, oplusSynthesizeAs } from "./combination.js";
import { corpusOf } from "./types.js";

// -------------------------------------------------------------------
// Similarity-mode helpers
// -------------------------------------------------------------------
const T0 = 1_700_000_000_000; // base epoch ms
const DAY = 86_400_000;

/** Minimal claim for similarity tests (uses valid.from for representative ordering). */
const mk = (id: string, value: string, from: number) =>
  ({
    id,
    subject: "sim_subject",
    key: "sim_key",
    scopeHash: "sim_hash",
    value,
    source: "workflow",
    confidence: {
      distribution: "beta",
      parameters: { alpha: 3, beta: 2 },
      raw: 0.6,
    },
    evidence: [],
    scope: {},
    valid: { from, to: null },
  }) as any;

// Helper to build a minimal claim-like object
const claim = (
  id: string,
  value: string,
  alpha: number,
  beta: number,
  source: string = "workflow",
  subject: string = "s",
  key: string = "s.k",
  scopeHash: string = "_"
) =>
  ({
    id,
    subject,
    key,
    scopeHash,
    value,
    source,
    confidence: {
      distribution: "beta",
      parameters: { alpha, beta },
      raw: alpha / (alpha + beta),
    },
    evidence: [],
    scope: {},
  }) as any;

const scalarClaim = (
  id: string,
  p: number,
  source: string = "workflow",
  subject: string = "s",
  key: string = "s.k",
  scopeHash: string = "_"
) =>
  ({
    id,
    subject,
    key,
    scopeHash,
    value: String(p),
    source,
    confidence: {
      distribution: "scalar",
      parameters: { p },
      raw: p,
    },
    evidence: [],
    scope: {},
  }) as any;

// -------------------------------------------------------------------
// oplusDedupe: evidence_pooled collapses same-(subject,key,scope) claims
// -------------------------------------------------------------------
it("oplusDedupe collapses same-(subject,key,scope) claims via evidence_pooled", () => {
  const out = oplusDedupe("rule_evidence_pooled")(
    corpusOf([claim("a", "x", 3, 2), claim("b", "x", 3, 2)])
  );
  expect(out.claims).toHaveLength(1);
  // Beta(3,2) + Beta(3,2) under evidence_pooled: alpha=3+3-1=5, beta=2+2-1=3
  expect(out.claims[0].confidence.parameters).toEqual({ alpha: 5, beta: 3 });
});

// -------------------------------------------------------------------
// oplusDedupe: groups by (subject, key, scopeHash) — different triples not merged
// -------------------------------------------------------------------
it("oplusDedupe keeps claims in different (subject,key,scopeHash) groups separate", () => {
  const c1 = claim("a", "x", 3, 2, "workflow", "s1", "s1.k", "hash1");
  const c2 = claim("b", "x", 3, 2, "workflow", "s2", "s2.k", "hash2");
  const out = oplusDedupe("rule_evidence_pooled")(corpusOf([c1, c2]));
  expect(out.claims).toHaveLength(2);
});

// -------------------------------------------------------------------
// oplusDedupe: weighted_avg on a singleton leaves confidence unchanged (idempotent)
// -------------------------------------------------------------------
it("oplusDedupe with rule_weighted_avg is idempotent on singleton groups", () => {
  const c = claim("a", "x", 3, 2);
  const out = oplusDedupe("rule_weighted_avg")(corpusOf([c]));
  expect(out.claims).toHaveLength(1);
  expect(out.claims[0].confidence.parameters).toEqual({ alpha: 3, beta: 2 });
});

// -------------------------------------------------------------------
// oplusDedupe: weighted_avg weights by SOURCE_WEIGHT
// Two claims: workflow (1.0) and manual (1.3)
// weighted_avg(Beta(3,2) w=1.0, Beta(5,2) w=1.3):
//   alpha = (1.0*3 + 1.3*5) / 2.3 = (3 + 6.5) / 2.3 = 9.5 / 2.3 ≈ 4.13
//   beta  = (1.0*2 + 1.3*2) / 2.3 = (2 + 2.6) / 2.3 = 4.6 / 2.3 = 2.0
// -------------------------------------------------------------------
it("oplusDedupe with rule_weighted_avg weights each claim by SOURCE_WEIGHT", () => {
  const c1 = claim("a", "x", 3, 2, "workflow"); // weight 1.0
  const c2 = claim("b", "x", 5, 2, "manual"); // weight 1.3
  const out = oplusDedupe("rule_weighted_avg")(corpusOf([c1, c2]));
  expect(out.claims).toHaveLength(1);
  const params = out.claims[0].confidence.parameters as { alpha: number; beta: number };
  const totalWeight = 1.0 + 1.3;
  const expectedAlpha = (1.0 * 3 + 1.3 * 5) / totalWeight;
  const expectedBeta = (1.0 * 2 + 1.3 * 2) / totalWeight;
  expect(params.alpha).toBeCloseTo(expectedAlpha, 5);
  expect(params.beta).toBeCloseTo(expectedBeta, 5);
});

// -------------------------------------------------------------------
// oplusDedupe: max_mean selects the claim with higher mean; tie-break by lexicographic claim id
// Beta(3,2) mean = 3/5 = 0.6; Beta(1,4) mean = 1/5 = 0.2
// -------------------------------------------------------------------
it("oplusDedupe with rule_max_mean selects claim with higher mean", () => {
  const c1 = claim("a", "x", 3, 2); // mean = 0.6
  const c2 = claim("b", "x", 1, 4); // mean = 0.2
  const out = oplusDedupe("rule_max_mean")(corpusOf([c1, c2]));
  expect(out.claims).toHaveLength(1);
  expect(out.claims[0].confidence.parameters).toEqual({ alpha: 3, beta: 2 });
});

// -------------------------------------------------------------------
// oplusDedupe: max_mean tie-break by lexicographic claim id (earlier id wins)
// Beta(3,2) mean = 0.6 both — "a" < "b" lexicographically so "a" wins
// -------------------------------------------------------------------
it("oplusDedupe with rule_max_mean uses lexicographic claim-id as tie-break", () => {
  const c1 = claim("a", "x", 3, 2); // id "a", mean 0.6
  const c2 = claim("b", "x", 3, 2); // id "b", mean 0.6 — tie
  const out = oplusDedupe("rule_max_mean")(corpusOf([c1, c2]));
  expect(out.claims).toHaveLength(1);
  expect(out.claims[0].id).toBe("a");
});

// -------------------------------------------------------------------
// oplusDedupe: max_concentration selects claim with greater alpha+beta
// Beta(3,2): conc=5; Beta(6,4): conc=10
// -------------------------------------------------------------------
it("oplusDedupe with rule_max_concentration selects by evidence weight", () => {
  const c1 = claim("a", "x", 3, 2); // conc = 5
  const c2 = claim("b", "x", 6, 4); // conc = 10
  const out = oplusDedupe("rule_max_concentration")(corpusOf([c1, c2]));
  expect(out.claims).toHaveLength(1);
  expect(out.claims[0].confidence.parameters).toEqual({ alpha: 6, beta: 4 });
});

// -------------------------------------------------------------------
// oplusDedupe: max_concentration tie-break by lexicographic claim id
// -------------------------------------------------------------------
it("oplusDedupe with rule_max_concentration uses lexicographic claim-id tie-break", () => {
  const c1 = claim("a", "x", 3, 2); // conc = 5
  const c2 = claim("b", "x", 3, 2); // conc = 5 — tie
  const out = oplusDedupe("rule_max_concentration")(corpusOf([c1, c2]));
  expect(out.claims).toHaveLength(1);
  expect(out.claims[0].id).toBe("a");
});

// -------------------------------------------------------------------
// oplusSynthesizeAs: returns single claim with folded confidence and union of evidence
// -------------------------------------------------------------------
it("oplusSynthesizeAs returns a synthesized Claim with combined confidence and union evidence", () => {
  const c1 = { ...claim("a", "x", 3, 2), evidence: [{ claimId: "e1" }] };
  const c2 = { ...claim("b", "x", 3, 2), evidence: [{ claimId: "e2" }] };
  const result = oplusSynthesizeAs("subject1", "subject1.key", "rule_evidence_pooled")(
    corpusOf([c1, c2])
  );
  expect(result.subject).toBe("subject1");
  expect(result.key).toBe("subject1.key");
  expect(result.confidence.parameters).toEqual({ alpha: 5, beta: 3 });
  // Union of evidence
  const evidenceIds = result.evidence.map((e: any) => e.claimId);
  expect(evidenceIds).toContain("e1");
  expect(evidenceIds).toContain("e2");
});

// -------------------------------------------------------------------
// oplusSynthesizeAs: does NOT persist (no id, no recorded)
// -------------------------------------------------------------------
it("oplusSynthesizeAs returns an unpersisted claim (no id or recorded)", () => {
  const c = claim("a", "x", 3, 2);
  const result = oplusSynthesizeAs("s", "s.k", "rule_evidence_pooled")(corpusOf([c]));
  // An unpersisted claim has no stable id (may be undefined or empty)
  expect((result as any).id).toBeUndefined();
  expect((result as any).recorded).toBeUndefined();
});

// -------------------------------------------------------------------
// Error: assertNotDeprecatedRule — rule_max_confidence throws naming both replacements
// -------------------------------------------------------------------
it("oplusDedupe throws for deprecated rule_max_confidence naming both replacements", () => {
  const c = claim("a", "x", 3, 2);
  expect(() =>
    oplusDedupe("rule_max_confidence")(corpusOf([c]))
  ).toThrow(/rule_max_mean/);
});

it("oplusDedupe deprecated error message also names rule_max_concentration", () => {
  const c = claim("a", "x", 3, 2);
  expect(() =>
    oplusDedupe("rule_max_confidence")(corpusOf([c]))
  ).toThrow(/rule_max_concentration/);
});

it("oplusSynthesizeAs throws for deprecated rule_max_confidence", () => {
  const c = claim("a", "x", 3, 2);
  expect(() =>
    oplusSynthesizeAs("s", "s.k", "rule_max_confidence")(corpusOf([c]))
  ).toThrow(/rule_max_confidence.*removed|removed.*rule_max_confidence/i);
});

// -------------------------------------------------------------------
// REGRESSION: max-rule winner is NOT sorted[0] — result must carry winner's value/id/parameters
// id "a" value "no" Beta(1,9) mean≈0.1; id "b" value "yes" Beta(9,1) mean≈0.9
// sorted by id: [a, b]; b has higher mean → b wins → result must have value "yes", id "b"
// -------------------------------------------------------------------
it("oplusDedupe rule_max_mean returns the WINNING claim's value and id, not sorted[0]'s", () => {
  const loser = claim("a", "no", 1, 9);  // id "a" (first lexicographically), mean ≈ 0.1
  const winner = claim("b", "yes", 9, 1); // id "b", mean ≈ 0.9
  const out = oplusDedupe("rule_max_mean")(corpusOf([loser, winner]));
  expect(out.claims).toHaveLength(1);
  expect(out.claims[0].value).toBe("yes");
  expect(out.claims[0].id).toBe("b");
  expect(out.claims[0].confidence.parameters).toEqual({ alpha: 9, beta: 1 });
});

// -------------------------------------------------------------------
// Error: assertSupportsRule — unsupported rule on scalar binding throws
// -------------------------------------------------------------------
it("oplusDedupe with rule_dempster on scalar claims throws via assertSupportsRule", () => {
  const c1 = scalarClaim("a", 0.6);
  const c2 = scalarClaim("b", 0.8);
  expect(() =>
    oplusDedupe("rule_dempster")(corpusOf([c1, c2]))
  ).toThrow(/not supported/i);
});

// ===================================================================
// SIMILARITY MODE TESTS
// ===================================================================

// -------------------------------------------------------------------
// AC: restatements merge; disjoint values survive separately
// -------------------------------------------------------------------
it("similarity mode merges token-overlap restatements and keeps dissimilar values separate", () => {
  // same (subject, key, scope); a~b overlap >= 0.5, x disjoint from both
  const a = mk("a", "power bank from Amazon", T0);
  const b = mk("b", "power bank from Amazon ordered Feb 13", T0 + DAY);
  const x = mk("x", "Pixel 8", T0);
  const out = oplusDedupe("rule_weighted_avg", undefined, {
    similarity: { fn: "jaccard", cutoff: 0.5 },
  })(corpusOf([a, b, x]));
  expect(out.claims).toHaveLength(2);
  // representative of the merged pair = b (latest valid.from)
  expect(out.claims.map((c) => c.value)).toContain("power bank from Amazon ordered Feb 13");
  expect(out.claims.map((c) => c.value)).toContain("Pixel 8");
});

// -------------------------------------------------------------------
// AC: single-link transitivity — chain A~B, B~C, sim(A,C)<cutoff ⇒ one cluster
// -------------------------------------------------------------------
it("similarity mode uses single-link transitivity to form a chain cluster", () => {
  // A and B share "token_ab" (will overlap), B and C share "token_bc" (will overlap)
  // but A and C share nothing (jaccard=0)
  const a = mk("a", "token_ab only_a", T0);
  const b = mk("b", "token_ab token_bc", T0 + DAY);
  const c_claim = mk("c", "token_bc only_c", T0 + 2 * DAY);
  const out = oplusDedupe("rule_weighted_avg", undefined, {
    similarity: { fn: "jaccard", cutoff: 0.3 },
  })(corpusOf([a, b, c_claim]));
  // All three should merge into one cluster via transitivity
  expect(out.claims).toHaveLength(1);
  // Representative = c_claim (latest valid.from)
  expect(out.claims[0].value).toBe("token_bc only_c");
});

// -------------------------------------------------------------------
// AC: representative uses latest valid.from; tie-break = lexicographically-smaller id wins
// -------------------------------------------------------------------
it("similarity mode picks latest valid.from as representative, ties broken by lexicographic id", () => {
  // Both same value => exact match, jaccard=1 >= cutoff
  const a = mk("z", "same value", T0);  // id "z", same from
  const b = mk("a", "same value", T0);  // id "a", same from — "a" < "z" so "a" wins
  const out = oplusDedupe("rule_weighted_avg", undefined, {
    similarity: { fn: "jaccard", cutoff: 0.9 },
  })(corpusOf([a, b]));
  expect(out.claims).toHaveLength(1);
  // Both have same valid.from, so lexicographically smaller id "a" wins
  expect(out.claims[0].id).toBe("a");
});

it("similarity mode picks latest valid.from when times differ", () => {
  const older = mk("z", "same value", T0);
  const newer = mk("a", "same value", T0 + DAY); // later timestamp, id "a" but doesn't matter
  const out = oplusDedupe("rule_weighted_avg", undefined, {
    similarity: { fn: "jaccard", cutoff: 0.9 },
  })(corpusOf([older, newer]));
  expect(out.claims).toHaveLength(1);
  // newer has later valid.from, so it's the representative regardless of id
  expect(out.claims[0].id).toBe("a");
});

// -------------------------------------------------------------------
// AC: deterministic — reversing input order produces identical output
// -------------------------------------------------------------------
it("similarity mode produces identical output regardless of input order", () => {
  const a = mk("a", "power bank from Amazon", T0);
  const b = mk("b", "power bank from Amazon ordered Feb 13", T0 + DAY);
  const x = mk("x", "Pixel 8", T0);

  const out1 = oplusDedupe("rule_weighted_avg", undefined, {
    similarity: { fn: "jaccard", cutoff: 0.5 },
  })(corpusOf([a, b, x]));

  const out2 = oplusDedupe("rule_weighted_avg", undefined, {
    similarity: { fn: "jaccard", cutoff: 0.5 },
  })(corpusOf([x, b, a]));

  // Same number of claims
  expect(out1.claims).toHaveLength(out2.claims.length);
  // Same values (order may differ between runs but sort for comparison)
  const vals1 = out1.claims.map((c) => c.value).sort();
  const vals2 = out2.claims.map((c) => c.value).sort();
  expect(vals1).toEqual(vals2);
  // Same ids
  const ids1 = out1.claims.map((c) => c.id).sort();
  const ids2 = out2.claims.map((c) => c.id).sort();
  expect(ids1).toEqual(ids2);
});

// -------------------------------------------------------------------
// AC: unregistered fn throws /no similarity fn/
// -------------------------------------------------------------------
it("similarity mode with unregistered fn throws /no similarity fn/", () => {
  const a = mk("a", "hello world", T0);
  expect(() =>
    oplusDedupe("rule_weighted_avg", undefined, {
      similarity: { fn: "nonexistent", cutoff: 0.5 },
    })(corpusOf([a]))
  ).toThrow(/no similarity fn/);
});

// -------------------------------------------------------------------
// AC: cutoff outside [0, 1] throws
// -------------------------------------------------------------------
it("similarity mode with cutoff -0.1 throws", () => {
  const a = mk("a", "hello", T0);
  expect(() =>
    oplusDedupe("rule_weighted_avg", undefined, {
      similarity: { fn: "jaccard", cutoff: -0.1 },
    })(corpusOf([a]))
  ).toThrow(/cutoff/i);
});

it("similarity mode with cutoff 1.1 throws", () => {
  const a = mk("a", "hello", T0);
  expect(() =>
    oplusDedupe("rule_weighted_avg", undefined, {
      similarity: { fn: "jaccard", cutoff: 1.1 },
    })(corpusOf([a]))
  ).toThrow(/cutoff/i);
});

// -------------------------------------------------------------------
// AC: boundary cutoff (score === cutoff) merges
// -------------------------------------------------------------------
it("similarity mode merges when score equals cutoff (>=, boundary inclusive)", () => {
  // "a b" and "b c": tokens {a,b} vs {b,c}, inter=1, union=3, jaccard=1/3 ≈ 0.333
  const p = mk("p", "a b", T0);
  const q = mk("q", "b c", T0 + DAY);
  // Set cutoff to exactly 1/3
  const cutoff = 1 / 3;
  const out = oplusDedupe("rule_weighted_avg", undefined, {
    similarity: { fn: "jaccard", cutoff },
  })(corpusOf([p, q]));
  // Score equals cutoff — should merge
  expect(out.claims).toHaveLength(1);
});

// -------------------------------------------------------------------
// AC: max rules still return the true winner (not the representative-by-time)
// -------------------------------------------------------------------
it("similarity mode with max_mean returns the true max-mean winner within a similarity cluster", () => {
  const strong = mk("a", "power bank from Amazon", T0);
  (strong as any).confidence = { distribution: "beta", parameters: { alpha: 9, beta: 1 }, raw: 0.9 };
  const weak = mk("b", "power bank from Amazon ordered Feb 13", T0 + DAY);
  (weak as any).confidence = { distribution: "beta", parameters: { alpha: 1, beta: 9 }, raw: 0.1 };
  const out = oplusDedupe("rule_max_mean", undefined, {
    similarity: { fn: "jaccard", cutoff: 0.5 },
  })(corpusOf([strong, weak]));
  expect(out.claims).toHaveLength(1);
  // max_mean should pick the one with mean 0.9
  expect(out.claims[0].confidence.parameters).toEqual({ alpha: 9, beta: 1 });
});
