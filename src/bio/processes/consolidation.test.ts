import { createConsolidatePass } from "./consolidation.js";
import { createMnemeGateway } from "../gateway.js";
import { makeBioMneme } from "../test-support.js";
import type { MnemeGateway } from "../gateway.js";
import type { Episode } from "../types.js";
import type { Claim, CandidateClaim } from "../../core/claim.js";
import { resolvePolicy } from "../policy.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEpisode(id = "ep1", runIds = ["r1"]): Episode {
  return { id, runIds, startedAt: 0 };
}

/**
 * Build a CandidateClaim seeded under a specific runId so that
 * gateway.read({ corpusId, runIds }) will find it.
 */
function makeCandidate(opts: {
  subject?: string;
  key?: string;
  runId?: string;
  status?: Claim["status"];
  alpha?: number;
  beta?: number;
  scopeHash?: string;
}): CandidateClaim {
  const {
    subject = "user.alice",
    key = "skill.typescript",
    runId = "r1",
    status = "candidate",
    alpha = 40,
    beta = 8,
  } = opts;
  return {
    profile: "p1" as any,
    workspace: "w1" as any,
    subject,
    key,
    scope: {},
    value: { kind: "scalar", v: 0.8 } as any,
    confidence: {
      distribution: "beta",
      parameters: { alpha, beta },
      raw: alpha / (alpha + beta),
    },
    valid: { from: 0, to: Infinity },
    status,
    source: "heuristic",
    provenance: { runId } as any,
    evidence: [],
    tags: [],
    schema: "v1",
  };
}

// ---------------------------------------------------------------------------
// 1. Promotes a corroborated candidate
// ---------------------------------------------------------------------------

