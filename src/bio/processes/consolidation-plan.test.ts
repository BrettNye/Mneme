import { planConsolidation, CONSOLIDATE_WORKFLOW } from "./consolidation-plan.js";
import type { Claim } from "../../core/claim.js";
import type { ClaimId } from "../../core/ids.js";
import { RULE } from "../../distribution/rules.js";
import { resolvePolicy } from "../policy.js";

// ─── helpers ───────────────────────────────────────────────────────────────

function makeClaim(
  id: string,
  opts: {
    subject?: string;
    key?: string;
    scopeHash?: string;
    valueHash?: string;
    status?: Claim["status"];
    alpha?: number;
    beta?: number;
  } = {}
): Claim {
  const {
    subject = "user.alice",
    key = "skill.typescript",
    scopeHash = "sh1",
    valueHash = "vh1",
    status = "candidate",
    alpha = 5,
    beta = 1,
  } = opts;
  return {
    id: id as unknown as ClaimId,
    profile: "p1" as Claim["profile"],
    workspace: "w1" as Claim["workspace"],
    subject,
    key,
    scope: { kind: "global" },
    scopeHash,
    value: { kind: "scalar", v: 0.8 },
    valueHash,
    confidence: { distribution: "beta", parameters: { alpha, beta }, raw: alpha / (alpha + beta) },
    valid: { from: 0, to: Infinity },
    recorded: 1000 as unknown as Claim["recorded"],
    recordedSeq: 1,
    status,
    source: "heuristic",
    provenance: {},
    evidence: [],
    audience: {},
    tags: [],
    schema: "v1",
  };
}

/** Three claims with the same (subject, key, scopeHash, valueHash) — eligible for folding */
function threeAgreeingClaims(): Claim[] {
  return [
    makeClaim("c1", { alpha: 5, beta: 1 }),
    makeClaim("c2", { alpha: 5, beta: 1 }),
    makeClaim("c3", { alpha: 5, beta: 1 }),
  ];
}

const DEFAULT_POL = resolvePolicy().consolidation;

// ─── fold threshold: groups of K fold, groups of K-1 do NOT ───────────────

it("folds a group of K agreeing claims into one derive + K deprecations", () => {
  const ops = planConsolidation(threeAgreeingClaims(), DEFAULT_POL, 1000 as any);
  expect(ops.filter((o) => o.kind === "derive")).toHaveLength(1);
  expect(ops.filter((o) => o.kind === "promote" && o.to === "deprecated")).toHaveLength(3);
});

it("does NOT fold a group of K-1 claims (below threshold)", () => {
  const twoClaims = [makeClaim("c1"), makeClaim("c2")]; // K=3, so 2 < K
  const ops = planConsolidation(twoClaims, DEFAULT_POL, 1000 as any);
  expect(ops.filter((o) => o.kind === "derive")).toHaveLength(0);
  expect(ops.filter((o) => o.kind === "promote" && o.to === "deprecated")).toHaveLength(0);
});

// ─── bug_010: mixed confidence distributions never fold into a NaN claim ──────

it("splits a same-value group by distribution so no fold produces NaN confidence", () => {
  // A scalar-confidence variant sharing the SAME (subject, key, scopeHash, valueHash)
  // as the beta claims. Pre-fix these grouped together and folded via claims[0]'s
  // binding → NaN confidence. Post-fix they fold as two homogeneous groups.
  const scalarClaim = (id: string): Claim => ({
    ...makeClaim(id),
    confidence: { distribution: "scalar", parameters: { p: 0.8 }, raw: 0.8 } as Claim["confidence"],
  });
  const group = [
    makeClaim("b1"), makeClaim("b2"), makeClaim("b3"),       // 3 beta, same value
    scalarClaim("s1"), scalarClaim("s2"), scalarClaim("s3"), // 3 scalar, same value
  ];

  const ops = planConsolidation(group, DEFAULT_POL, 1000 as any);
  const derives = ops.filter((o) => o.kind === "derive") as Extract<typeof ops[number], { kind: "derive" }>[];

  // Two homogeneous folds (beta group + scalar group), neither folding across distributions
  expect(derives).toHaveLength(2);
  // Every consolidated claim has FINITE confidence (no NaN persisted)
  for (const d of derives) {
    const params = d.claim.confidence.parameters as Record<string, number>;
    expect(Number.isFinite(d.claim.confidence.raw)).toBe(true);
    expect(Object.values(params).every((v) => Number.isFinite(v))).toBe(true);
  }
});

