import { compile, UnsupportedExprOp } from "./compile.js";
import { evaluate, leaf as leafStage, liftOp } from "./expression.js";
import type { EvalContext } from "./expression.js";
import { sigma as sigmaOp } from "./selection.js";
import { pi as piOp } from "./projection.js";
import { delta as deltaOp } from "./decay.js";
import { tauValid, tauRecorded, tauKnown } from "./temporal.js";
import { rho as rhoOp } from "./similarity.js";
import { kappa as kappaOp } from "./composition.js";
import { gammaStage } from "./expression.js";
import { oplusDedupe, oplusSynthesizeAs } from "./combination.js";
import { pairsOf, clustersOf } from "./contradiction.js";
import { resolutionRegistry, MissingRule } from "./registries.js";
import { resolveKeepBoth } from "./resolution.js";
import { resolveDeprecateMinority } from "./resolution.js";
import { corpusOf } from "./types.js";
import {
  leaf,
  sigma,
  tau,
  delta,
  pi,
  rho,
  gamma,
  kappa,
  synthesize,
  combine,
  resolve,
  aggregate,
} from "./ast.js";
import type { Corpus } from "./types.js";

// Minimal fake claim matching the Claim interface
const makeClaim = (subject: string, value: string, recorded = Date.now() - 1000) =>
  ({
    id: `id-${subject}` as any,
    profile: "profile-1" as any,
    workspace: "ws-1" as any,
    subject,
    key: "k",
    scope: {},
    scopeHash: "h",
    value,
    valueHash: "vh",
    confidence: { distribution: "scalar", parameters: { p: 0.9 }, raw: 0.9 },
    valid: { from: 0, to: Number.MAX_SAFE_INTEGER },
    recorded,
    recordedSeq: 1,
    status: "validated" as const,
    source: "manual" as const,
    provenance: {} as any,
    evidence: [],
    tags: [],
    schema: "default",
  }) as any;

const makeCtx = (claims: any[] = []): EvalContext => ({
  adapter: {
    query: () => claims,
    getClaim: (_id: any) => undefined,
  } as any,
  catalog: { getCorpus: () => ({}) } as any,
});

// ---------- leaf ----------

it("leaf compiles to a single stage producing a Corpus", () => {
  const claim = makeClaim("s", "hello");
  const stages = compile(leaf("my:corpus"));
  expect(stages).toHaveLength(1);
  const ctx = makeCtx([claim]);
  const out: Corpus = evaluate(stages, ctx);
  expect(out.claims).toHaveLength(1);
  expect(out.claims[0]).toBe(claim);
});

// ---------- sigma ----------

it("sigma compiles to [leafStage, liftOp(sigma(pred))] with correct length and result", () => {
  const claim = makeClaim("alice", "hello");
  const pred = { op: "subjectEq" as const, value: "alice" };
  const node = sigma(pred, leaf("c"));
  const stages = compile(node);
  expect(stages).toHaveLength(2);

  const ctx = makeCtx([claim]);
  const compiled = evaluate<Corpus>(stages, ctx);

  // Hand-built equivalent
  const handBuilt = evaluate<Corpus>(
    [leafStage("c"), liftOp(sigmaOp(pred))],
    ctx
  );

  expect(compiled.claims).toHaveLength(handBuilt.claims.length);
  expect(compiled.claims[0]).toStrictEqual(handBuilt.claims[0]);
});

// ---------- pi ----------

it("pi compiles to [leafStage, liftOp(pi(fields))]", () => {
  const claim = makeClaim("s", "v");
  const node = pi(["subject", "value"], leaf("c"));
  const stages = compile(node);
  expect(stages).toHaveLength(2);

  const ctx = makeCtx([claim]);
  const out = evaluate<Corpus>(stages, ctx);
  expect(out.claims).toHaveLength(1);
  // pi keeps only requested fields
  expect(out.claims[0].subject).toBe("s");
  expect(out.claims[0].value).toBe("v");
});

// ---------- rho ----------

it("rho compiles to [leafStage, liftOp(rho(fn, query))] and ranks correctly", () => {
  const claim = makeClaim("s", "hello world");
  const node = rho("jaccard", "hello", leaf("c"));
  const stages = compile(node);
  expect(stages).toHaveLength(2);

  const ctx = makeCtx([claim]);
  const out = evaluate<any>(stages, ctx);
  expect(out.scored).toHaveLength(1);
  expect(out.scored[0].score).toBeGreaterThan(0);
});

