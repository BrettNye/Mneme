import { clustersOf, derivedPairs, pairsOf } from "./contradiction.js";
import { corpusOf } from "./types.js";

// Helper to create a minimal claim for testing
const c = (id: string, valueHash: string, alpha: number, beta: number) => ({
  id, subject: "s", key: "s.k", scopeHash: "_", valueHash,
  confidence: { distribution: "beta", parameters: { alpha, beta }, raw: alpha / (alpha + beta) },
} as any);

// Variant with different subject/key/scope for grouping tests
const cWith = (
  id: string,
  subject: string,
  key: string,
  scopeHash: string,
  valueHash: string,
  alpha: number,
  beta: number
) => ({
  id, subject, key, scopeHash, valueHash,
  confidence: { distribution: "beta", parameters: { alpha, beta }, raw: alpha / (alpha + beta) },
} as any);

// --- Provided acceptance test ---
it("a triple with two distinct high-confidence values forms one cluster", () => {
  const clusters = clustersOf(corpusOf([c("a", "vh-yes", 9, 1), c("b", "vh-no", 8, 1)]), 0.5);
  expect(clusters).toHaveLength(1);
  expect(clusters[0].distinctValues).toBe(2);
});

// --- Acceptance criteria: single-value triple forms no cluster ---
it("a triple with only one distinct value forms no cluster (consensus)", () => {
  const clusters = clustersOf(corpusOf([c("a", "vh-yes", 9, 1), c("b", "vh-yes", 8, 1)]), 0.5);
  expect(clusters).toHaveLength(0);
});

// --- Acceptance criteria: agreementRatio ---
it("agreementRatio = largestGroupSize / totalClaims for a 3-way split", () => {
  // 3 for A, 1 for B, 1 for C => total=5, largest=3, ratio=0.6
  const claims = [
    c("a1", "vh-a", 9, 1),
    c("a2", "vh-a", 9, 1),
    c("a3", "vh-a", 9, 1),
    c("b1", "vh-b", 9, 1),
    c("c1", "vh-c", 9, 1),
  ];
  const clusters = clustersOf(corpusOf(claims), 0.5);
  expect(clusters).toHaveLength(1);
  expect(clusters[0].distinctValues).toBe(3);
  expect(clusters[0].totalClaims).toBe(5);
  expect(clusters[0].agreementRatio).toBeCloseTo(0.6);
});

// --- Acceptance criteria: combinedConfidences pools via EVIDENCE_POOLED ---
it("combinedConfidences pools two agreeing Beta(3,2) claims to Beta(5,3)", () => {
  // Two claims with same valueHash vh-yes, Beta(3,2) each
  // EVIDENCE_POOLED: alpha = 3+3-1 = 5, beta = 2+2-1 = 3
  const claims = [
    c("a", "vh-yes", 3, 2),
    c("b", "vh-yes", 3, 2),
    c("x", "vh-no", 9, 1), // creates contradiction
  ];
  const clusters = clustersOf(corpusOf(claims), 0.5);
  expect(clusters).toHaveLength(1);
  const pooled = clusters[0].combinedConfidences.get("vh-yes");
  expect(pooled).toBeDefined();
  expect(pooled!.distribution).toBe("beta");
  expect(pooled!.parameters).toEqual({ alpha: 5, beta: 3 });
});

// --- Acceptance criteria: highestConfidenceGroup ---
it("highestConfidenceGroup is the value with the highest pooled point estimate", () => {
  // vh-yes: Beta(9,1) => mean = 0.9, vh-no: Beta(3,7) => mean = 0.3
  const claims = [c("a", "vh-yes", 9, 1), c("b", "vh-no", 3, 7)];
  const clusters = clustersOf(corpusOf(claims), 0.1);
  expect(clusters).toHaveLength(1);
  expect(clusters[0].highestConfidenceGroup).toBe("vh-yes");
});

// --- Acceptance criteria: pairsOf equals derivedPairs(clustersOf) ---
it("pairsOf equals derivedPairs(clustersOf)", () => {
  const corpus = corpusOf([c("a", "vh-yes", 9, 1), c("b", "vh-no", 8, 1)]);
  const threshold = 0.5;
  const via_pairs = pairsOf(corpus, threshold);
  const via_derived = derivedPairs(clustersOf(corpus, threshold));
  expect(via_pairs).toHaveLength(via_derived.length);
  // compare IDs
  const ids = (pairs: typeof via_pairs) =>
    pairs.map(p => [p.left.id, p.right.id].sort().join("|")).sort();
  expect(ids(via_pairs)).toEqual(ids(via_derived));
});

