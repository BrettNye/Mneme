import { evidenceUpdate } from "./evidence-update.js";
import type { ProcessInput, SignalView } from "../types.js";
import type { Claim } from "../../core/claim.js";
import type { ClaimId } from "../../core/ids.js";

// Helper: make a minimal Claim with beta confidence
function makeClaim(id: string, alpha: number, beta: number): Claim {
  const claimId = id as unknown as ClaimId;
  return {
    id: claimId,
    profile: "p1" as Claim["profile"],
    workspace: "w1" as Claim["workspace"],
    subject: "test.e1",
    key: "test.skill.typescript",
    scope: { kind: "global" },
    scopeHash: "sh1",
    value: { kind: "scalar", v: 0.8 },
    valueHash: "vh1",
    confidence: { distribution: "beta", parameters: { alpha, beta }, raw: alpha / (alpha + beta) },
    valid: { from: 0, to: Infinity },
    recorded: 1000 as unknown as Claim["recorded"],
    recordedSeq: 1,
    status: "provisional",
    source: "heuristic",
    provenance: {},
    evidence: [],
    tags: [],
    schema: "v1",
  };
}

// Helper: build a ProcessInput stub
function makeInput(opts: {
  usageIds?: string[];
  surfacedIds?: string[];
  outcomes?: { result: "success" | "failure"; weight?: number }[];
  claims?: Claim[];
  episodeId?: string;
}): ProcessInput {
  const episodeId = opts.episodeId ?? "ep-1";
  const claimsById = new Map((opts.claims ?? []).map((c) => [String(c.id), c]));

  const signals: SignalView = {
    usageFor: (_e) => (opts.usageIds ?? []).map((id) => id as unknown as ClaimId),
    outcomesFor: (_e) => opts.outcomes ?? [],
    surfacedFor: (_e) => (opts.surfacedIds ?? []).map((id) => id as unknown as ClaimId),
  };

  return {
    episode: { id: episodeId, runIds: [], startedAt: 1000 as any },
    signals,
    read: (_q) => [],
    readByIds: (ids) => ids.map((id) => claimsById.get(String(id))).filter(Boolean) as Claim[],
    now: 2000 as any,
  };
}

it("has name 'evidence-update'", () => {
  const proc = evidenceUpdate();
  expect(proc.name).toBe("evidence-update");
});

it("usage signals add USAGE_WEIGHT (0.5) to alpha of cited claim, beta unchanged", () => {
  const claim = makeClaim("c1", 1, 1);
  const proc = evidenceUpdate();
  const ops = proc.run(
    makeInput({ usageIds: ["c1"], surfacedIds: [], outcomes: [], claims: [claim] })
  );

  expect(ops).toHaveLength(1);
  const op = ops[0];
  expect(op.kind).toBe("supersede");
  if (op.kind === "supersede") {
    expect(op.deprecate).toBe(claim.id);
    const conf = op.with.confidence;
    expect(conf.distribution).toBe("beta");
    if (conf.distribution === "beta") {
      expect(conf.parameters.alpha).toBeCloseTo(1.5); // 1 + 0.5
      expect(conf.parameters.beta).toBeCloseTo(1);    // unchanged
    }
  }
});

it("outcome success adds OUTCOME_WEIGHT (2.0) to alpha of surfaced claims only", () => {
  const c1 = makeClaim("c1", 1, 1); // surfaced
  const c2 = makeClaim("c2", 1, 1); // NOT surfaced — should get no credit
  const proc = evidenceUpdate();
  const ops = proc.run(
    makeInput({
      usageIds: [],
      surfacedIds: ["c1"],
      outcomes: [{ result: "success", weight: 1 }],
      claims: [c1, c2],
    })
  );

  // Only c1 should be in ops
  expect(ops).toHaveLength(1);
  const op = ops[0];
  if (op.kind === "supersede") {
    expect(op.deprecate).toBe(c1.id);
    const conf = op.with.confidence;
    if (conf.distribution === "beta") {
      expect(conf.parameters.alpha).toBeCloseTo(3); // 1 + 1*2.0
      expect(conf.parameters.beta).toBeCloseTo(1);  // unchanged
    }
  }
});

