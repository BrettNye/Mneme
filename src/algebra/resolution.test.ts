import {
  resolveDeprecateLower,
  resolveKeepBoth,
  resolveFlagForReview,
  resolveDeprecateMinority,
  resolvePromoteConsensus,
} from "./resolution.js";
import { corpusOf } from "./types.js";
import type { ContradictionPair, ContradictionCluster } from "./contradiction.js";

// Minimal claim factory for testing
const makeClaim = (id: string, alpha: number, beta: number, status = "validated") =>
  ({
    id,
    subject: "s",
    key: "s.k",
    scope: {},
    scopeHash: "_",
    value: { text: id },
    valueHash: `vh-${id}`,
    confidence: {
      distribution: "beta",
      parameters: { alpha, beta },
      raw: alpha / (alpha + beta),
    },
    valid: { start: null, end: null },
    recorded: 0,
    recordedSeq: 0,
    status,
    source: "manual",
    provenance: {},
    evidence: [],
    tags: [],
    schema: "v1",
  } as any);

// --- resolveDeprecateLower ---

it("resolveDeprecateLower deprecates the lower-point-estimate claim", () => {
  const hi = makeClaim("a", 9, 1);
  const lo = makeClaim("b", 1, 9);
  const pair = { left: hi, right: lo, conflictReason: "value-difference" } as ContradictionPair;
  const out = resolveDeprecateLower([pair])(corpusOf([hi, lo]));
  expect(out.claims.find((c) => c.id === "b")?.status).toBe("deprecated");
  expect(out.claims.find((c) => c.id === "a")?.status).toBe("validated");
});

it("resolveDeprecateLower with tie deprecates the lexicographically-higher id", () => {
  // alpha=5, beta=5 => point estimate = 0.5 for both
  const claimA = makeClaim("aaa", 5, 5);
  const claimB = makeClaim("bbb", 5, 5);
  const pair = { left: claimA, right: claimB, conflictReason: "value-difference" } as ContradictionPair;
  const out = resolveDeprecateLower([pair])(corpusOf([claimA, claimB]));
  // "bbb" > "aaa" lexicographically, so "bbb" should be deprecated
  expect(out.claims.find((c) => c.id === "bbb")?.status).toBe("deprecated");
  expect(out.claims.find((c) => c.id === "aaa")?.status).toBe("validated");
});

it("resolveDeprecateLower does not mutate stored confidence parameters", () => {
  const hi = makeClaim("a", 9, 1);
  const lo = makeClaim("b", 1, 9);
  const originalAlpha = hi.confidence.parameters.alpha;
  const pair = { left: hi, right: lo, conflictReason: "value-difference" } as ContradictionPair;
  resolveDeprecateLower([pair])(corpusOf([hi, lo]));
  expect(hi.confidence.parameters.alpha).toBe(originalAlpha);
});

it("resolveDeprecateLower handles multiple pairs", () => {
  const a = makeClaim("a", 9, 1); // 0.9 - higher
  const b = makeClaim("b", 1, 9); // 0.1 - lower => deprecated
  const c = makeClaim("c", 7, 3); // 0.7 - higher
  const d = makeClaim("d", 3, 7); // 0.3 - lower => deprecated
  const pairs = [
    { left: a, right: b, conflictReason: "value-difference" } as ContradictionPair,
    { left: c, right: d, conflictReason: "value-difference" } as ContradictionPair,
  ];
  const out = resolveDeprecateLower(pairs)(corpusOf([a, b, c, d]));
  expect(out.claims.find((cl) => cl.id === "b")?.status).toBe("deprecated");
  expect(out.claims.find((cl) => cl.id === "d")?.status).toBe("deprecated");
  expect(out.claims.find((cl) => cl.id === "a")?.status).toBe("validated");
  expect(out.claims.find((cl) => cl.id === "c")?.status).toBe("validated");
});

// --- resolveKeepBoth ---

it("resolveKeepBoth is identity (both claims remain unchanged)", () => {
  const hi = makeClaim("a", 9, 1);
  const lo = makeClaim("b", 1, 9);
  const pair = { left: hi, right: lo, conflictReason: "value-difference" } as ContradictionPair;
  const corpus = corpusOf([hi, lo]);
  const out = resolveKeepBoth([pair])(corpus);
  expect(out.claims).toHaveLength(2);
  expect(out.claims.find((c) => c.id === "a")?.status).toBe("validated");
  expect(out.claims.find((c) => c.id === "b")?.status).toBe("validated");
});

it("resolveKeepBoth returns equal corpus (no mutation)", () => {
  const hi = makeClaim("a", 9, 1);
  const lo = makeClaim("b", 1, 9);
  const pair = { left: hi, right: lo, conflictReason: "value-difference" } as ContradictionPair;
  const corpus = corpusOf([hi, lo]);
  const out = resolveKeepBoth([pair])(corpus);
  expect(out.claims.length).toBe(corpus.claims.length);
  expect(out.claims.every((cl, i) => cl.id === corpus.claims[i].id)).toBe(true);
});