// ---------- gamma ----------

it("gamma compiles to [leafStage, liftOp(rho), gammaStage(depth)]", () => {
  const baseClaim = makeClaim("node-a", "alpha");
  const citedClaim = makeClaim("node-b", "beta");
  baseClaim.evidence = [{ kind: "claim", claimId: citedClaim.id }];

  const stages = compile(gamma(1, rho("jaccard", "alpha", leaf("c"))));
  expect(stages).toHaveLength(3);

  const ctx: EvalContext = {
    adapter: {
      query: () => [baseClaim],
      getClaim: (_id: any) => citedClaim,
    } as any,
    catalog: { getCorpus: () => ({}) } as any,
  };
  const out = evaluate<any>(stages, ctx);
  expect(out.scored.length).toBeGreaterThanOrEqual(2);
});

// ---------- kappa ----------

it("kappa compiles to stages ending in a ComposedContext", () => {
  const claim = makeClaim("s", "hello world");
  const node = kappa("markdown", 1000, rho("jaccard", "hello", leaf("c")));
  const stages = compile(node);
  expect(stages).toHaveLength(3);

  const ctx = makeCtx([claim]);
  const out = evaluate<any>(stages, ctx);
  expect(out).toHaveProperty("format", "markdown");
  expect(out).toHaveProperty("content");
  expect(out).toHaveProperty("tokenCount");
});

// ---------- synthesize ----------

it("synthesize compiles to stages ending in a single Claim", () => {
  const claim = makeClaim("subj", "v");
  // Must use beta distribution since evidence_pooled (rule_evidence_pooled) is supported only by betaBinding
  claim.confidence = { distribution: "beta", parameters: { alpha: 9, beta: 1 }, raw: 0.9 };
  const node = synthesize("subj", "key", "rule_evidence_pooled", leaf("c"));
  const stages = compile(node);
  expect(stages).toHaveLength(2);

  const ctx = makeCtx([claim]);
  const out = evaluate<any>(stages, ctx);
  expect(out).toHaveProperty("subject", "subj");
  expect(out).toHaveProperty("key", "key");
});

// ---------- tau ----------

it("tau mode:valid compiles to liftOp(tauValid(t))", () => {
  const t = 5000;
  const claim = makeClaim("s", "v");
  claim.valid = { from: 0, to: 10000 };
  claim.recorded = 1000;
  const node = tau("valid", leaf("c"), t);
  const stages = compile(node);
  expect(stages).toHaveLength(2);

  const ctx = makeCtx([claim]);
  const out = evaluate<Corpus>(stages, ctx);
  expect(out.claims).toHaveLength(1);
});

it("tau mode:recorded compiles to liftOp(tauRecorded(t))", () => {
  const t = 2000;
  const claim = makeClaim("s", "v", 1000);
  const node = tau("recorded", leaf("c"), t);
  const stages = compile(node);
  expect(stages).toHaveLength(2);

  const ctx = makeCtx([claim]);
  const out = evaluate<Corpus>(stages, ctx);
  expect(out.claims).toHaveLength(1);
});

it("tau mode:known compiles to liftOp(tauKnown(t))", () => {
  const t = 5000;
  const claim = makeClaim("s", "v", 1000);
  claim.valid = { from: 0, to: 10000 };
  const node = tau("known", leaf("c"), t);
  const stages = compile(node);
  expect(stages).toHaveLength(2);

  const ctx = makeCtx([claim]);
  const out = evaluate<Corpus>(stages, ctx);
  expect(out.claims).toHaveLength(1);
});

it("tau mode:now uses ctx.evaluationClock (not wall-clock) and is deterministic", () => {
  const pinnedClock = 5000;
  const claim = makeClaim("s", "v", 1000);
  claim.valid = { from: 0, to: 10000 };

  const node = tau("now", leaf("c"));
  const stages = compile(node);
  expect(stages).toHaveLength(2);

  const ctx: EvalContext = {
    adapter: { query: () => [claim] } as any,
    catalog: { getCorpus: () => ({}) } as any,
    evaluationClock: pinnedClock,
  };

  const out1 = evaluate<Corpus>(stages, ctx);
  const out2 = evaluate<Corpus>(stages, ctx);

  // Both evaluations with same clock give same result
  expect(out1.claims).toHaveLength(out2.claims.length);
  expect(out1.claims[0]).toStrictEqual(out2.claims[0]);
  // The claim passes the known filter (recorded <= clock AND valid covers clock)
  expect(out1.claims).toHaveLength(1);
});

