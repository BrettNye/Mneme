import { createDreamPass } from "./dreaming.js";
import { createMnemeGateway } from "../gateway.js";
import { createSqliteAdapter } from "../../adapters/sqlite.js";
import type { MnemeGateway } from "../gateway.js";
import type { Episode, AppendOp } from "../types.js";
import type { Claim } from "../../core/claim.js";
import type { ClaimId } from "../../core/ids.js";
import { MAX_DREAM_DEPTH, depthOf, isUnvalidatedDream, DREAM_WORKFLOW, depthTag } from "./dreaming-types.js";
import type { DreamFn, ProposedInsight } from "./dreaming-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClaim(
  id: string,
  overrides: {
    recorded?: number;
    status?: string;
    workflow?: string;
    tags?: string[];
    confidenceRaw?: number;
    runId?: string;
    key?: string;
  } = {}
): Claim {
  return {
    id: id as ClaimId,
    profile: "p1" as any,
    workspace: "w1" as any,
    subject: "lesson",
    key: overrides.key ?? "lesson.x",
    scope: {},
    scopeHash: "sh",
    value: { text: "v" },
    valueHash: "vh",
    confidence: {
      distribution: "beta",
      parameters: { alpha: 2, beta: 2 },
      raw: overrides.confidenceRaw ?? 0.9,
    },
    valid: { from: 0, to: Infinity },
    recorded: overrides.recorded ?? 1,
    recordedSeq: 0,
    status: (overrides.status ?? "validated") as any,
    source: "manual" as any,
    provenance: {
      workflow: overrides.workflow ?? "extract",
      runId: overrides.runId ?? "r1",
    } as any,
    evidence: [],
    tags: overrides.tags ?? [],
    schema: "1.0",
  } as unknown as Claim;
}

function makeEpisode(id = "ep1", runIds = ["r1"]): Episode {
  return { id, runIds, startedAt: 0 };
}

function makeStubGateway(claims: Claim[]): MnemeGateway {
  return {
    read: () => claims,
    readByIds: (ids: ClaimId[]) => claims.filter((c) => ids.includes(c.id as ClaimId)),
    apply: (ops: AppendOp[], _opKey: (op: AppendOp, i: number) => string) => ({
      applied: ops.length,
      skipped: 0,
    }),
  } as any;
}

// Spec-provided test from task body
it("a throwing DreamFn is fail-safe: errors reported, nothing applied", async () => {
  const gateway = {
    read: () => [
      {
        id: "g1",
        recorded: 1,
        tags: [],
        status: "validated",
        provenance: { workflow: "x" },
        confidence: { raw: 0.9 },
        profile: "p",
        workspace: "w",
        valid: { from: 0, to: Infinity },
        schema: "1.0",
      },
    ],
    apply: () => ({ applied: 0, skipped: 0 }),
  } as any;
  const pass = createDreamPass(gateway, async () => {
    throw new Error("model down");
  });
  const report = await pass.dream(
    { id: "ep", runIds: ["r1"], startedAt: 0 } as any,
    { modelVersion: "m1" }
  );
  expect(report.errors).toHaveLength(1);
  expect(report.admitted).toBe(0);
});

// ---------------------------------------------------------------------------
// Happy path: selects → calls DreamFn once → admits → gateway.apply
// ---------------------------------------------------------------------------