// --- resolveFlagForReview ---

it("resolveFlagForReview adds exactly one artifact claim per pair", () => {
  const hi = makeClaim("a", 9, 1);
  const lo = makeClaim("b", 1, 9);
  const pair = { left: hi, right: lo, conflictReason: "value-difference" } as ContradictionPair;
  const corpus = corpusOf([hi, lo]);
  const out = resolveFlagForReview([pair])(corpus);
  expect(out.claims).toHaveLength(3); // original 2 + 1 artifact
});

it("resolveFlagForReview leaves original claims unchanged", () => {
  const hi = makeClaim("a", 9, 1);
  const lo = makeClaim("b", 1, 9);
  const pair = { left: hi, right: lo, conflictReason: "value-difference" } as ContradictionPair;
  const corpus = corpusOf([hi, lo]);
  const out = resolveFlagForReview([pair])(corpus);
  expect(out.claims.find((c) => c.id === "a")?.status).toBe("validated");
  expect(out.claims.find((c) => c.id === "b")?.status).toBe("validated");
});

it("resolveFlagForReview artifact has subject 'contradiction' and references both claim ids", () => {
  const hi = makeClaim("a", 9, 1);
  const lo = makeClaim("b", 1, 9);
  const pair = { left: hi, right: lo, conflictReason: "value-difference" } as ContradictionPair;
  const corpus = corpusOf([hi, lo]);
  const out = resolveFlagForReview([pair])(corpus);
  const artifact = out.claims.find((c) => c.subject === "contradiction");
  expect(artifact).toBeDefined();
  expect(artifact!.key).toBe("contradiction.flag");
  // value should reference both ids
  const valueStr = JSON.stringify(artifact!.value);
  expect(valueStr).toContain("a");
  expect(valueStr).toContain("b");
});

it("resolveFlagForReview with multiple pairs adds one artifact per pair", () => {
  const a = makeClaim("a", 9, 1);
  const b = makeClaim("b", 1, 9);
  const c = makeClaim("c", 7, 3);
  const d = makeClaim("d", 3, 7);
  const pairs = [
    { left: a, right: b, conflictReason: "value-difference" } as ContradictionPair,
    { left: c, right: d, conflictReason: "value-difference" } as ContradictionPair,
  ];
  const corpus = corpusOf([a, b, c, d]);
  const out = resolveFlagForReview(pairs)(corpus);
  expect(out.claims).toHaveLength(6); // 4 original + 2 artifacts
  const artifacts = out.claims.filter((cl) => cl.subject === "contradiction");
  expect(artifacts).toHaveLength(2);
});

it("resolveFlagForReview artifact has a fresh unique id", () => {
  const a = makeClaim("a", 9, 1);
  const b = makeClaim("b", 1, 9);
  const pair = { left: a, right: b, conflictReason: "value-difference" } as ContradictionPair;
  const corpus = corpusOf([a, b]);
  const out1 = resolveFlagForReview([pair])(corpus);
  const out2 = resolveFlagForReview([pair])(corpus);
  const artifact1 = out1.claims.find((c) => c.subject === "contradiction");
  const artifact2 = out2.claims.find((c) => c.subject === "contradiction");
  expect(artifact1!.id).toBeDefined();
  expect(artifact2!.id).toBeDefined();
  // Each call should get a fresh id (uuid)
  expect(artifact1!.id).not.toBe(artifact2!.id);
});

// --- resolveDeprecateMinority ---

const makeCluster = (
  valueGroups: Map<string, any[]>
): ContradictionCluster => {
  const allClaims = Array.from(valueGroups.values()).flat();
  let totalClaims = 0;
  let largestGroupSize = 0;
  for (const claims of valueGroups.values()) {
    totalClaims += claims.length;
    if (claims.length > largestGroupSize) largestGroupSize = claims.length;
  }
  return {
    triple: { subject: "s", key: "s.k", scopeHash: "_" },
    valueGroups,
    totalClaims,
    distinctValues: valueGroups.size,
    agreementRatio: largestGroupSize / totalClaims,
    combinedConfidences: new Map(),
  } as ContradictionCluster;
};

it("resolveDeprecateMinority deprecates claims outside the largest value group", () => {
  const a1 = makeClaim("a1", 9, 1);
  const a2 = makeClaim("a2", 9, 1);
  const b1 = makeClaim("b1", 8, 1);

  const vg = new Map<string, any[]>();
  vg.set("vh-a", [a1, a2]); // 2 claims => largest
  vg.set("vh-b", [b1]);     // 1 claim => minority

  const cluster = makeCluster(vg);
  const corpus = corpusOf([a1, a2, b1]);
  const out = resolveDeprecateMinority([cluster])(corpus);

  expect(out.claims.find((c) => c.id === "b1")?.status).toBe("deprecated");
  expect(out.claims.find((c) => c.id === "a1")?.status).toBe("validated");
  expect(out.claims.find((c) => c.id === "a2")?.status).toBe("validated");
});

