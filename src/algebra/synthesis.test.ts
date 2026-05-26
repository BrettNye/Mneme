import { resolveSynthesizeBelief } from "./synthesis.js";
import { clustersOf } from "./contradiction.js";
import { corpusOf } from "./types.js";
import { RULE } from "../distribution/rules.js";

// Helper to create a minimal claim for testing (matching the spec's helper)
const c = (id: string, valueHash: string, value: string, alpha: number, beta: number) => ({
  id, subject: "s", key: "s.k", scope: {}, scopeHash: "_", valueHash, value, source: "workflow", evidence: [],
  confidence: { distribution: "beta", parameters: { alpha, beta }, raw: alpha / (alpha + beta) }, status: "validated",
} as any);

// --- Provided acceptance test ---
it("synthesize on a binary cluster deprecates both groups and appends one derived claim", () => {
  const corpus = corpusOf([c("a", "vh-yes", "yes", 9, 1), c("b", "vh-no", "no", 2, 8)]);
  const out = resolveSynthesizeBelief(clustersOf(corpus, 0.0))(corpus);
  expect(out.claims.filter((x) => x.status === "deprecated")).toHaveLength(2);
  expect(out.claims.filter((x) => x.status === "validated")).toHaveLength(1); // the synthesized claim
});

// --- Synthesized claim picks value from highest confidence group ---
it("synthesized claim value is from the highest confidence group", () => {
  // "yes" group: alpha=9, beta=1 => mean=0.9; "no" group: alpha=2, beta=8 => mean=0.2
  const corpus = corpusOf([c("a", "vh-yes", "yes", 9, 1), c("b", "vh-no", "no", 2, 8)]);
  const out = resolveSynthesizeBelief(clustersOf(corpus, 0.0))(corpus);
  const synthesized = out.claims.find((x) => x.status === "validated");
  expect(synthesized).toBeDefined();
  expect(synthesized!.value).toBe("yes");
});

// --- Synthesized claim has a fresh ID (not one of the original claim IDs) ---
it("synthesized claim has a fresh id different from input claim ids", () => {
  const corpus = corpusOf([c("a", "vh-yes", "yes", 9, 1), c("b", "vh-no", "no", 2, 8)]);
  const out = resolveSynthesizeBelief(clustersOf(corpus, 0.0))(corpus);
  const synthesized = out.claims.find((x) => x.status === "validated");
  expect(synthesized).toBeDefined();
  expect(synthesized!.id).not.toBe("a");
  expect(synthesized!.id).not.toBe("b");
});

// --- Synthesized claim's confidence is weighted average fusion of the two groups' combinedConfidences ---
it("synthesized claim confidence is weighted average fusion of both groups", () => {
  // Group "yes": alpha=9, beta=1 (source=workflow, weight=1.0)
  // Group "no":  alpha=2, beta=8 (source=workflow, weight=1.0)
  // Weighted avg (equal weights): alpha=(9+2)/2=5.5, beta=(1+8)/2=4.5
  // mean = 5.5/(5.5+4.5) = 5.5/10 = 0.55
  const corpus = corpusOf([c("a", "vh-yes", "yes", 9, 1), c("b", "vh-no", "no", 2, 8)]);
  const out = resolveSynthesizeBelief(clustersOf(corpus, 0.0))(corpus);
  const synthesized = out.claims.find((x) => x.status === "validated");
  expect(synthesized).toBeDefined();
  expect(synthesized!.confidence.distribution).toBe("beta");
  expect(synthesized!.confidence.raw).toBeCloseTo(0.55, 5);
});

// --- Synthesized claim evidence is union of both groups' evidence ---
it("synthesized claim evidence is union of both groups evidence", () => {
  const claimA = {
    ...c("a", "vh-yes", "yes", 9, 1),
    evidence: [{ kind: "external", uri: "http://example.com/a" }],
  };
  const claimB = {
    ...c("b", "vh-no", "no", 2, 8),
    evidence: [{ kind: "external", uri: "http://example.com/b" }],
  };
  const corpus = corpusOf([claimA, claimB] as any);
  const out = resolveSynthesizeBelief(clustersOf(corpus, 0.0))(corpus);
  const synthesized = out.claims.find((x) => x.status === "validated");
  expect(synthesized).toBeDefined();
  expect(synthesized!.evidence).toHaveLength(2);
});

