import { clustersOf, derivedPairs, pairsOf } from "./contradiction.js";
import { corpusOf } from "./types.js";
import { RULE } from "../distribution/rules.js";

// Helper for keyAliases tests: creates a claim with a deterministic valueHash from value string
const makeClaim = ({ subject, key, value }: { subject: string; key: string; value: string }) => ({
  id: `${subject}-${key}-${value}`,
  subject,
  key,
  scopeHash: "_",
  valueHash: `vh-${value}`,
  confidence: { distribution: "beta", parameters: { alpha: 9, beta: 1 }, raw: 0.9 },
} as any);

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

// --- DetectionOptions: multi-key exclusion ---

// Helper using cWith for custom key names
const mk = (id: string, key: string, valueHash: string, alpha = 9, beta = 1) =>
  cWith(id, "subject", key, "_", valueHash, alpha, beta);

it("keys declared multi never form clusters even with distinct values", () => {
  const c1 = mk("c1", "hobby", "painting landscapes");
  const c2 = mk("c2", "hobby", "running marathons");
  const clusters = clustersOf(corpusOf([c1, c2]), 0, { keyCardinality: { hobby: "multi" } });
  expect(clusters).toHaveLength(0);
});

it("multi key coexisting with single key: only the single key clusters", () => {
  const hobby1 = mk("h1", "hobby", "painting");
  const hobby2 = mk("h2", "hobby", "running");
  const name1 = mk("n1", "name", "Alice");
  const name2 = mk("n2", "name", "Bob");
  const clusters = clustersOf(
    corpusOf([hobby1, hobby2, name1, name2]),
    0,
    { keyCardinality: { hobby: "multi" } },
  );
  // hobby is multi => no cluster; name is single => 1 cluster
  expect(clusters).toHaveLength(1);
  expect(clusters[0].triple.key).toBe("name");
});

it("threshold 0 admits low-confidence claim to contest high-confidence claim", () => {
  // eff(lowConf) = 0.4/(0.4+0.6) = 0.4; threshold=0 => 0.4 > 0 => admitted
  const lowConf = mk("low", "status", "inactive", 4, 6);   // eff ~ 0.4
  const highConf = mk("high", "status", "active", 9, 1);   // eff ~ 0.9
  const clusters = clustersOf(corpusOf([lowConf, highConf]), 0);
  expect(clusters).toHaveLength(1);
});

it("threshold 0.5 excludes low-confidence claim; no cluster formed", () => {
  const lowConf = mk("low", "status", "inactive", 4, 6);   // eff ~ 0.4
  const highConf = mk("high", "status", "active", 9, 1);   // eff ~ 0.9
  const clusters = clustersOf(corpusOf([lowConf, highConf]), 0.5);
  expect(clusters).toHaveLength(0);
});

it("pairsOf passes opts through to clustersOf", () => {
  const c1 = mk("c1", "hobby", "painting");
  const c2 = mk("c2", "hobby", "running");
  const pairs = pairsOf(corpusOf([c1, c2]), 0, { keyCardinality: { hobby: "multi" } });
  expect(pairs).toHaveLength(0);
});

it("opts omitted: existing contradiction behavior is unchanged", () => {
  // Regression: no opts => behaves as before
  const clusters = clustersOf(corpusOf([c("a", "vh-yes", 9, 1), c("b", "vh-no", 8, 1)]), 0.5);
  expect(clusters).toHaveLength(1);
});

// --- KeyAliases: spec A3 ---

it("aliased keys contest: one pair across editor/preferred_editor", () => {
  const a = makeClaim({ subject: "user", key: "editor", value: "vim" });
  const b = makeClaim({ subject: "user", key: "preferred_editor", value: "emacs" });
  expect(pairsOf(corpusOf([a, b]), 0, { keyAliases: { preferred_editor: "editor" } })).toHaveLength(1);
  expect(pairsOf(corpusOf([a, b]), 0, {})).toHaveLength(0); // absent map = today's behavior
});

it("cluster.triple.key carries the canonical key when aliases are used", () => {
  const a = makeClaim({ subject: "user", key: "editor", value: "vim" });
  const b = makeClaim({ subject: "user", key: "preferred_editor", value: "emacs" });
  const clusters = clustersOf(corpusOf([a, b]), 0, { keyAliases: { preferred_editor: "editor" } });
  expect(clusters).toHaveLength(1);
  expect(clusters[0].triple.key).toBe("editor"); // canonical, not "preferred_editor"
});

it("cardinality multi on canonical key exempts variant-key claims from clustering", () => {
  const a = makeClaim({ subject: "user", key: "editor", value: "vim" });
  const b = makeClaim({ subject: "user", key: "preferred_editor", value: "emacs" });
  const clusters = clustersOf(corpusOf([a, b]), 0, {
    keyAliases: { preferred_editor: "editor" },
    keyCardinality: { editor: "multi" }, // canonical is multi => no cluster
  });
  expect(clusters).toHaveLength(0);
});

it("keyAliases undefined is identical to keyAliases absent", () => {
  const a = makeClaim({ subject: "user", key: "editor", value: "vim" });
  const b = makeClaim({ subject: "user", key: "preferred_editor", value: "emacs" });
  // Without alias map, different stored keys do NOT group together
  const withUndefined = pairsOf(corpusOf([a, b]), 0, { keyAliases: undefined });
  const withOmitted = pairsOf(corpusOf([a, b]), 0, {});
  expect(withUndefined).toHaveLength(0);
  expect(withOmitted).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// evidencePoolingRule: scalar corpora under canonical grouping (sweep finding)
// ---------------------------------------------------------------------------

describe("evidencePoolingRule", () => {
  // The sweep crash shape: dedupe is alias-blind, so same-value claims under
  // DRIFTED keys reach contest un-merged. A contested cluster (>= 2 distinct
  // values) with a multi-claim value group is what pools.
  const scalarClaim = (id: string, key: string, valueHash: string, p: number) => ({
    id,
    subject: "user",
    key,
    scopeHash: "_",
    valueHash,
    confidence: { distribution: "scalar", parameters: { p }, raw: p },
  } as any);
  const sa = scalarClaim("a", "service date", "vh-March 15", 0.8);
  const sb = scalarClaim("b", "car service date", "vh-March 15", 0.9);
  const rival = scalarClaim("r", "service date", "vh-March 16", 0.7);

  it("scalar same-value claims co-located by an alias map pool under max_mean instead of throwing", () => {
    const clusters = clustersOf(corpusOf([sa, sb, rival]), 0, {
      keyAliases: { "car service date": "service date" },
      evidencePoolingRule: RULE.MAX_MEAN,
    });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].combinedConfidences.get("vh-March 15")?.raw).toBe(0.9); // max of the two scalar means
  });

  it("default (absent option) keeps EVIDENCE_POOLED - scalar pooling still throws loudly", () => {
    expect(() =>
      clustersOf(corpusOf([sa, sb, rival]), 0, { keyAliases: { "car service date": "service date" } }),
    ).toThrow(/not supported by the scalar binding/);
  });
});
