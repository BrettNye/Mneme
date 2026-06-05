import {
  resolveDeprecateLower,
  resolveDeprecateOlder,
  resolveKeepBoth,
  resolveFlagForReview,
  resolveDeprecateMinority,
  resolvePromoteConsensus,
  CONTRADICTION_FLAG_KEY,
} from "./resolution.js";
import { corpusOf } from "./types.js";
import type { ContradictionPair, ContradictionCluster } from "./contradiction.js";

// Minimal claim factory for testing
// alpha/beta control confidence pointEstimate; fromTs sets valid.from for recency tests
const makeClaim = (id: string, alpha: number, beta: number, status = "validated", fromTs = 0) =>
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
    valid: { from: fromTs, to: Infinity },
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

it("resolveDeprecateLower with tie keeps both claims and adds one flag artifact", () => {
  const claimA = makeClaim("claim-aaa", 5, 5, "validated"); // equal pointEstimate
  const claimB = makeClaim("claim-bbb", 5, 5, "validated");
  const out = resolveDeprecateLower([{ left: claimA, right: claimB, conflictReason: "value-difference" }])(
    corpusOf([claimA, claimB]),
  );
  const statuses = out.claims.filter((c) => c.key !== CONTRADICTION_FLAG_KEY).map((c) => c.status);
  expect(statuses).toEqual(["validated", "validated"]); // neither deprecated
  expect(out.claims.filter((c) => c.key === CONTRADICTION_FLAG_KEY)).toHaveLength(1);
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

it("resolveFlagForReview artifact has subject 'contradiction', CONTRADICTION_FLAG_KEY, and references both claim ids", () => {
  const hi = makeClaim("a", 9, 1);
  const lo = makeClaim("b", 1, 9);
  const pair = { left: hi, right: lo, conflictReason: "value-difference" } as ContradictionPair;
  const corpus = corpusOf([hi, lo]);
  const out = resolveFlagForReview([pair])(corpus);
  const artifact = out.claims.find((c) => c.key === CONTRADICTION_FLAG_KEY);
  expect(artifact).toBeDefined();
  expect(artifact!.subject).toBe("contradiction");
  expect(artifact!.key).toBe(CONTRADICTION_FLAG_KEY);
  expect(artifact!.status).toBe("candidate");
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
  const artifacts = out.claims.filter((cl) => cl.key === CONTRADICTION_FLAG_KEY);
  expect(artifacts).toHaveLength(2);
});

it("resolveFlagForReview artifact has a fresh unique id", () => {
  const a = makeClaim("a", 9, 1);
  const b = makeClaim("b", 1, 9);
  const pair = { left: a, right: b, conflictReason: "value-difference" } as ContradictionPair;
  const corpus = corpusOf([a, b]);
  const out1 = resolveFlagForReview([pair])(corpus);
  const out2 = resolveFlagForReview([pair])(corpus);
  const artifact1 = out1.claims.find((c) => c.key === CONTRADICTION_FLAG_KEY);
  const artifact2 = out2.claims.find((c) => c.key === CONTRADICTION_FLAG_KEY);
  expect(artifact1!.id).toBeDefined();
  expect(artifact2!.id).toBeDefined();
  // Each call should get a fresh id (uuid)
  expect(artifact1!.id).not.toBe(artifact2!.id);
});

// --- resolveDeprecateOlder ---

it("resolveDeprecateOlder deprecates the claim with earlier valid.from", () => {
  const older = makeClaim("older", 5, 5, "validated", 1000);
  const newer = makeClaim("newer", 5, 5, "validated", 2000);
  const pair = { left: older, right: newer, conflictReason: "value-difference" } as ContradictionPair;
  const out = resolveDeprecateOlder([pair])(corpusOf([older, newer]));
  expect(out.claims.find((c) => c.id === "older")?.status).toBe("deprecated");
  expect(out.claims.find((c) => c.id === "newer")?.status).toBe("validated");
});

it("resolveDeprecateOlder: later valid.from survives (right is older)", () => {
  const newer = makeClaim("newer", 5, 5, "validated", 5000);
  const older = makeClaim("older", 5, 5, "validated", 3000);
  const pair = { left: newer, right: older, conflictReason: "value-difference" } as ContradictionPair;
  const out = resolveDeprecateOlder([pair])(corpusOf([newer, older]));
  expect(out.claims.find((c) => c.id === "older")?.status).toBe("deprecated");
  expect(out.claims.find((c) => c.id === "newer")?.status).toBe("validated");
});

it("resolveDeprecateOlder: 3-way chain leaves only the newest claim live", () => {
  // A(from=100) < B(from=200) < C(from=300)
  const a = makeClaim("a", 5, 5, "validated", 100);
  const b = makeClaim("b", 5, 5, "validated", 200);
  const c = makeClaim("c", 5, 5, "validated", 300);
  const pairs = [
    { left: a, right: b, conflictReason: "value-difference" } as ContradictionPair,
    { left: b, right: c, conflictReason: "value-difference" } as ContradictionPair,
    { left: a, right: c, conflictReason: "value-difference" } as ContradictionPair,
  ];
  const out = resolveDeprecateOlder(pairs)(corpusOf([a, b, c]));
  expect(out.claims.find((cl) => cl.id === "a")?.status).toBe("deprecated");
  expect(out.claims.find((cl) => cl.id === "b")?.status).toBe("deprecated");
  expect(out.claims.find((cl) => cl.id === "c")?.status).toBe("validated");
});

it("resolveDeprecateOlder: exact valid.from tie keeps both and adds one flag artifact", () => {
  const claimA = makeClaim("tie-a", 5, 5, "validated", 1000);
  const claimB = makeClaim("tie-b", 5, 5, "validated", 1000);
  const out = resolveDeprecateOlder([{ left: claimA, right: claimB, conflictReason: "value-difference" }])(
    corpusOf([claimA, claimB]),
  );
  const statuses = out.claims.filter((c) => c.key !== CONTRADICTION_FLAG_KEY).map((c) => c.status);
  expect(statuses).toEqual(["validated", "validated"]); // neither deprecated
  expect(out.claims.filter((c) => c.key === CONTRADICTION_FLAG_KEY)).toHaveLength(1);
});

it("resolveDeprecateOlder: immutability — input corpus unchanged after call", () => {
  const older = makeClaim("older", 5, 5, "validated", 1000);
  const newer = makeClaim("newer", 5, 5, "validated", 2000);
  const input = corpusOf([older, newer]);
  const beforeStatuses = input.claims.map((c) => c.status);
  resolveDeprecateOlder([{ left: older, right: newer, conflictReason: "value-difference" }])(input);
  const afterStatuses = input.claims.map((c) => c.status);
  expect(afterStatuses).toEqual(beforeStatuses);
});

// --- Mixed pairs property test: artifact count == tied-surviving pairs ---

// Setup for the mixed-pair property test
// 4 pairs: (A,B) decided (A is newer); (C,D) decided (C is newer);
// (E,F) tied (both survive) => 1 artifact;
// (B,G) tied but B was deprecated by (A,B) pair => NO artifact.
const a = makeClaim("mixed-a", 5, 5, "validated", 2000);
const b = makeClaim("mixed-b", 5, 5, "validated", 1000); // older than A => deprecated
const c = makeClaim("mixed-c", 5, 5, "validated", 4000);
const d = makeClaim("mixed-d", 5, 5, "validated", 3000); // older than C => deprecated
const e = makeClaim("mixed-e", 5, 5, "validated", 5000);
const f = makeClaim("mixed-f", 5, 5, "validated", 5000); // same from as E => tied
const g = makeClaim("mixed-g", 5, 5, "validated", 5000); // same from as B => tied with B

const mixedPairs: ContradictionPair[] = [
  { left: a, right: b, conflictReason: "value-difference" }, // decided: B loses
  { left: c, right: d, conflictReason: "value-difference" }, // decided: D loses
  { left: e, right: f, conflictReason: "value-difference" }, // tied: both survive => 1 artifact
  { left: b, right: g, conflictReason: "value-difference" }, // tied but B already deprecated => NO artifact
];

it("emits artifacts only for tied-surviving pairs across a mixed pair set", () => {
  const out = resolveDeprecateOlder(mixedPairs)(corpusOf([a, b, c, d, e, f, g]));
  expect(out.claims.filter((cl) => cl.key === CONTRADICTION_FLAG_KEY)).toHaveLength(1);
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
