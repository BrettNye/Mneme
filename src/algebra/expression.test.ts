import { leaf, evaluate, pipe, liftOp, gammaStage } from "./expression.js";
import { type EvalContext } from "./expression.js";
import { sigma } from "./selection.js";
import { delta } from "./decay.js";
import { rho } from "./similarity.js";
import { kappa } from "./composition.js";
import type { ComposedContext, RankedCorpus } from "./types.js";

// Minimal fake claim matching the Claim interface
const makeClaim = (subject: string, value: string) =>
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
    valid: { start: 0, end: Number.MAX_SAFE_INTEGER },
    recorded: Date.now() - 1000,
    recordedSeq: 1,
    status: "validated" as const,
    source: "manual" as const,
    provenance: {} as any,
    evidence: [],
    tags: [],
    schema: "default",
  }) as any;

// ---------- basic leaf + selection test (from task spec) ----------

it("evaluates a leaf + selection against the adapter", () => {
  const claim = makeClaim("lineage-block", "x");
  const ctx = {
    adapter: { query: () => [claim] } as any,
    catalog: { getCorpus: () => ({}) } as any,
  };
  const out = evaluate<any>(
    [leaf("workspace:canopy"), (c: any) => sigma({ op: "subjectEq", value: "lineage-block" })(c)],
    ctx
  );
  expect(out.claims).toHaveLength(1);
});

// ---------- leaf calls catalog.getCorpus ----------

it("leaf calls catalog.getCorpus to validate corpus existence", () => {
  const calls: string[] = [];
  const ctx = {
    adapter: { query: () => [] } as any,
    catalog: {
      getCorpus: (id: string) => {
        calls.push(id);
        return {};
      },
    } as any,
  };
  evaluate([leaf("my:corpus")], ctx);
  expect(calls).toEqual(["my:corpus"]);
});

it("leaf throws when catalog.getCorpus throws (unknown corpus)", () => {
  const ctx = {
    adapter: { query: () => [] } as any,
    catalog: {
      getCorpus: () => {
        throw new Error('unknown corpus "bad:id"');
      },
    } as any,
  };
  expect(() => evaluate([leaf("bad:id")], ctx)).toThrow("unknown corpus");
});

// ---------- leaf passes corpusId to adapter.query ----------

it("leaf passes corpusId to adapter.query", () => {
  const plans: any[] = [];
  const ctx = {
    adapter: { query: (plan: any) => { plans.push(plan); return []; } } as any,
    catalog: { getCorpus: () => ({}) } as any,
  };
  evaluate([leaf("test:corpus")], ctx);
  expect(plans[0]).toMatchObject({ corpusId: "test:corpus" });
});

it("leaf passes hints into the adapter plan; no-hints call passes corpusId only", () => {
  const plans: any[] = [];
  const ctx = {
    adapter: { query: (plan: any) => { plans.push(plan); return []; } } as any,
    catalog: { getCorpus: () => ({}) } as any,
  };
  evaluate([leaf("c", { subject: "s", keys: ["k1", "k2"] })], ctx);
  evaluate([leaf("c")], ctx);
  expect(plans[0]).toEqual({ corpusId: "c", subject: "s", keys: ["k1", "k2"] });
  expect(plans[1]).toEqual({ corpusId: "c" });
});

it("leaf throws when catalog.getCorpus throws (unknown corpus), even with hints supplied", () => {
  const ctx = {
    adapter: { query: () => [] } as any,
    catalog: {
      getCorpus: () => {
        throw new Error('unknown corpus "bad:id"');
      },
    } as any,
  };
  expect(() => evaluate([leaf("bad:id", { subject: "s" })], ctx)).toThrow("unknown corpus");
});

// ---------- pipe helper ----------

it("pipe returns an ordered stage array", () => {
  const s1 = (x: any) => x;
  const s2 = (x: any) => x;
  const stages = pipe(s1, s2);
  expect(stages).toEqual([s1, s2]);
});

// ---------- liftOp helper ----------

