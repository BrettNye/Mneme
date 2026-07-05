import {
  evaluateAsync,
  leafAsync,
  gammaAsync,
  overrideAsync,
  joinAsync,
  asyncSigma,
  asyncTauNow,
  asyncDelta,
  asyncRho,
  asyncKappa,
  type AsyncEvalContext,
  type AsyncStage,
} from "./async-expression.js";
import { gamma, gammaAsyncTraverse } from "./provenance-traversal.js";
import { evaluate, leaf, pipe, liftOp, gammaStage, type EvalContext } from "./expression.js";
import { sigma } from "./selection.js";
import { tauNow } from "./temporal.js";
import { rho } from "./similarity.js";
import { kappa } from "./composition.js";
import { override } from "./override.js";
import { joinSubjectWith } from "./join.js";
import type { ComposedContext, RankedCorpus, Corpus } from "./types.js";

// Minimal fake claim matching the Claim interface (mirrors expression.test.ts).
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

// ---------- leafAsync ----------

it("evaluates a leafAsync + asyncSigma against the async adapter", async () => {
  const claim = makeClaim("lineage-block", "x");
  const ctx: AsyncEvalContext = {
    adapter: { query: async () => [claim] } as any,
    catalog: { getCorpus: () => ({}) } as any,
  };
  const out = await evaluateAsync<Corpus>(
    [leafAsync("workspace:canopy"), asyncSigma({ op: "subjectEq", value: "lineage-block" })],
    ctx
  );
  expect(out.claims).toHaveLength(1);
});

it("leafAsync calls catalog.getCorpus to validate corpus existence", async () => {
  const calls: string[] = [];
  const ctx: AsyncEvalContext = {
    adapter: { query: async () => [] } as any,
    catalog: {
      getCorpus: (id: string) => {
        calls.push(id);
        return {};
      },
    } as any,
  };
  await evaluateAsync([leafAsync("my:corpus")], ctx);
  expect(calls).toEqual(["my:corpus"]);
});

it("leafAsync throws when catalog.getCorpus throws (unknown corpus)", async () => {
  const ctx: AsyncEvalContext = {
    adapter: { query: async () => [] } as any,
    catalog: {
      getCorpus: () => {
        throw new Error('unknown corpus "bad:id"');
      },
    } as any,
  };
  await expect(evaluateAsync([leafAsync("bad:id")], ctx)).rejects.toThrow("unknown corpus");
});

it("leafAsync passes corpusId to adapter.query", async () => {
  const plans: any[] = [];
  const ctx: AsyncEvalContext = {
    adapter: {
      query: async (plan: any) => {
        plans.push(plan);
        return [];
      },
    } as any,
    catalog: { getCorpus: () => ({}) } as any,
  };
  await evaluateAsync([leafAsync("test:corpus")], ctx);
  expect(plans[0]).toMatchObject({ corpusId: "test:corpus" });
});

// ---------- gammaAsync ----------

it("gammaAsync awaits ctx.adapter.getClaim for provenance lookup", async () => {
  const baseClaim = makeClaim("node-a", "alpha");
  const citedClaim = makeClaim("node-b", "beta");
  baseClaim.evidence = [{ kind: "claim", claimId: citedClaim.id }];

  const getCalls: any[] = [];
  const ctx: AsyncEvalContext = {
    adapter: {
      query: async () => [baseClaim],
      getClaim: async (id: any) => {
        getCalls.push(id);
        return citedClaim;
      },
    } as any,
    catalog: { getCorpus: () => ({}) } as any,
  };

  const out = await evaluateAsync<RankedCorpus>(
    [leafAsync("c:c"), asyncRho.jaccard("alpha"), gammaAsync(1)],
    ctx
  );
  expect(out.scored.length).toBe(2);
  expect(getCalls).toContain(citedClaim.id);
});

it("gammaAsync produces the SAME ranked output as sync gamma on an identical evidence graph", async () => {
  const c = makeClaim("C", "gamma-c");
  const b = makeClaim("B", "gamma-b");
  const a = makeClaim("A", "gamma-a");
  b.evidence = [{ kind: "claim", claimId: c.id }];
  a.evidence = [{ kind: "claim", claimId: b.id }];

  const lookupSync = (id: any) => (id === b.id ? b : id === c.id ? c : undefined);
  const lookupAsync = async (id: any) => lookupSync(id);

  const rc: RankedCorpus = { scored: [{ claim: a, score: 1.0 }] };

  const syncOut = gamma(2, lookupSync)(rc);
  const asyncOut = await gammaAsyncTraverse(rc, 2, lookupAsync);

  expect(asyncOut.scored.map((s) => s.claim.id).sort()).toEqual(
    syncOut.scored.map((s) => s.claim.id).sort()
  );
});

// ---------- full pipeline equivalence: async vs sync ----------

