import { createDreamPass } from "./dreaming.js";
import { createMnemeGateway } from "../gateway.js";
import { createSqliteAdapter } from "../../adapters/sqlite.js";
import type { MnemeGateway } from "../gateway.js";
import type { Episode, AppendOp } from "../types.js";
import type { Claim } from "../../core/claim.js";
import type { ClaimId } from "../../core/ids.js";
import { MAX_DREAM_DEPTH, depthOf, isUnvalidatedDream, DREAM_WORKFLOW } from "./dreaming-types.js";
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


// ---------------------------------------------------------------------------
// gateway.apply throws → resolves with errors, does NOT reject (fail-safe)
// ---------------------------------------------------------------------------

it("a throwing gateway.apply is fail-safe: dream() resolves with errors and admitted:0", async () => {
  const claim = makeClaim("g1");
  const gateway: MnemeGateway = {
    read: () => [claim],
    readByIds: () => [],
    apply: () => {
      throw new Error("SQLite disk full");
    },
  } as any;
  const pass = createDreamPass(gateway, async ({ claims }) => [
    { key: "lesson.x" as any, value: { text: "v" }, cites: [claims[0].id] },
  ]);
  const report = await pass.dream(makeEpisode(), { modelVersion: "m1" });
  expect(report.errors).toHaveLength(1);
  expect(report.errors[0]).toContain("SQLite disk full");
  expect(report.admitted).toBe(0);
});

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
//   (a) a depth-MAX_DREAM_DEPTH dream IS admitted (non-vacuous); no claim
//       exceeds MAX_DREAM_DEPTH
//   (b) DreamFn always receives only validated claims (no unvalidated dreams)
// ---------------------------------------------------------------------------

it(
  "collapse property: depth stays bounded and DreamFn never sees unvalidated dreams across repeated passes",
  async () => {
    // Use real in-memory gateway + adapter for an honest end-to-end signal
    const adapter = createSqliteAdapter(":memory:");
    const gateway = createMnemeGateway(adapter);

    // Seed with validated non-dream claims (run_id = "r1" so selectDreamInput
    // can query them via episode.runIds = ["r1"])
    const seedClaims: Claim[] = [
      makeClaim("seed-1", { recorded: 1, runId: "r1", key: "lesson.seed-a" }),
      makeClaim("seed-2", { recorded: 2, runId: "r1", key: "lesson.seed-b" }),
      makeClaim("seed-3", { recorded: 3, runId: "r1", key: "lesson.seed-c" }),
    ];
    for (const c of seedClaims) {
      adapter.insertClaim(c);
    }

    // Track all DreamFn invocations so we can assert on their input
    const dreamFnInputSets: Claim[][] = [];
    let insightCounter = 0;

    // Greedy DreamFn: cites claims[0] — the most-recent after selectDreamInput
    // sorts by recorded desc. Once prior dreams are promoted and re-inserted
    // with run_id="r1" they enter the pool and can be cited, allowing depth to
    // accumulate pass-over-pass.
    const greedyDreamFn: DreamFn = async ({ claims }) => {
      dreamFnInputSets.push([...claims]);
      if (claims.length === 0) return [];
      const mostRecent = claims[0]; // sorted by recorded desc in selectDreamInput
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

    // Run MAX_DREAM_DEPTH + 2 passes.  Each pass uses a unique episode ID so
    // the idempotency key `dream:<episodeId>:<opIndex>` is fresh every pass.
    // Between passes we "promote" newly admitted candidate dreams by
    // re-inserting them with status="validated" and provenance.runId="r1" so
    // that selectDreamInput (which filters run_id IN ["r1"]) picks them up on
    // the next pass and depth can accumulate.
    const PASSES = MAX_DREAM_DEPTH + 2; // would exceed cap if unbounded
    for (let i = 0; i < PASSES; i++) {
      const episode: Episode = { id: `ep-collapse-${i}`, runIds: ["r1"], startedAt: 0 };
      const report = await pass.dream(episode, { modelVersion: "test-v1" });
      expect(report.errors).toHaveLength(0);

      // Promote all newly admitted candidate dream claims so they re-enter the
      // dreamable pool next pass.  Admitted dreams have run_id=null (the
      // dreaming-admit provenance carries no runId), so we re-insert them with
      // provenance.runId="r1" and status="validated" directly via the adapter.
      // INSERT OR REPLACE on the same id updates the existing row in-place.
      const allInStore = adapter.query({ corpusId: "bio" }); // no runIds filter
      const candidateDreams = allInStore.filter(
        (c) => c.provenance.workflow === DREAM_WORKFLOW && c.status === "candidate"
      );
      for (const dream of candidateDreams) {
        adapter.insertClaim({
          ...dream,
          status: "validated",
          provenance: { ...dream.provenance, runId: "r1" },
        });
      }
    }

    // Collect all dream claims in the store (query without runIds to see all)
    const allInStore = adapter.query({ corpusId: "bio" });
    const dreamClaims = allInStore.filter((c) => c.provenance.workflow === DREAM_WORKFLOW);

    // (a) At least one dream has depth === MAX_DREAM_DEPTH — proves depth
    //     actually accumulated (test is non-vacuous).  Also no dream exceeds
    //     the cap (the depth-filter in selectDreamInput prevents it).
    const depths = dreamClaims.map((dc) => depthOf(dc));
    expect(depths.some((d) => d === MAX_DREAM_DEPTH)).toBe(true);
    for (const d of depths) {
      expect(d).toBeLessThanOrEqual(MAX_DREAM_DEPTH);
    }

    // (b) DreamFn must never have received an unvalidated dream claim as input
    for (const inputSet of dreamFnInputSets) {
      for (const c of inputSet) {
        expect(isUnvalidatedDream(c)).toBe(false);
      }
    }

    // Sanity: at least one DreamFn invocation happened
    expect(dreamFnInputSets.length).toBeGreaterThan(0);
  },
  15_000 // allow up to 15s for SQLite passes
);
