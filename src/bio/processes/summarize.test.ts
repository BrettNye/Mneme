import { createSummarizePass } from "./summarize.js";
import { createMnemeGateway } from "../gateway.js";
import { makeBioMneme } from "../test-support.js";
import type { Episode } from "../types.js";
import type { CandidateClaim } from "../../core/claim.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEpisode(id = "e1", runIds = ["r1"]): Episode {
  return { id, runIds, startedAt: 0 };
}

/** Build a non-summary candidate seeded under a specific runId */
function makeCandidate(opts: { key?: string; runId?: string } = {}): CandidateClaim {
  const { key = "session.focus", runId = "r1" } = opts;
  return {
    profile: "p1" as any,
    workspace: "w1" as any,
    subject: "session",
    key,
    scope: {},
    value: { kind: "text", v: "worked on feature X" } as any,
    confidence: {
      distribution: "beta",
      parameters: { alpha: 5, beta: 1 },
      raw: 5 / 6,
    },
    valid: { from: 0, to: Infinity },
    status: "candidate",
    source: "heuristic",
    provenance: { runId } as any,
    evidence: [],
    tags: [],
    schema: "v1",
  };
}

// ---------------------------------------------------------------------------
// 1. Admits a digest, retrievable via getDigest, and idempotent on re-run
// ---------------------------------------------------------------------------

it("admits a digest, retrievable via getDigest, and is idempotent on re-run", async () => {
  const { mneme, corpusId } = makeBioMneme();
  const gateway = createMnemeGateway(mneme, corpusId);

  // Seed a non-summary claim under runId "r1" so selectSummarizeInput has input
  const seedResult = gateway.apply(
    [{ kind: "derive", claim: makeCandidate({ key: "session.focus", runId: "r1" }) }],
    (_op, i) => `seed-${i}`
  );
  expect(seedResult.applied).toBe(1);

  // Confirm the seed landed; the fakeFn cites the live claim id directly from its input.
  const seeded = gateway.read({ corpusId, runIds: ["r1"] } as any);
  expect(seeded).toHaveLength(1);

  const fakeFn = async ({ claims }: any) => [
    { key: "session.digest", value: { kind: "text", v: "gist" }, cites: [claims[0].id] },
  ];
  const pass = createSummarizePass(gateway, fakeFn, { corpusId });
  const ep = makeEpisode("e1", ["r1"]);

  const r1 = await pass.summarize(ep, { modelVersion: "m1" });
  expect(r1.admitted).toBe(1);
  expect(r1.proposed).toBe(1);
  expect(r1.errors).toHaveLength(0);

  const digest = pass.getDigest(ep);
  expect(digest).toHaveLength(1);
  expect(digest[0].provenance.workflow).toBe("summary");

  // Second run: identity opKey → idempotent, admitted=0
  const r2 = await pass.summarize(ep, { modelVersion: "m1" });
  expect(r2.admitted).toBe(0);
});

// ---------------------------------------------------------------------------
// 2. Inputs are untouched (additive)
// ---------------------------------------------------------------------------

it("inputs are untouched after summarize — raw seeded claims remain", async () => {
  const { mneme, corpusId } = makeBioMneme();
  const gateway = createMnemeGateway(mneme, corpusId);

  gateway.apply(
    [{ kind: "derive", claim: makeCandidate({ key: "session.focus", runId: "r1" }) }],
    (_op, i) => `seed-${i}`
  );

  const fakeFn = async ({ claims }: any) => [
    { key: "session.digest", value: { kind: "text", v: "gist" }, cites: [claims[0].id] },
  ];
  const pass = createSummarizePass(gateway, fakeFn, { corpusId });
  const ep = makeEpisode("e2", ["r1"]);

  await pass.summarize(ep, { modelVersion: "m1" });

  // The seeded non-summary claim should still be present and unchanged
  const all = gateway.read({ corpusId, runIds: ["r1"] } as any);
  const nonSummary = all.filter((c) => c.provenance.workflow !== "summary");
  expect(nonSummary).toHaveLength(1);
  expect(nonSummary[0].key).toBe("session.focus");
});

// ---------------------------------------------------------------------------
// 3. getDigest returns [] for empty-runIds episode
// ---------------------------------------------------------------------------