it("full pipeline leafAsync->asyncSigma->asyncTauNow->asyncRho->asyncKappa matches the sync pipeline", async () => {
  const t0 = Date.now();
  const claim1 = makeClaim("lineage-block", "context about the system");
  const claim2 = makeClaim("other-subject", "unrelated content");

  const syncCtx: EvalContext = {
    adapter: { query: () => [claim1, claim2], getClaim: (_id: any) => undefined } as any,
    catalog: { getCorpus: () => ({}) } as any,
    evaluationClock: t0,
  };
  const asyncCtx: AsyncEvalContext = {
    adapter: {
      query: async () => [claim1, claim2],
      getClaim: async (_id: any) => undefined,
    } as any,
    catalog: { getCorpus: () => ({}) } as any,
    evaluationClock: t0,
  };

  const syncResult = evaluate<ComposedContext>(
    pipe(
      leaf("workspace:canopy"),
      liftOp(sigma({ op: "subjectEq", value: "lineage-block" })),
      liftOp(tauNow(() => t0)),
      liftOp(rho("jaccard", "context")),
      liftOp(kappa("markdown", 1000))
    ),
    syncCtx
  );

  const asyncResult = await evaluateAsync<ComposedContext>(
    [
      leafAsync("workspace:canopy"),
      asyncSigma({ op: "subjectEq", value: "lineage-block" }),
      asyncTauNow(),
      asyncRho.jaccard("context"),
      asyncKappa.markdown(1000),
    ],
    asyncCtx
  );

  expect(asyncResult).toEqual(syncResult);
});

// ---------- override / join equivalence ----------

it("overrideAsync produces the same result as the sync override builder", async () => {
  const left = makeClaim("s1", "left-value");
  const right = makeClaim("s2", "right-value");

  const syncCtx: EvalContext = {
    adapter: { query: (plan: any) => (plan.corpusId === "left" ? [left] : [right]) } as any,
    catalog: { getCorpus: () => ({}) } as any,
  };
  const asyncCtx: AsyncEvalContext = {
    adapter: {
      query: async (plan: any) => (plan.corpusId === "left" ? [left] : [right]),
    } as any,
    catalog: { getCorpus: () => ({}) } as any,
  };

  const syncResult = evaluate<Corpus>(pipe(leaf("left"), override(pipe(leaf("right")))), syncCtx);
  const asyncResult = await evaluateAsync<Corpus>(
    [leafAsync("left"), overrideAsync([leafAsync("right")])],
    asyncCtx
  );

  expect(asyncResult.claims.map((c) => c.id).sort()).toEqual(
    syncResult.claims.map((c) => c.id).sort()
  );
});

it("joinAsync.subject produces the same result as the sync joinSubjectWith builder", async () => {
  const left = makeClaim("shared-subject", "left-value");
  const right = makeClaim("shared-subject", "right-value");
  const unrelated = makeClaim("other", "nope");

  const syncCtx: EvalContext = {
    adapter: { query: (plan: any) => (plan.corpusId === "left" ? [left] : [right, unrelated]) } as any,
    catalog: { getCorpus: () => ({}) } as any,
  };
  const asyncCtx: AsyncEvalContext = {
    adapter: {
      query: async (plan: any) => (plan.corpusId === "left" ? [left] : [right, unrelated]),
    } as any,
    catalog: { getCorpus: () => ({}) } as any,
  };

  const syncResult = evaluate<Corpus>(
    pipe(leaf("left"), joinSubjectWith(pipe(leaf("right")))),
    syncCtx
  );
  const asyncResult = await evaluateAsync<Corpus>(
    [leafAsync("left"), joinAsync.subject([leafAsync("right")])],
    asyncCtx
  );

  expect(asyncResult.claims.map((c) => c.id).sort()).toEqual(
    syncResult.claims.map((c) => c.id).sort()
  );
});

// ---------- AsyncEvalContext optional fields ----------

it("AsyncEvalContext accepts an optional pinned evaluationClock and version accumulators", () => {
  const ctx: AsyncEvalContext = {
    adapter: {} as any,
    catalog: {} as any,
    evaluationClock: 1000,
    usedSimilarityVersions: {},
  };
  expect(ctx.evaluationClock).toBe(1000);
  const bare: AsyncEvalContext = { adapter: {} as any, catalog: {} as any };
  expect(bare.evaluationClock).toBeUndefined();
});

// ---------- evaluateAsync threads stages in order and awaits promises ----------

it("evaluateAsync threads stages in declaration order and awaits async stages", async () => {
  const order: number[] = [];
  const s1: AsyncStage<any, any> = async (x) => {
    await Promise.resolve();
    order.push(1);
    return x;
  };
  const s2: AsyncStage<any, any> = (x) => {
    order.push(2);
    return x;
  };
  const s3: AsyncStage<any, any> = async (x) => {
    order.push(3);
    return x;
  };

  const ctx: AsyncEvalContext = {
    adapter: { query: async () => [] } as any,
    catalog: { getCorpus: () => ({}) } as any,
  };

  await evaluateAsync([leafAsync("x"), s1, s2, s3], ctx);
  expect(order).toEqual([1, 2, 3]);
});