it("tau mode:now with evaluationClock before recorded excludes the claim", () => {
  // recorded=6000, clock=5000 => tauRecorded fails => claim excluded
  const claim = makeClaim("s", "v", 6000);
  claim.valid = { from: 0, to: 10000 };

  const node = tau("now", leaf("c"));
  const stages = compile(node);

  const ctx: EvalContext = {
    adapter: { query: () => [claim] } as any,
    catalog: { getCorpus: () => ({}) } as any,
    evaluationClock: 5000,
  };

  const out = evaluate<Corpus>(stages, ctx);
  expect(out.claims).toHaveLength(0);
});

it("tau mode:now throws a descriptive Error when evaluated with ctx that has no evaluationClock", () => {
  const claim = makeClaim("s", "v", 1000);
  claim.valid = { from: 0, to: 10000 };

  const node = tau("now", leaf("c"));
  const stages = compile(node);

  const ctxNoClk: EvalContext = {
    adapter: { query: () => [claim] } as any,
    catalog: { getCorpus: () => ({}) } as any,
    // evaluationClock deliberately absent
  };

  expect(() => evaluate<Corpus>(stages, ctxNoClk)).toThrow(
    "tau mode:now requires ctx.evaluationClock"
  );
});

// ---------- delta ----------

it("delta evaluation is idempotent: same evaluationClock produces same effective confidence", () => {
  const recorded = 1000;
  const claim = makeClaim("s", "v", recorded);
  claim.confidence = { distribution: "scalar", parameters: { p: 0.9 }, raw: 0.9 };

  const policy: import("../catalog/corpus.js").DecayPolicy = { kind: "exponential", halfLifeDays: 1 };
  const node = delta(policy, leaf("c"));
  const stages = compile(node);
  expect(stages).toHaveLength(2);

  const pinnedClock = 10000;

  const ctx1: EvalContext = {
    adapter: { query: () => [claim] } as any,
    catalog: { getCorpus: () => ({}) } as any,
    evaluationClock: pinnedClock,
  };

  const ctx2: EvalContext = {
    adapter: { query: () => [claim] } as any,
    catalog: { getCorpus: () => ({}) } as any,
    evaluationClock: pinnedClock,
  };

  const out1 = evaluate<Corpus>(stages, ctx1);
  const out2 = evaluate<Corpus>(stages, ctx2);

  // Same evaluationClock => same effective confidence
  expect(out1.claims[0].confidence.effective).toBe(out2.claims[0].confidence.effective);
});

it("delta throws a descriptive Error when evaluated with ctx that has no evaluationClock", () => {
  const claim = makeClaim("s", "v", 1000);
  const policy: import("../catalog/corpus.js").DecayPolicy = { kind: "exponential", halfLifeDays: 1 };
  const node = delta(policy, leaf("c"));
  const stages = compile(node);

  const ctxNoClk: EvalContext = {
    adapter: { query: () => [claim] } as any,
    catalog: { getCorpus: () => ({}) } as any,
    // evaluationClock deliberately absent
  };

  expect(() => evaluate<Corpus>(stages, ctxNoClk)).toThrow(
    "delta requires ctx.evaluationClock"
  );
});

it("delta with different evaluationClock values produces different decay results", () => {
  const recorded = 0;
  const claim = makeClaim("s", "v", recorded);
  claim.confidence = { distribution: "scalar", parameters: { p: 1.0 }, raw: 1.0 };

  const policy: import("../catalog/corpus.js").DecayPolicy = { kind: "exponential", halfLifeDays: 1 };
  const node = delta(policy, leaf("c"));
  const stages = compile(node);

  const clk1 = 86_400_000; // exactly 1 halfLife = 1 day
  const clk2 = 86_400_000 * 2; // 2 halfLives

  const out1 = evaluate<Corpus>(stages, {
    adapter: { query: () => [claim] } as any,
    catalog: { getCorpus: () => ({}) } as any,
    evaluationClock: clk1,
  });

  const out2 = evaluate<Corpus>(stages, {
    adapter: { query: () => [claim] } as any,
    catalog: { getCorpus: () => ({}) } as any,
    evaluationClock: clk2,
  });

  const e1 = out1.claims[0].confidence.effective!;
  const e2 = out2.claims[0].confidence.effective!;
  expect(e1).toBeGreaterThan(e2);
  // After 1 halfLife the multiplier should be ~0.5
  expect(e1).toBeCloseTo(0.5, 5);
});