it("happy path: calls DreamFn once and returns proposed/admitted counts", async () => {
  const claim = makeClaim("g1");
  let dreamFnCallCount = 0;
  const dreamFn: DreamFn = async ({ claims }) => {
    dreamFnCallCount++;
    return [{ key: "lesson.derived-a", value: { text: "result" }, cites: [claims[0].id] }];
  };
  let appliedOps: AppendOp[] = [];
  const gateway: MnemeGateway = {
    read: () => [claim],
    readByIds: () => [],
    apply: (ops: AppendOp[], _opKey: (op: AppendOp, i: number) => string) => {
      appliedOps = ops;
      return { applied: ops.length, skipped: 0 };
    },
  } as any;
  const pass = createDreamPass(gateway, dreamFn);
  const report = await pass.dream(makeEpisode(), { modelVersion: "m1" });
  expect(dreamFnCallCount).toBe(1);
  expect(report.proposed).toBe(1);
  expect(report.admitted).toBe(1);
  expect(report.dropped).toHaveLength(0);
  expect(report.errors).toHaveLength(0);
  expect(appliedOps).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Empty selected set → returns immediately without calling DreamFn
// ---------------------------------------------------------------------------

it("returns immediately without calling DreamFn when no eligible claims exist", async () => {
  let dreamFnCalled = false;
  const dreamFn: DreamFn = async () => {
    dreamFnCalled = true;
    return [];
  };
  // No claims returned from read
  const gateway: MnemeGateway = {
    read: () => [],
    readByIds: () => [],
    apply: () => ({ applied: 0, skipped: 0 }),
  } as any;
  const pass = createDreamPass(gateway, dreamFn);
  const report = await pass.dream(makeEpisode(), { modelVersion: "m1" });
  expect(dreamFnCalled).toBe(false);
  expect(report.proposed).toBe(0);
  expect(report.admitted).toBe(0);
  expect(report.errors).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Rejecting DreamFn → errors non-empty, nothing applied (fail-safe)
// ---------------------------------------------------------------------------

it("a rejecting DreamFn is fail-safe: errors has one entry, nothing applied", async () => {
  const claim = makeClaim("g1");
  let applyCallCount = 0;
  const gateway: MnemeGateway = {
    read: () => [claim],
    readByIds: () => [],
    apply: (_ops: AppendOp[], _opKey: (op: AppendOp, i: number) => string) => {
      applyCallCount++;
      return { applied: 0, skipped: 0 };
    },
  } as any;
  const pass = createDreamPass(
    gateway,
    async () => Promise.reject(new Error("llm rejected"))
  );
  const report = await pass.dream(makeEpisode(), { modelVersion: "m1" });
  expect(report.errors).toHaveLength(1);
  expect(report.errors[0]).toContain("llm rejected");
  expect(report.admitted).toBe(0);
  expect(applyCallCount).toBe(0);
});

// ---------------------------------------------------------------------------
// Single-flight per episode: concurrent dream(sameEpisode) → error, no apply
// ---------------------------------------------------------------------------

it("single-flight: concurrent dream call for same episode returns an error immediately", async () => {
  const claim = makeClaim("g1");
  let resolve!: (v: ProposedInsight[]) => void;
  const blockingDreamFn: DreamFn = async () =>
    new Promise<ProposedInsight[]>((res) => {
      resolve = res;
    });
  const gateway: MnemeGateway = {
    read: () => [claim],
    readByIds: () => [],
    apply: (_ops: AppendOp[], _opKey: (op: AppendOp, i: number) => string) => ({
      applied: 1,
      skipped: 0,
    }),
  } as any;
  const pass = createDreamPass(gateway, blockingDreamFn);
  const ep = makeEpisode("blocking-ep");

  // Start first dream (will block waiting for promise)
  const firstPromise = pass.dream(ep, { modelVersion: "m1" });

  // Second call while first is still running
  const secondReport = await pass.dream(ep, { modelVersion: "m1" });
  expect(secondReport.errors).toHaveLength(1);
  expect(secondReport.errors[0]).toContain("single-flight");
  expect(secondReport.admitted).toBe(0);

  // Unblock first
  resolve([]);
  await firstPromise;
});

// ---------------------------------------------------------------------------
// Collapse property test (centerpiece):
//   (a) no admitted claim's dream-depth exceeds MAX_DREAM_DEPTH
//   (b) DreamFn always receives only validated claims (no unvalidated dreams)
// ---------------------------------------------------------------------------

it(
  "collapse property: depth stays bounded and DreamFn never sees unvalidated dreams across repeated passes",
  async () => {
    // Use real in-memory gateway for an honest end-to-end signal
    const adapter = createSqliteAdapter(":memory:");
    const gateway = createMnemeGateway(adapter);

    // Seed with some validated non-dream claims
    const seedClaims: Claim[] = [
      makeClaim("seed-1", { recorded: 1, runId: "r1", key: "lesson.seed-a" }),
      makeClaim("seed-2", { recorded: 2, runId: "r1", key: "lesson.seed-b" }),
      makeClaim("seed-3", { recorded: 3, runId: "r1", key: "lesson.seed-c" }),
    ];

    // Insert seed claims into the real adapter
    for (const c of seedClaims) {
      adapter.insertClaim(c);
    }

    // Track all DreamFn invocations so we can assert on the input
    const dreamFnInputSets: Claim[][] = [];
    let insightCounter = 0;

    // DreamFn that always tries to cite the most-recent claims (may include prior dreams)
    const greedyDreamFn: DreamFn = async ({ claims }) => {
      dreamFnInputSets.push([...claims]);
      if (claims.length === 0) return [];
      // Always cite the last claim (most recent, which may be a dream itself)
      const mostRecent = claims[claims.length - 1];
      insightCounter++;
      return [
        {
          key: `lesson.dream-insight-${insightCounter}` as any,
          value: { text: `derived from ${mostRecent.id}` },
          cites: [mostRecent.id],
        },
      ];
    };

    const pass = createDreamPass(gateway, greedyDreamFn);
    const episode: Episode = { id: "ep-collapse", runIds: ["r1"], startedAt: 0 };

    // Run enough passes to exceed MAX_DREAM_DEPTH if depth was unbounded
    const PASSES = MAX_DREAM_DEPTH + 3; // would exceed cap if not bounded
    for (let i = 0; i < PASSES; i++) {
      const report = await pass.dream(episode, { modelVersion: "test-v1" });
      // Each pass should not error
      expect(report.errors).toHaveLength(0);
    }

    // (a) Assert every admitted claim's depth ≤ MAX_DREAM_DEPTH
    const allClaims = adapter.query({ corpusId: "bio", runIds: ["r1"] });
    const dreamClaims = allClaims.filter((c) => c.provenance.workflow === DREAM_WORKFLOW);
    for (const dc of dreamClaims) {
      const depth = depthOf(dc);
      expect(depth).toBeLessThanOrEqual(MAX_DREAM_DEPTH);
    }

    // (b) Assert DreamFn never received an unvalidated dream claim
    for (const inputSet of dreamFnInputSets) {
      for (const c of inputSet) {
        expect(isUnvalidatedDream(c)).toBe(false);
      }
    }

    // Verify the property test was actually exercised (passes happened)
    expect(dreamFnInputSets.length).toBeGreaterThan(0);
  },
  15_000 // allow up to 15s for SQLite passes
);