it("promotes a high-confidence candidate and is idempotent on re-run", () => {
  const { mneme, corpusId } = makeBioMneme();
  const gateway = createMnemeGateway(mneme, corpusId);

  // Seed one high-confidence claim (Beta(40,8): mean≈0.833, lb clears validated@0.65)
  gateway.apply(
    [{ kind: "derive", claim: makeCandidate({ alpha: 40, beta: 8, status: "candidate" }) }],
    (_op, i) => `seed-${i}`
  );

  const episode = makeEpisode("ep1", ["r1"]);
  const pass = createConsolidatePass(gateway, undefined, corpusId);

  const first = pass.consolidate(episode);
  expect(first.promoted).toBeGreaterThan(0);
  expect(first.errors).toHaveLength(0);

  // Idempotent: re-run applies nothing (opKey is deterministic)
  const second = pass.consolidate(episode);
  expect(second.promoted).toBe(0);
  expect(second.errors).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// 2. Folds K agreeing claims
// ---------------------------------------------------------------------------

it("folds K agreeing claims: folded=1, deprecated=K, inputs disappear from default read", () => {
  const { mneme, corpusId } = makeBioMneme();
  const gateway = createMnemeGateway(mneme, corpusId);

  const K = resolvePolicy().consolidation.foldThreshold; // 3

  // Seed K claims with identical (subject, key, scope, value) under same runId
  for (let i = 0; i < K; i++) {
    gateway.apply(
      [
        {
          kind: "derive",
          claim: makeCandidate({
            subject: "user.bob",
            key: "skill.rust",
            runId: "r1",
            status: "candidate",
            alpha: 5,
            beta: 1,
          }),
        },
      ],
      (_op, j) => `seed-fold-${i}-${j}`
    );
  }

  const episode = makeEpisode("ep-fold", ["r1"]);
  const pass = createConsolidatePass(gateway, undefined, corpusId);
  const report = pass.consolidate(episode);

  expect(report.folded).toBe(1);
  expect(report.deprecated).toBe(K);
  expect(report.errors).toHaveLength(0);

  // Default read (no status filter) — deprecated inputs remain in store (append-only)
  const allClaims = gateway.read({ corpusId });
  const deprecatedInputs = allClaims.filter(
    (c) => c.status === "deprecated" && c.key === "skill.rust"
  );
  expect(deprecatedInputs).toHaveLength(K);

  // The active (non-deprecated) version is the folded one
  const active = allClaims.filter(
    (c) => c.status !== "deprecated" && c.key === "skill.rust"
  );
  expect(active).toHaveLength(1);
  expect(active[0].source).toBe("workflow");
});

// ---------------------------------------------------------------------------
// 3. Empty / no-eligible episode returns zero with no error
// ---------------------------------------------------------------------------

it("empty episode returns zero counts with no error", () => {
  const { mneme, corpusId } = makeBioMneme();
  const gateway = createMnemeGateway(mneme, corpusId);
  const episode = makeEpisode("ep-empty", ["r-nonexistent"]);
  const pass = createConsolidatePass(gateway, undefined, corpusId);
  const report = pass.consolidate(episode);
  expect(report.promoted).toBe(0);
  expect(report.folded).toBe(0);
  expect(report.errors).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// 4. gateway.read throwing → report with errors, nothing applied
// ---------------------------------------------------------------------------

it("gateway.read throwing yields errors report and applies nothing", () => {
  let applyCount = 0;
  const gateway: MnemeGateway = {
    read: () => {
      throw new Error("DB unavailable");
    },
    readByIds: () => [],
    apply: (ops, _key) => {
      applyCount++;
      return { applied: ops.length, skipped: 0 };
    },
  };
  const episode = makeEpisode("ep-err-read");
  const pass = createConsolidatePass(gateway);
  const report = pass.consolidate(episode);
  expect(report.errors).toHaveLength(1);
  expect(report.errors[0]).toContain("DB unavailable");
  expect(applyCount).toBe(0);
});

// ---------------------------------------------------------------------------
// 5. gateway.apply throwing → report with errors, atomic (fail-safe)
// ---------------------------------------------------------------------------

it("gateway.apply throwing yields errors report (fail-safe)", () => {
  const { mneme, corpusId } = makeBioMneme();
  const gateway = createMnemeGateway(mneme, corpusId);

  // Seed a high-confidence claim so planning produces ops
  gateway.apply(
    [{ kind: "derive", claim: makeCandidate({ alpha: 40, beta: 8, status: "candidate" }) }],
    (_op, i) => `seed-apply-err-${i}`
  );

  const throwingGateway: MnemeGateway = {
    read: (q) => gateway.read(q),
    readByIds: (ids) => gateway.readByIds(ids),
    apply: () => {
      throw new Error("SQLite disk full");
    },
  };

  const episode = makeEpisode("ep-apply-err", ["r1"]);
  const pass = createConsolidatePass(throwingGateway, undefined, corpusId);
  const report = pass.consolidate(episode);
  expect(report.errors).toHaveLength(1);
  expect(report.errors[0]).toContain("SQLite disk full");
  expect(report.promoted).toBe(0);
});

// ---------------------------------------------------------------------------
// 6. Single-flight: concurrent re-entry returns error immediately
// ---------------------------------------------------------------------------

it("single-flight: re-entrant consolidate(sameEpisode) returns in-flight error and applies nothing", () => {
  const episode = makeEpisode("ep-inflight");
  let applyCount = 0;

  // A gateway whose read re-enters pass.consolidate for the same episode
  const reentrantGateway: MnemeGateway = {
    read: () => {
      // Will be called during the outer consolidate — trigger inner call
      const inner = pass.consolidate(episode);
      expect(inner.errors).toHaveLength(1);
      expect(inner.errors[0]).toContain("in flight");
      expect(applyCount).toBe(0); // inner applied nothing
      return []; // outer read returns empty → no ops
    },
    readByIds: () => [],
    apply: (_ops, _key) => {
      applyCount++;
      return { applied: 0, skipped: 0 };
    },
  };

  const pass = createConsolidatePass(reentrantGateway);
  const outer = pass.consolidate(episode);
  expect(outer.errors).toHaveLength(0); // outer completed fine (no ops)
});

// ---------------------------------------------------------------------------
// 7. Per-call opts.consolidation override beats construction-time policy
// ---------------------------------------------------------------------------

it("per-call opts.consolidation override is used over construction-time policy", () => {
  // Construction-time: very high thresholds (nothing promotes)
  const strictPolicy = resolvePolicy({
    consolidation: {
      promoteThresholds: { provisional: 0.99, validated: 0.99 },
    },
  });

  const { mneme, corpusId } = makeBioMneme();
  const gateway = createMnemeGateway(mneme, corpusId);
  gateway.apply(
    [{ kind: "derive", claim: makeCandidate({ alpha: 40, beta: 8, status: "candidate" }) }],
    (_op, i) => `seed-override-${i}`
  );

  const episode = makeEpisode("ep-override", ["r1"]);
  const pass = createConsolidatePass(gateway, strictPolicy, corpusId);

  // With strict policy: nothing should be promoted
  const reportStrict = pass.consolidate(episode);
  expect(reportStrict.promoted).toBe(0);

  // Now with lenient override: provisional threshold=0.1 → promotes
  // Use a fresh episode id to avoid idempotency collision
  const episode2 = makeEpisode("ep-override-lenient", ["r1"]);
  const reportLenient = pass.consolidate(episode2, {
    consolidation: { promoteThresholds: { provisional: 0.1, validated: 0.1 } },
  });
  expect(reportLenient.promoted).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// 8. rejected ops surface in dropped
// ---------------------------------------------------------------------------

it("rejected ops from gateway.apply surface in dropped[]", () => {
  const { mneme, corpusId } = makeBioMneme();
  const realGateway = createMnemeGateway(mneme, corpusId);
  realGateway.apply(
    [{ kind: "derive", claim: makeCandidate({ alpha: 40, beta: 8, status: "candidate" }) }],
    (_op, i) => `seed-rej-${i}`
  );

  // Wrap gateway to inject a rejection
  const rejectingGateway: MnemeGateway = {
    read: (q) => realGateway.read(q),
    readByIds: (ids) => realGateway.readByIds(ids),
    apply: (ops, opKey) => {
      const rejected = ops.map((_op, i) => ({ key: opKey(_op, i), status: "forbidden" }));
      return { applied: 0, skipped: 0, rejected };
    },
  };

  const episode = makeEpisode("ep-rejected", ["r1"]);
  const pass = createConsolidatePass(rejectingGateway, undefined, corpusId);
  const report = pass.consolidate(episode);
  expect(report.dropped.length).toBeGreaterThan(0);
  expect(report.errors).toHaveLength(0); // rejections go to dropped, not errors
});