// ---------- sigma→delta→pi pipeline matches hand-built ----------

it("compiled σ→δ→π pipeline evaluates to same result as equivalent hand-built pipeline", () => {
  const recorded = 1000;
  const claim = makeClaim("alice", "hello world", recorded);
  claim.confidence = { distribution: "scalar", parameters: { p: 0.9 }, raw: 0.9 };
  const clock = 5000;
  const pred = { op: "subjectEq" as const, value: "alice" };
  const fields: import("./ast.js").Field[] = ["subject", "value", "confidence"];

  const policy: import("../catalog/corpus.js").DecayPolicy = { kind: "none" };
  const node = pi(fields, delta(policy, sigma(pred, leaf("c"))));

  const stages = compile(node);
  // sigma(1) + delta(1) + pi(1) + leaf(1) = 4 stages total
  expect(stages).toHaveLength(4);

  const ctx: EvalContext = {
    adapter: { query: () => [claim] } as any,
    catalog: { getCorpus: () => ({}) } as any,
    evaluationClock: clock,
  };

  const compiled = evaluate<Corpus>(stages, ctx);

  // Hand-built equivalent
  const handBuilt = evaluate<Corpus>(
    [
      leafStage("c"),
      liftOp(sigmaOp(pred)),
      (_c: Corpus, evalCtx: EvalContext) => deltaOp(policy, evalCtx.evaluationClock!)((_c as Corpus)),
      liftOp(piOp(fields)),
    ],
    ctx
  );

  expect(compiled.claims).toHaveLength(handBuilt.claims.length);
  expect(compiled.claims[0].subject).toBe(handBuilt.claims[0].subject);
  expect(compiled.claims[0].value).toBe(handBuilt.claims[0].value);
});

// ---------- combine compiles to oplusDedupe ----------

// Two claims with same (subject, key, scopeHash) but different values; oplusDedupe folds them.
// We use "rule_evidence_pooled" with beta distribution.
const makeBetaClaim = (
  id: string,
  subject: string,
  key: string,
  scopeHash: string,
  valueHash: string,
  alpha: number,
  beta: number,
) =>
  ({
    id,
    profile: "p" as any,
    workspace: "w" as any,
    subject,
    key,
    scope: {},
    scopeHash,
    value: valueHash,
    valueHash,
    confidence: { distribution: "beta", parameters: { alpha, beta }, raw: alpha / (alpha + beta) },
    valid: { from: 0, to: Number.MAX_SAFE_INTEGER },
    recorded: 1000,
    recordedSeq: 1,
    status: "validated" as const,
    source: "manual" as const,
    provenance: {} as any,
    evidence: [],
    tags: [],
    schema: "v1",
  }) as any;

it("compiles combine to a dedupe pipeline equal to oplusDedupe over a seeded corpus", () => {
  // Two claims with same triple (subject, key, scopeHash) — oplusDedupe folds them into one.
  const c1 = makeBetaClaim("id-1", "subj", "key", "sh", "vh-A", 9, 1);
  const c2 = makeBetaClaim("id-2", "subj", "key", "sh", "vh-A", 3, 7);

  const ctx = makeCtx([c1, c2]);
  const rule = "rule_evidence_pooled";

  const compiled = evaluate<Corpus>(compile(combine(rule, leaf("c"))), ctx);

  // Hand-built: leaf then oplusDedupe
  const handBuilt = evaluate<Corpus>(
    [leafStage("c"), liftOp(oplusDedupe(rule))],
    ctx,
  );

  expect(compiled.claims).toHaveLength(1);
  expect(compiled.claims[0].confidence.parameters).toStrictEqual(
    handBuilt.claims[0].confidence.parameters,
  );
  expect(compiled.claims[0].confidence.raw).toBeCloseTo(
    handBuilt.claims[0].confidence.raw,
    10,
  );
});