it("getDigest returns [] for empty-runIds episode", async () => {
  const { mneme, corpusId } = makeBioMneme();
  const gateway = createMnemeGateway(mneme, corpusId);
  const pass = createSummarizePass(gateway, async () => [], { corpusId });
  const ep = makeEpisode("e3", []);
  expect(pass.getDigest(ep)).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// 4. summarize returns empty report for empty-runIds episode
// ---------------------------------------------------------------------------

it("summarize returns empty report without calling model for empty-runIds episode", async () => {
  const { mneme, corpusId } = makeBioMneme();
  const gateway = createMnemeGateway(mneme, corpusId);
  let modelCalled = false;
  const fakeFn = async () => { modelCalled = true; return []; };
  const pass = createSummarizePass(gateway, fakeFn, { corpusId });
  const ep = makeEpisode("e4", []);

  const r = await pass.summarize(ep, { modelVersion: "m1" });
  expect(r.proposed).toBe(0);
  expect(r.admitted).toBe(0);
  expect(r.errors).toHaveLength(0);
  expect(modelCalled).toBe(false);
});

// ---------------------------------------------------------------------------
// 5. summarizeFn throw yields errors, applies nothing
// ---------------------------------------------------------------------------

it("summarizeFn throw yields errors and applies nothing", async () => {
  const { mneme, corpusId } = makeBioMneme();
  const gateway = createMnemeGateway(mneme, corpusId);

  gateway.apply(
    [{ kind: "derive", claim: makeCandidate({ key: "session.focus", runId: "r1" }) }],
    (_op, i) => `seed-${i}`
  );

  const throwingFn = async () => { throw new Error("model offline"); };
  const pass = createSummarizePass(gateway, throwingFn, { corpusId });
  const ep = makeEpisode("e5", ["r1"]);

  const r = await pass.summarize(ep, { modelVersion: "m1" });
  expect(r.errors).toHaveLength(1);
  expect(r.errors[0]).toContain("model offline");
  expect(r.admitted).toBe(0);
});

// ---------------------------------------------------------------------------
// 6. Single-flight: concurrent re-entry returns error
// ---------------------------------------------------------------------------

it("single-flight: re-entrant summarize returns in-flight error and applies nothing", async () => {
  const { mneme, corpusId } = makeBioMneme();
  const realGateway = createMnemeGateway(mneme, corpusId);

  realGateway.apply(
    [{ kind: "derive", claim: makeCandidate({ key: "session.focus", runId: "r1" }) }],
    (_op, i) => `seed-${i}`
  );

  const ep = makeEpisode("e6", ["r1"]);
  let innerResult: any;

  // summarizeFn triggers the inner call before returning
  const reentrantFn = async ({ claims }: any) => {
    // This triggers re-entry during the outer summarize (same pass instance)
    innerResult = await pass.summarize(ep, { modelVersion: "m1" });
    return [{ key: "session.digest", value: { kind: "text", v: "x" }, cites: [claims[0].id] }];
  };

  const pass = createSummarizePass(realGateway, reentrantFn, { corpusId });
  await pass.summarize(ep, { modelVersion: "m1" });

  expect(innerResult).toBeDefined();
  expect(innerResult.errors).toHaveLength(1);
  expect(innerResult.errors[0]).toContain("in flight");
});

// ---------------------------------------------------------------------------
// 7. Empty selected set skips the model call
// ---------------------------------------------------------------------------

it("empty selected set (all claims are summaries) skips the model call", async () => {
  const { mneme, corpusId } = makeBioMneme();
  const gateway = createMnemeGateway(mneme, corpusId);
  // Don't seed any claims — selectSummarizeInput returns empty, so the model is never called
  let modelCalled = false;
  const fakeFn = async () => { modelCalled = true; return []; };
  const pass = createSummarizePass(gateway, fakeFn, { corpusId });
  const ep = makeEpisode("e7", ["r1"]);

  const r = await pass.summarize(ep, { modelVersion: "m1" });
  expect(r.proposed).toBe(0);
  expect(r.admitted).toBe(0);
  expect(modelCalled).toBe(false);
});