// --- Acceptance criteria: binary cluster yields exactly one pair with conflictReason: "value-difference" ---
it("a binary cluster yields exactly one pair with conflictReason value-difference", () => {
  const corpus = corpusOf([c("a", "vh-yes", 9, 1), c("b", "vh-no", 8, 1)]);
  const pairs = pairsOf(corpus, 0.5);
  expect(pairs).toHaveLength(1);
  expect(pairs[0].conflictReason).toBe("value-difference");
});

// --- Acceptance criteria: below-threshold claims are excluded ---
it("below-threshold claims do not participate in detection", () => {
  // eff = alpha/(alpha+beta) = 1/10 = 0.1, threshold = 0.5 => excluded
  const lowConf = c("low", "vh-no", 1, 9);
  const highConf = c("high", "vh-yes", 9, 1);
  const clusters = clustersOf(corpusOf([lowConf, highConf]), 0.5);
  // lowConf has eff=0.1 <= 0.5, so excluded; only one distinct value group => no cluster
  expect(clusters).toHaveLength(0);
});

// --- Acceptance criteria: selection commutes ---
it("clustersOf on a filtered corpus contains only clusters whose claims are all present", () => {
  // Mix two separate triples. Filter one out at corpus level, clustersOf should not show it.
  const claims = [
    cWith("a", "s1", "k1", "scope1", "vh-yes", 9, 1),
    cWith("b", "s1", "k1", "scope1", "vh-no", 8, 1),
    cWith("c", "s2", "k2", "scope2", "vh-x", 9, 1),
    cWith("d", "s2", "k2", "scope2", "vh-y", 8, 1),
  ];
  // Corpus with only s1 triple
  const filtered = corpusOf(claims.filter(cl => cl.subject === "s1"));
  const clusters = clustersOf(filtered, 0.5);
  expect(clusters).toHaveLength(1);
  // Ensure the cluster is about s1/k1/scope1
  expect(clusters[0].triple.subject).toBe("s1");
});

// --- Cross-group pairs: two distinct values with multiple claims each ---
it("a cluster with 2 values and 2 claims each emits 4 cross-group pairs", () => {
  // vh-a: 2 claims, vh-b: 2 claims => 2*2 = 4 cross-group pairs
  const claims = [
    c("a1", "vh-a", 9, 1),
    c("a2", "vh-a", 9, 1),
    c("b1", "vh-b", 8, 1),
    c("b2", "vh-b", 8, 1),
  ];
  const pairs = pairsOf(corpusOf(claims), 0.5);
  expect(pairs).toHaveLength(4);
  expect(pairs.every(p => p.conflictReason === "value-difference")).toBe(true);
});

// --- Triple grouping: different subject/key/scope produce separate triples/clusters ---
it("different triples produce separate clusters", () => {
  const claims = [
    cWith("a", "s1", "k1", "scope1", "vh-yes", 9, 1),
    cWith("b", "s1", "k1", "scope1", "vh-no", 8, 1),
    cWith("c", "s2", "k2", "scope2", "vh-x", 9, 1),
    cWith("d", "s2", "k2", "scope2", "vh-y", 8, 1),
  ];
  const clusters = clustersOf(corpusOf(claims), 0.5);
  expect(clusters).toHaveLength(2);
});

// --- valueGroups map is correct ---
it("valueGroups maps each valueHash to its claims", () => {
  const claims = [c("a", "vh-yes", 9, 1), c("b", "vh-no", 8, 1)];
  const clusters = clustersOf(corpusOf(claims), 0.5);
  expect(clusters).toHaveLength(1);
  const cluster = clusters[0];
  expect(cluster.valueGroups.size).toBe(2);
  expect(cluster.valueGroups.get("vh-yes")?.map(cl => cl.id)).toEqual(["a"]);
  expect(cluster.valueGroups.get("vh-no")?.map(cl => cl.id)).toEqual(["b"]);
});

// --- combinedConfidences raw equals mean of pooled params ---
it("combinedConfidences raw equals mean of pooled parameters", () => {
  const claims = [
    c("a", "vh-yes", 9, 1),
    c("x", "vh-no", 8, 1),
  ];
  const clusters = clustersOf(corpusOf(claims), 0.5);
  const pooled = clusters[0].combinedConfidences.get("vh-yes");
  expect(pooled).toBeDefined();
  // single claim, no folding: raw = alpha/(alpha+beta) = 9/10 = 0.9
  expect(pooled!.raw).toBeCloseTo(0.9);
});