it("compiles combine with params and produces the same result as hand-built oplusDedupe(rule, params)", () => {
  const c1 = makeBetaClaim("id-1", "s", "k", "sh", "vh-A", 7, 3);
  const c2 = makeBetaClaim("id-2", "s", "k", "sh", "vh-A", 5, 5);

  const ctx = makeCtx([c1, c2]);
  const rule = "rule_evidence_pooled";
  const params = undefined;

  const compiled = evaluate<Corpus>(compile(combine(rule, leaf("c"), params)), ctx);
  const handBuilt = evaluate<Corpus>(
    [leafStage("c"), liftOp(oplusDedupe(rule, params))],
    ctx,
  );

  expect(compiled.claims).toHaveLength(handBuilt.claims.length);
  expect(compiled.claims[0].confidence.raw).toBeCloseTo(
    handBuilt.claims[0].confidence.raw,
    10,
  );
});

// ---------- resolve compiles using pairsOf / clustersOf + threshold ----------

// Make two contradicting claims: same (subject, key, scopeHash) but different valueHash.
const makeConflictingPair = () => {
  const hi = makeBetaClaim("id-hi", "subj", "key", "sh", "vh-HI", 9, 1);
  const lo = makeBetaClaim("id-lo", "subj", "key", "sh", "vh-LO", 1, 9);
  return { hi, lo };
};

it("compiles resolve(resolveKeepBoth) [pairs] and evaluates equal to hand-built fn(pairsOf(...))", () => {
  const { hi, lo } = makeConflictingPair();
  const ctx = makeCtx([hi, lo]);
  const threshold = 0.0; // both claims have effective > 0, so both pass the filter

  const compiled = evaluate<Corpus>(
    compile(resolve("resolveKeepBoth", leaf("c"), undefined, threshold)),
    ctx,
  );

  const corpus = corpusOf([hi, lo]);
  const { fn, input } = resolutionRegistry("resolveKeepBoth");
  expect(input).toBe("pairs");
  const groups = pairsOf(corpus, threshold);
  const handBuilt = (fn as any)(groups)(corpus);

  expect(compiled.claims).toHaveLength(handBuilt.claims.length);
  expect(compiled.claims.map((c: any) => c.id).sort()).toStrictEqual(
    handBuilt.claims.map((c: any) => c.id).sort(),
  );
});

it("compiles resolve(resolveDeprecateMinority) [clusters] and evaluates equal to hand-built fn(clustersOf(...))", () => {
  const { hi, lo } = makeConflictingPair();
  const ctx = makeCtx([hi, lo]);
  const threshold = 0.0;

  const compiled = evaluate<Corpus>(
    compile(resolve("resolveDeprecateMinority", leaf("c"), undefined, threshold)),
    ctx,
  );

  const corpus = corpusOf([hi, lo]);
  const { fn, input } = resolutionRegistry("resolveDeprecateMinority");
  expect(input).toBe("clusters");
  const groups = clustersOf(corpus, threshold);
  const handBuilt = (fn as any)(groups)(corpus);

  expect(compiled.claims).toHaveLength(handBuilt.claims.length);
  // hi has higher confidence so lo should be deprecated
  const hiOut = compiled.claims.find((c: any) => c.id === "id-hi");
  const hiHandBuilt = handBuilt.claims.find((c: any) => c.id === "id-hi");
  expect(hiOut?.status).toBe(hiHandBuilt?.status);
  const loOut = compiled.claims.find((c: any) => c.id === "id-lo");
  const loHandBuilt = handBuilt.claims.find((c: any) => c.id === "id-lo");
  expect(loOut?.status).toBe(loHandBuilt?.status);
});

it("compiled resolve threads node.threshold to pairsOf / clustersOf (high threshold excludes claims)", () => {
  // With threshold=0.95, hi (0.9 raw) is excluded => no contradictions detected => corpus unchanged
  const { hi, lo } = makeConflictingPair();
  const ctx = makeCtx([hi, lo]);
  const highThreshold = 0.95; // both claims have raw < 0.95 => excluded from contradiction detection

  const compiled = evaluate<Corpus>(
    compile(resolve("resolveKeepBoth", leaf("c"), undefined, highThreshold)),
    ctx,
  );

  // With such a high threshold, no claims pass the filter in pairsOf => no pairs => corpus unchanged
  const corpus = corpusOf([hi, lo]);
  const { fn } = resolutionRegistry("resolveKeepBoth");
  const groups = pairsOf(corpus, highThreshold);
  const handBuilt = (fn as any)(groups)(corpus);

  expect(compiled.claims).toHaveLength(handBuilt.claims.length);
});