// ─── fold xor promote ─────────────────────────────────────────────────────

it("a claim in a fold-eligible group is never also individually promoted", () => {
  // Use claims that are high-confidence enough to earn a higher tier if evaluated individually
  const claims = [
    makeClaim("c1", { alpha: 40, beta: 8, status: "candidate" }),
    makeClaim("c2", { alpha: 40, beta: 8, status: "candidate" }),
    makeClaim("c3", { alpha: 40, beta: 8, status: "candidate" }),
  ];
  const ops = planConsolidation(claims, DEFAULT_POL, 1000 as any);

  // All three should be deprecated (folded), none should be individually promoted
  const promotedIds = ops
    .filter((o): o is Extract<typeof o, { kind: "promote" }> => o.kind === "promote")
    .map((o) => ({ id: String(o.target), to: o.to }));

  // No individual forward promotions — only deprecations
  const nonDeprecations = promotedIds.filter((p) => p.to !== "deprecated");
  expect(nonDeprecations).toHaveLength(0);
});

// ─── individual promotion: forward only ───────────────────────────────────

it("a non-folded claim earning a strictly higher tier emits one forward promote", () => {
  // Claim already at "candidate" but high enough confidence to earn "validated"
  // Beta(40,8): mean≈0.833, low variance → lb clears validated@0.65
  const claim = makeClaim("c1", { alpha: 40, beta: 8, status: "candidate" });
  const ops = planConsolidation([claim], DEFAULT_POL, 1000 as any);

  expect(ops).toHaveLength(1);
  expect(ops[0].kind).toBe("promote");
  if (ops[0].kind === "promote") {
    expect(ops[0].target).toBe(claim.id);
    expect(ops[0].to).toBe("validated");
  }
});

it("a non-folded claim already at or above its earned tier emits nothing", () => {
  // Beta(5,1): mean≈0.833 but thin → lb<0.65, earns "provisional" at most
  // But we put it at status="validated" already
  const claim = makeClaim("c1", { alpha: 5, beta: 1, status: "validated" });
  const ops = planConsolidation([claim], DEFAULT_POL, 1000 as any);
  expect(ops).toHaveLength(0);
});

it("a non-folded claim at the same tier as earned emits nothing", () => {
  // Beta(5,1): lb < 0.65, earns "provisional" or "candidate"; put at same level
  const claim = makeClaim("c1", { alpha: 5, beta: 1, status: "candidate" });
  // lb for Beta(5,1) with k=1.645: mean=0.833, var≈0.020, σ≈0.141, lb≈0.601 → provisional
  // But candidate → provisional is a forward advance — let's use a low-confidence claim
  // Beta(2,5): mean≈0.286, var≈0.027, σ≈0.165, lb≈0.286-1.645*0.165≈0.015 → candidate
  const lowClaim = makeClaim("low1", { alpha: 2, beta: 5, status: "candidate" });
  const ops = planConsolidation([lowClaim], DEFAULT_POL, 1000 as any);
  expect(ops).toHaveLength(0);
});

// ─── foldThreshold clamped to max(2, ...) ─────────────────────────────────

it("foldThreshold=1 is clamped to 2: a group of 2 is folded", () => {
  const pol = { ...DEFAULT_POL, foldThreshold: 1 };
  const twoClaims = [makeClaim("c1"), makeClaim("c2")];
  const ops = planConsolidation(twoClaims, pol, 1000 as any);
  expect(ops.filter((o) => o.kind === "derive")).toHaveLength(1);
  expect(ops.filter((o) => o.kind === "promote" && o.to === "deprecated")).toHaveLength(2);
});