it("outcome failure adds OUTCOME_WEIGHT (2.0) to beta of surfaced claims, never deletes", () => {
  const claim = makeClaim("c1", 1, 1);
  const proc = evidenceUpdate();
  const ops = proc.run(
    makeInput({
      usageIds: [],
      surfacedIds: ["c1"],
      outcomes: [{ result: "failure", weight: 1 }],
      claims: [claim],
    })
  );

  expect(ops).toHaveLength(1);
  const op = ops[0];
  expect(op.kind).toBe("supersede"); // not delete
  if (op.kind === "supersede") {
    const conf = op.with.confidence;
    if (conf.distribution === "beta") {
      expect(conf.parameters.alpha).toBeCloseTo(1);  // unchanged
      expect(conf.parameters.beta).toBeCloseTo(3);   // 1 + 1*2.0
    }
  }
});

it("multiple signals to the same claim are batched into exactly one supersede op", () => {
  const claim = makeClaim("c1", 1, 1);
  const proc = evidenceUpdate();
  const ops = proc.run(
    makeInput({
      usageIds: ["c1"],
      surfacedIds: ["c1"],
      outcomes: [
        { result: "success", weight: 1 },
        { result: "success", weight: 1 },
      ],
      claims: [claim],
    })
  );

  // All signals to c1 → exactly one supersede
  expect(ops).toHaveLength(1);
  const op = ops[0];
  if (op.kind === "supersede") {
    const conf = op.with.confidence;
    if (conf.distribution === "beta") {
      // alpha: 1 + 0.5(usage) + 2*2.0(two success outcomes) = 5.5
      expect(conf.parameters.alpha).toBeCloseTo(5.5);
      expect(conf.parameters.beta).toBeCloseTo(1);
    }
  }
});

it("supersede replacement carries derivedFrom provenance naming the process, input claim, and episode", () => {
  const claim = makeClaim("c1", 1, 1);
  const proc = evidenceUpdate();
  const ops = proc.run(
    makeInput({
      usageIds: ["c1"],
      surfacedIds: [],
      outcomes: [],
      claims: [claim],
      episodeId: "ep-test",
    })
  );

  expect(ops).toHaveLength(1);
  const op = ops[0];
  if (op.kind === "supersede") {
    const prov = op.with.provenance?.derivedFrom;
    expect(prov).toBeDefined();
    expect(prov?.queryExpression).toBe("evidence-update");
    expect(prov?.inputClaims).toContain(claim.id);
    expect(prov?.combinationRule).toContain("ep-test");
  }
});

it("outcome credit is NOT applied to non-surfaced claims even if they are used", () => {
  const usedOnly = makeClaim("used", 1, 1);    // appears in usage but not surfaced
  const surfaced = makeClaim("surf", 1, 1);    // surfaced, gets outcome credit
  const proc = evidenceUpdate();
  const ops = proc.run(
    makeInput({
      usageIds: ["used"],
      surfacedIds: ["surf"],
      outcomes: [{ result: "success" }],
      claims: [usedOnly, surfaced],
    })
  );

  // Two ops: one for "used" (usage only), one for "surf" (outcome only)
  expect(ops).toHaveLength(2);
  const usedOp = ops.find((o) => o.kind === "supersede" && String(o.deprecate) === "used");
  const surfOp = ops.find((o) => o.kind === "supersede" && String(o.deprecate) === "surf");
  expect(usedOp).toBeDefined();
  expect(surfOp).toBeDefined();

  if (usedOp?.kind === "supersede") {
    const conf = usedOp.with.confidence;
    if (conf.distribution === "beta") {
      // only usage bump: alpha += 0.5
      expect(conf.parameters.alpha).toBeCloseTo(1.5);
      expect(conf.parameters.beta).toBeCloseTo(1);
    }
  }
  if (surfOp?.kind === "supersede") {
    const conf = surfOp.with.confidence;
    if (conf.distribution === "beta") {
      // only outcome success: alpha += 1 * 2.0
      expect(conf.parameters.alpha).toBeCloseTo(3);
      expect(conf.parameters.beta).toBeCloseTo(1);
    }
  }
});