it("compiles resolve(resolveDeprecateOlder) [pairs] and evaluates equal to hand-built fn(pairsOf(...))", () => {
  // Give claims distinct valid.from so recency semantics decide a clear winner.
  const hi = makeBetaClaim("id-hi", "subj", "key", "sh", "vh-HI", 9, 1);
  const lo = makeBetaClaim("id-lo", "subj", "key", "sh", "vh-LO", 1, 9);
  // lo is the "older" claim (earlier valid.from), hi is newer
  hi.valid = { from: 2000, to: Number.MAX_SAFE_INTEGER };
  lo.valid = { from: 1000, to: Number.MAX_SAFE_INTEGER };

  const ctx = makeCtx([hi, lo]);
  const compiled = evaluate<Corpus>(
    compile(resolve("resolveDeprecateOlder", leaf("c"), undefined, 0.0)),
    ctx,
  );

  const corpus = corpusOf([hi, lo]);
  const { fn, input } = resolutionRegistry("resolveDeprecateOlder");
  expect(input).toBe("pairs");
  const handBuilt = (fn as any)(pairsOf(corpus, 0.0))(corpus);

  expect(compiled.claims).toHaveLength(handBuilt.claims.length);
  // the older claim (lo) is deprecated in both paths
  const loCompiled = compiled.claims.find((c: any) => c.id === "id-lo");
  const loHandBuilt = handBuilt.claims.find((c: any) => c.id === "id-lo");
  expect(loCompiled?.status).toBe("deprecated");
  expect(loHandBuilt?.status).toBe("deprecated");
  const hiCompiled = compiled.claims.find((c: any) => c.id === "id-hi");
  const hiHandBuilt = handBuilt.claims.find((c: any) => c.id === "id-hi");
  expect(hiCompiled?.status).toBe(hiHandBuilt?.status);
});

it("unknown resolve policy throws MissingRule at evaluate time", () => {
  const ctx = makeCtx([]);
  // Compile doesn't throw; MissingRule is thrown during evaluate (resolutionRegistry lookup)
  const stages = compile(resolve("nonExistentPolicy", leaf("c"), undefined, 0.5));
  expect(() => evaluate(stages, ctx)).toThrow(MissingRule);
});

// ---------- aggregate throws UnsupportedExprOp ----------

it("throws UnsupportedExprOp for aggregate", () => {
  expect(() => compile(aggregate("count", leaf("c")))).toThrow(UnsupportedExprOp);
  expect(() => compile(aggregate("count", leaf("c")))).toThrow("aggregate");
});

it("UnsupportedExprOp carries the offending op field for aggregate", () => {
  try {
    compile(aggregate("count", leaf("c")));
    expect.fail("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(UnsupportedExprOp);
    expect((e as UnsupportedExprOp).op).toBe("aggregate");
  }
});

// ---------- compile does not read EvalContext at compile time ----------

it("compile returns a Stage array without accessing EvalContext during the call", () => {
  // compile() itself must be a pure structural transform — no ctx access at call time.
  // The stages it returns DO access ctx at evaluate time (tested separately above).
  expect(() => compile(sigma({ op: "subjectEq", value: "x" }, leaf("c")))).not.toThrow();
  expect(() => compile(delta({ kind: "none" }, leaf("c")))).not.toThrow();
  expect(() => compile(tau("now", leaf("c")))).not.toThrow();

  // All three return Stage arrays (not undefined/errors), confirming compile is pure.
  const s1 = compile(sigma({ op: "subjectEq", value: "x" }, leaf("c")));
  const s2 = compile(delta({ kind: "none" }, leaf("c")));
  const s3 = compile(tau("now", leaf("c")));
  expect(s1).toHaveLength(2);
  expect(s2).toHaveLength(2);
  expect(s3).toHaveLength(2);
});