it("resolveDeprecateMinority with 3-way split: minority two groups deprecated, majority untouched", () => {
  const a1 = makeClaim("a1", 9, 1);
  const a2 = makeClaim("a2", 9, 1);
  const a3 = makeClaim("a3", 9, 1);
  const b1 = makeClaim("b1", 8, 1);
  const c1 = makeClaim("c1", 7, 1);

  const vg = new Map<string, any[]>();
  vg.set("vh-a", [a1, a2, a3]); // 3 => largest
  vg.set("vh-b", [b1]);          // 1 => minority
  vg.set("vh-c", [c1]);          // 1 => minority

  const cluster = makeCluster(vg);
  const corpus = corpusOf([a1, a2, a3, b1, c1]);
  const out = resolveDeprecateMinority([cluster])(corpus);

  expect(out.claims.find((c) => c.id === "b1")?.status).toBe("deprecated");
  expect(out.claims.find((c) => c.id === "c1")?.status).toBe("deprecated");
  expect(out.claims.find((c) => c.id === "a1")?.status).toBe("validated");
  expect(out.claims.find((c) => c.id === "a2")?.status).toBe("validated");
  expect(out.claims.find((c) => c.id === "a3")?.status).toBe("validated");
});

it("resolveDeprecateMinority does not mutate confidence parameters", () => {
  const a1 = makeClaim("a1", 9, 1);
  const b1 = makeClaim("b1", 8, 1);
  const originalAlpha = b1.confidence.parameters.alpha;

  const vg = new Map<string, any[]>();
  vg.set("vh-a", [a1]);
  vg.set("vh-b", [b1]);

  const cluster = makeCluster(vg);
  const corpus = corpusOf([a1, b1]);
  resolveDeprecateMinority([cluster])(corpus);
  expect(b1.confidence.parameters.alpha).toBe(originalAlpha);
});

// --- resolvePromoteConsensus ---

it("resolvePromoteConsensus deprecates minority and validates the largest group", () => {
  const a1 = makeClaim("a1", 9, 1, "candidate");
  const a2 = makeClaim("a2", 9, 1, "candidate");
  const b1 = makeClaim("b1", 8, 1, "candidate");

  const vg = new Map<string, any[]>();
  vg.set("vh-a", [a1, a2]); // 2 => largest => should become validated
  vg.set("vh-b", [b1]);     // 1 => minority => should become deprecated

  const cluster = makeCluster(vg);
  const corpus = corpusOf([a1, a2, b1]);
  const out = resolvePromoteConsensus([cluster])(corpus);

  expect(out.claims.find((c) => c.id === "b1")?.status).toBe("deprecated");
  expect(out.claims.find((c) => c.id === "a1")?.status).toBe("validated");
  expect(out.claims.find((c) => c.id === "a2")?.status).toBe("validated");
});

it("resolvePromoteConsensus does not mutate confidence parameters", () => {
  const a1 = makeClaim("a1", 9, 1, "candidate");
  const b1 = makeClaim("b1", 8, 1, "candidate");
  const originalAlpha = a1.confidence.parameters.alpha;

  const vg = new Map<string, any[]>();
  vg.set("vh-a", [a1]);
  vg.set("vh-b", [b1]);

  const cluster = makeCluster(vg);
  const corpus = corpusOf([a1, b1]);
  resolvePromoteConsensus([cluster])(corpus);
  expect(a1.confidence.parameters.alpha).toBe(originalAlpha);
});

it("resolvePromoteConsensus with 3-way split promotes majority and deprecates all minorities", () => {
  const a1 = makeClaim("a1", 9, 1, "candidate");
  const a2 = makeClaim("a2", 9, 1, "candidate");
  const a3 = makeClaim("a3", 9, 1, "candidate");
  const b1 = makeClaim("b1", 8, 1, "candidate");
  const c1 = makeClaim("c1", 7, 1, "candidate");

  const vg = new Map<string, any[]>();
  vg.set("vh-a", [a1, a2, a3]); // 3 => largest
  vg.set("vh-b", [b1]);          // 1 => minority
  vg.set("vh-c", [c1]);          // 1 => minority

  const cluster = makeCluster(vg);
  const corpus = corpusOf([a1, a2, a3, b1, c1]);
  const out = resolvePromoteConsensus([cluster])(corpus);

  expect(out.claims.find((c) => c.id === "b1")?.status).toBe("deprecated");
  expect(out.claims.find((c) => c.id === "c1")?.status).toBe("deprecated");
  expect(out.claims.find((c) => c.id === "a1")?.status).toBe("validated");
  expect(out.claims.find((c) => c.id === "a2")?.status).toBe("validated");
  expect(out.claims.find((c) => c.id === "a3")?.status).toBe("validated");
});