it("liftOp wraps a ctx-ignoring operator into a Stage", () => {
  const claim = makeClaim("s", "hello world");
  const ctx = {
    adapter: { query: () => [claim] } as any,
    catalog: { getCorpus: () => ({}) } as any,
  };
  const out = evaluate<any>(
    pipe(leaf("c:c"), liftOp(sigma({ op: "subjectEq", value: "s" }))),
    ctx
  );
  expect(out.claims).toHaveLength(1);
});

// ---------- gammaStage helper ----------

it("gammaStage uses ctx.adapter.getClaim for provenance lookup", () => {
  const baseClaim = makeClaim("node-a", "alpha");
  const citedClaim = makeClaim("node-b", "beta");
  // baseClaim cites citedClaim via evidence
  baseClaim.evidence = [{ kind: "claim", claimId: citedClaim.id }];

  const getCalls: any[] = [];
  const ctx = {
    adapter: {
      query: () => [baseClaim],
      getClaim: (id: any) => { getCalls.push(id); return citedClaim; },
    } as any,
    catalog: { getCorpus: () => ({}) } as any,
  };

  // leaf → rho (Corpus→RankedCorpus) → gammaStage
  const out = evaluate<RankedCorpus>(
    pipe(leaf("c:c"), liftOp(rho("jaccard", "alpha")), gammaStage(1)),
    ctx
  );
  expect(out.scored.length).toBe(2); // original + cited
  expect(getCalls).toContain(citedClaim.id);
});

// ---------- full §4 pipeline: leaf → σ → δ → σ → ρ → γ → κ ----------

it("full §4 pipeline leaf→σ→δ→σ→ρ→γ→κ yields a ComposedContext", () => {
  const now = Date.now();
  const claim1 = makeClaim("lineage-block", "context about the system");
  const claim2 = makeClaim("other-subject", "unrelated content");

  const ctx = {
    adapter: {
      query: () => [claim1, claim2],
      getClaim: (_id: any) => undefined,
    } as any,
    catalog: { getCorpus: () => ({}) } as any,
  };

  const result = evaluate<ComposedContext>(
    pipe(
      leaf("workspace:canopy"),
      liftOp(sigma({ op: "subjectEq", value: "lineage-block" })),
      liftOp(delta({ kind: "none" }, now)),
      liftOp(sigma({ op: "confidenceGt", value: 0 })),
      liftOp(rho("jaccard", "context")),
      gammaStage(1),
      liftOp(kappa("markdown", 1000))
    ),
    ctx
  );

  // Must be a ComposedContext
  expect(result).toHaveProperty("format");
  expect(result).toHaveProperty("content");
  expect(result).toHaveProperty("tokenCount");
  expect(result.format).toBe("markdown");
  expect(typeof result.content).toBe("string");
  expect(typeof result.tokenCount).toBe("number");
});

// ---------- EvalContext optional fields ----------

it("EvalContext accepts an optional pinned evaluationClock and version accumulators", () => {
  const ctx: EvalContext = { adapter: {} as any, catalog: {} as any, evaluationClock: 1000, usedSimilarityVersions: {} };
  expect(ctx.evaluationClock).toBe(1000);
  const bare: EvalContext = { adapter: {} as any, catalog: {} as any };
  expect(bare.evaluationClock).toBeUndefined();
});

it("EvalContext usedEmbeddingModelVersions is optional and can hold version strings", () => {
  const ctx: EvalContext = { adapter: {} as any, catalog: {} as any, usedEmbeddingModelVersions: { "text-embed-3": "v1" } };
  expect(ctx.usedEmbeddingModelVersions).toEqual({ "text-embed-3": "v1" });
});

// ---------- evaluate preserves operator order ----------

it("evaluate threads stages in declaration order", () => {
  const order: number[] = [];
  const s1 = (x: any) => { order.push(1); return x; };
  const s2 = (x: any) => { order.push(2); return x; };
  const s3 = (x: any) => { order.push(3); return x; };

  const ctx = {
    adapter: { query: () => [] } as any,
    catalog: { getCorpus: () => ({}) } as any,
  };

  evaluate(pipe(leaf("x"), s1, s2, s3), ctx);
  expect(order).toEqual([1, 2, 3]);
});