// ─── foldRule is honored ───────────────────────────────────────────────────

it("weighted_avg vs evidence_pooled produce different folded confidence for same group", () => {
  const claims = threeAgreeingClaims();

  const polWA = { ...DEFAULT_POL, foldRule: RULE.WEIGHTED_AVG };
  const polEP = { ...DEFAULT_POL, foldRule: RULE.EVIDENCE_POOLED };

  const opsWA = planConsolidation(claims, polWA, 1000 as any);
  const opsEP = planConsolidation(claims, polEP, 1000 as any);

  const deriveWA = opsWA.find((o) => o.kind === "derive");
  const deriveEP = opsEP.find((o) => o.kind === "derive");

  expect(deriveWA).toBeDefined();
  expect(deriveEP).toBeDefined();

  if (deriveWA?.kind === "derive" && deriveEP?.kind === "derive") {
    const confWA = deriveWA.claim.confidence;
    const confEP = deriveEP.claim.confidence;
    // The two rules produce structurally different results for the same input
    // (at minimum, different parameter values or raw confidence)
    expect(confWA).not.toEqual(confEP);
  }
});

// ─── derive op shape ──────────────────────────────────────────────────────

it("derive op has correct workflow, combinationRule, and derivedFrom.inputClaims", () => {
  const claims = threeAgreeingClaims();
  const ops = planConsolidation(claims, DEFAULT_POL, 1000 as any);

  const deriveOp = ops.find((o) => o.kind === "derive");
  expect(deriveOp).toBeDefined();

  if (deriveOp?.kind === "derive") {
    const claim = deriveOp.claim;
    expect(claim.source).toBe("workflow");
    expect(claim.provenance?.workflow).toBe(CONSOLIDATE_WORKFLOW);
    const derivedFrom = claim.provenance?.derivedFrom;
    expect(derivedFrom).toBeDefined();
    expect(derivedFrom?.combinationRule).toBe(DEFAULT_POL.foldRule);
    // inputClaims should contain all group member ids
    const inputIds = (derivedFrom?.inputClaims ?? []).map(String);
    expect(inputIds).toContain("c1");
    expect(inputIds).toContain("c2");
    expect(inputIds).toContain("c3");
    // status should be the tier for the folded confidence
    expect(["candidate", "provisional", "validated"]).toContain(claim.status);
  }
});

it("derive op evaluationClock equals the passed-in now instant", () => {
  const claims = threeAgreeingClaims();
  const NOW = 9999 as any;
  const ops = planConsolidation(claims, DEFAULT_POL, NOW);
  const deriveOp = ops.find((o) => o.kind === "derive");
  if (deriveOp?.kind === "derive") {
    expect(deriveOp.claim.provenance?.derivedFrom?.evaluationClock).toBe(9999);
  }
});

// ─── deprecated claims excluded ───────────────────────────────────────────

it("deprecated input claims are excluded from both fold grouping and promotion", () => {
  // Two active + one deprecated with same key
  const active1 = makeClaim("c1", { status: "candidate" });
  const active2 = makeClaim("c2", { status: "candidate" });
  const dep = makeClaim("dep1", { status: "deprecated" });

  // With default threshold K=3, only 2 active remain → no fold
  const ops = planConsolidation([active1, active2, dep], DEFAULT_POL, 1000 as any);

  // No fold (only 2 active in group)
  expect(ops.filter((o) => o.kind === "derive")).toHaveLength(0);
  // dep is not promoted
  const promotions = ops.filter(
    (o): o is Extract<typeof o, { kind: "promote" }> => o.kind === "promote"
  );
  const promotedDepId = promotions.find((p) => String(p.target) === "dep1");
  expect(promotedDepId).toBeUndefined();
});