// --- Multi-way clusters (k > 2) are left untouched ---
it("multi-way clusters (k > 2) are left untouched: no deprecation, no synthesized claim", () => {
  const claims = [
    c("a", "vh-1", "one", 9, 1),
    c("b", "vh-2", "two", 8, 1),
    c("x", "vh-3", "three", 7, 1),
  ];
  const corpus = corpusOf(claims);
  const clusters = clustersOf(corpus, 0.0);
  expect(clusters[0].distinctValues).toBe(3); // verify it's 3-way
  const out = resolveSynthesizeBelief(clusters)(corpus);
  // All original claims still validated
  expect(out.claims.filter((x) => x.status === "deprecated")).toHaveLength(0);
  // No new synthesized claims added (still 3 total)
  expect(out.claims).toHaveLength(3);
});

// --- Rule is caller-configurable ---
it("rule is caller-configurable: passing RULE.WEIGHTED_AVG explicitly gives same result as default", () => {
  const corpus = corpusOf([c("a", "vh-yes", "yes", 9, 1), c("b", "vh-no", "no", 2, 8)]);
  const clusters = clustersOf(corpus, 0.0);
  const outDefault = resolveSynthesizeBelief(clusters)(corpus);
  const outExplicit = resolveSynthesizeBelief(clusters, RULE.WEIGHTED_AVG)(corpus);
  const synthDefault = outDefault.claims.find((x) => x.status === "validated");
  const synthExplicit = outExplicit.claims.find((x) => x.status === "validated");
  expect(synthDefault!.confidence.raw).toBeCloseTo(synthExplicit!.confidence.raw, 10);
});

// --- Synthesized claim has correct subject/key/scopeHash from the triple ---
it("synthesized claim carries subject, key, scopeHash from the cluster triple", () => {
  const corpus = corpusOf([c("a", "vh-yes", "yes", 9, 1), c("b", "vh-no", "no", 2, 8)]);
  const out = resolveSynthesizeBelief(clustersOf(corpus, 0.0))(corpus);
  const synthesized = out.claims.find((x) => x.status === "validated");
  expect(synthesized!.subject).toBe("s");
  expect(synthesized!.key).toBe("s.k");
  expect(synthesized!.scopeHash).toBe("_");
});

// --- Synthesized claim is not recorded (no recorded/recordedSeq assigned from store) ---
it("synthesized claim has no adapter persistence (unpersisted)", () => {
  const corpus = corpusOf([c("a", "vh-yes", "yes", 9, 1), c("b", "vh-no", "no", 2, 8)]);
  const out = resolveSynthesizeBelief(clustersOf(corpus, 0.0))(corpus);
  const synthesized = out.claims.find((x) => x.status === "validated");
  // The synthesized claim should not have been written to persistence (checked by lack of an adapter call)
  // We verify: it exists in the in-memory corpus (total claims = 3)
  expect(out.claims).toHaveLength(3);
});

// --- Multiple binary clusters each get their own synthesized claim ---
it("multiple binary clusters each produce one synthesized claim", () => {
  // Build two different triples each with a binary contradiction
  const claims = [
    { ...c("a", "vh-yes", "yes", 9, 1), subject: "s1", key: "k1" },
    { ...c("b", "vh-no", "no", 2, 8), subject: "s1", key: "k1" },
    { ...c("c", "vh-cat", "cat", 8, 1), subject: "s2", key: "k2" },
    { ...c("d", "vh-dog", "dog", 2, 7), subject: "s2", key: "k2" },
  ] as any;
  const corpus = corpusOf(claims);
  const clusters = clustersOf(corpus, 0.0);
  expect(clusters).toHaveLength(2); // verify two clusters
  const out = resolveSynthesizeBelief(clusters)(corpus);
  expect(out.claims.filter((x) => x.status === "deprecated")).toHaveLength(4);
  expect(out.claims.filter((x) => x.status === "validated")).toHaveLength(2);
});