it("scalar confidence claim with p=0.9 is promoted to beta preserving its mean (not collapsed to 0.5)", () => {
  // This is the correctness regression test: p=0.9 must produce a beta with mean ~0.9, not 0.5
  const claimId = "sc1" as unknown as ClaimId;
  const scalarClaim: Claim = {
    id: claimId,
    profile: "p1" as Claim["profile"],
    workspace: "w1" as Claim["workspace"],
    subject: "test.e1",
    key: "test.skill.python",
    scope: { kind: "global" },
    scopeHash: "sh2",
    value: { kind: "scalar", v: 0.9 },
    valueHash: "vh2",
    confidence: { distribution: "scalar", parameters: { p: 0.9 }, raw: 0.9 },
    valid: { from: 0, to: Infinity },
    recorded: 1000 as any,
    recordedSeq: 1,
    status: "provisional",
    source: "heuristic",
    provenance: {},
    evidence: [],
    tags: [],
    schema: "v1",
  };

  const proc = evidenceUpdate();
  // A small positive usage delta — should not collapse the mean to 0.5
  const ops = proc.run(
    makeInput({ usageIds: ["sc1"], surfacedIds: [], outcomes: [], claims: [scalarClaim] })
  );

  expect(ops).toHaveLength(1);
  const op = ops[0];
  if (op.kind === "supersede") {
    const conf = op.with.confidence;
    // Should be promoted to beta distribution
    expect(conf.distribution).toBe("beta");
    if (conf.distribution === "beta") {
      // SCALAR_PSEUDOCOUNT = 2; alpha = 0.9*2 + 0.5 = 2.3, beta = 0.1*2 + 0 = 0.2
      // mean = 2.3 / (2.3 + 0.2) = 0.92 — clearly in [0.85, 0.95], NOT 0.5
      const mean = conf.parameters.alpha / (conf.parameters.alpha + conf.parameters.beta);
      expect(mean).toBeGreaterThan(0.85);
      expect(mean).toBeLessThan(0.95);
    }
  }
});

it("scalar confidence claim with p=0.7 is promoted to beta preserving its mean", () => {
  const claimId = "sc2" as unknown as ClaimId;
  const scalarClaim: Claim = {
    id: claimId,
    profile: "p1" as Claim["profile"],
    workspace: "w1" as Claim["workspace"],
    subject: "test.e1",
    key: "test.skill.python",
    scope: { kind: "global" },
    scopeHash: "sh2",
    value: { kind: "scalar", v: 0.5 },
    valueHash: "vh2",
    confidence: { distribution: "scalar", parameters: { p: 0.7 }, raw: 0.7 },
    valid: { from: 0, to: Infinity },
    recorded: 1000 as any,
    recordedSeq: 1,
    status: "provisional",
    source: "heuristic",
    provenance: {},
    evidence: [],
    tags: [],
    schema: "v1",
  };

  const proc = evidenceUpdate();
  const ops = proc.run(
    makeInput({ usageIds: ["sc2"], surfacedIds: [], outcomes: [], claims: [scalarClaim] })
  );

  expect(ops).toHaveLength(1);
  const op = ops[0];
  if (op.kind === "supersede") {
    const conf = op.with.confidence;
    // Should be promoted to beta distribution
    expect(conf.distribution).toBe("beta");
    if (conf.distribution === "beta") {
      // SCALAR_PSEUDOCOUNT = 2; alpha = 0.7*2 + 0.5 = 1.9, beta = 0.3*2 + 0 = 0.6
      // mean = 1.9 / (1.9 + 0.6) = 0.76 — clearly > 0.5 and close to 0.7
      const mean = conf.parameters.alpha / (conf.parameters.alpha + conf.parameters.beta);
      expect(mean).toBeGreaterThan(0.65);
      expect(mean).toBeLessThan(0.85);
      // Also verify exact params: alpha=1.9, beta=0.6
      expect(conf.parameters.alpha).toBeCloseTo(1.9);
      expect(conf.parameters.beta).toBeCloseTo(0.6);
    }
  }
});

it("outcome with custom weight scales correctly", () => {
  const claim = makeClaim("c1", 1, 1);
  const proc = evidenceUpdate();
  const ops = proc.run(
    makeInput({
      usageIds: [],
      surfacedIds: ["c1"],
      outcomes: [{ result: "success", weight: 2 }], // weight=2 → adds 2*2.0=4 to alpha
      claims: [claim],
    })
  );

  expect(ops).toHaveLength(1);
  const op = ops[0];
  if (op.kind === "supersede" && op.with.confidence.distribution === "beta") {
    expect(op.with.confidence.parameters.alpha).toBeCloseTo(5); // 1 + 4
    expect(op.with.confidence.parameters.beta).toBeCloseTo(1);
  }
});

it("returns empty array when no signals match any known claims", () => {
  const proc = evidenceUpdate();
  const ops = proc.run(
    makeInput({ usageIds: [], surfacedIds: [], outcomes: [], claims: [] })
  );
  expect(ops).toHaveLength(0);
});
