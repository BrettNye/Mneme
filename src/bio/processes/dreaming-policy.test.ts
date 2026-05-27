import { createDreamPass } from "./dreaming.js";
import { createMnemeGateway } from "../gateway.js";
import { makeBioMneme } from "../test-support.js";
import type { MnemeGateway } from "../gateway.js";
import type { Claim, CandidateClaim } from "../../core/claim.js";
import type { AppendOp } from "../types.js";

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
    id: id as any,
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

// ---------------------------------------------------------------------------
// custom prior flows through to admitted claim's Beta parameters
// ---------------------------------------------------------------------------

it("a custom dreaming.prior is used as the admitted dream's confidence", async () => {
  const claim = makeClaim("g1", { key: "lesson.seed" });
  let capturedClaim: any = null;
  const gateway: MnemeGateway = {
    read: () => [claim],
    readByIds: () => [],
    apply: (ops: AppendOp[], _opKey: any) => {
      if (ops.length > 0 && ops[0].kind === "derive") {
        capturedClaim = (ops[0] as any).claim;
      }
      return { applied: ops.length, skipped: 0 };
    },
  } as any;

  const pass = createDreamPass(
    gateway,
    async ({ claims }) => [
      { key: "lesson.derived" as any, value: { text: "result" }, cites: [claims[0].id] },
    ],
    { prior: { alpha: 5, beta: 5 } }
  );
  const report = await pass.dream(
    { id: "ep1", runIds: ["r1"], startedAt: 0 } as any,
    { modelVersion: "m1" }
  );
  expect(report.admitted).toBe(1);
  expect(capturedClaim).not.toBeNull();
  expect(capturedClaim.confidence.parameters.alpha).toBe(5);
  expect(capturedClaim.confidence.parameters.beta).toBe(5);
  expect(capturedClaim.confidence.raw).toBe(5 / (5 + 5));
});

// ---------------------------------------------------------------------------
// custom maxDepth tightens the collapse depth cap
// ---------------------------------------------------------------------------

it("a custom dreaming.maxDepth=1 excludes claims with depth >= 1", async () => {
  // depth-1 claim should be excluded when maxDepth=1
  const depth1Claim = makeClaim("d1", { tags: ["dream-depth:1"], status: "validated", workflow: "dream" });
  const plainClaim = makeClaim("g1", { key: "lesson.plain" });
  let selectedClaims: Claim[] = [];
  const gateway: MnemeGateway = {
    read: () => [depth1Claim, plainClaim],
    readByIds: () => [],
    apply: (ops: AppendOp[], _opKey: any) => ({ applied: ops.length, skipped: 0 }),
  } as any;

  const pass = createDreamPass(
    gateway,
    async ({ claims }) => {
      selectedClaims = [...claims];
      return [
        { key: "lesson.derived" as any, value: { text: "v" }, cites: [claims[0].id] },
      ];
    },
    { maxDepth: 1 }
  );
  await pass.dream(
    { id: "ep2", runIds: ["r1"], startedAt: 0 } as any,
    { modelVersion: "m1" }
  );
  // depth-1 claim is at or above maxDepth=1, so it should not appear in selectedClaims
  expect(selectedClaims.map((c) => c.id)).not.toContain("d1");
  expect(selectedClaims.map((c) => c.id)).toContain("g1");
});

// ---------------------------------------------------------------------------
// custom maxInputClaims tightens the select bound
// ---------------------------------------------------------------------------

it("a custom dreaming.maxInputClaims=2 limits the input to 2 claims", async () => {
  const claims = Array.from({ length: 5 }, (_, i) =>
    makeClaim(`c${i}`, { recorded: i, key: `lesson.seed${i}` })
  );
  let selectedCount = 0;
  const gateway: MnemeGateway = {
    read: () => claims,
    readByIds: () => [],
    apply: (ops: AppendOp[], _opKey: any) => ({ applied: ops.length, skipped: 0 }),
  } as any;

  const pass = createDreamPass(
    gateway,
    async ({ claims: inputClaims }) => {
      selectedCount = inputClaims.length;
      return [
        {
          key: "lesson.derived" as any,
          value: { text: "v" },
          cites: [inputClaims[0].id],
        },
      ];
    },
    { maxInputClaims: 2 }
  );
  await pass.dream(
    { id: "ep3", runIds: ["r1"], startedAt: 0 } as any,
    { modelVersion: "m1" }
  );
  expect(selectedCount).toBe(2);
});

// ---------------------------------------------------------------------------
// no policy arg → defaults preserved (behavior preservation)
// ---------------------------------------------------------------------------

it("createDreamPass with no dreaming policy uses default prior (alpha:1, beta:3)", async () => {
  const claim = makeClaim("g1", { key: "lesson.seed" });
  let capturedClaim: any = null;
  const gateway: MnemeGateway = {
    read: () => [claim],
    readByIds: () => [],
    apply: (ops: AppendOp[], _opKey: any) => {
      if (ops.length > 0 && ops[0].kind === "derive") {
        capturedClaim = (ops[0] as any).claim;
      }
      return { applied: ops.length, skipped: 0 };
    },
  } as any;

  const pass = createDreamPass(
    gateway,
    async ({ claims }) => [
      { key: "lesson.derived" as any, value: { text: "result" }, cites: [claims[0].id] },
    ]
    // no opts
  );
  const report = await pass.dream(
    { id: "ep4", runIds: ["r1"], startedAt: 0 } as any,
    { modelVersion: "m1" }
  );
  expect(report.admitted).toBe(1);
  expect(capturedClaim).not.toBeNull();
  expect(capturedClaim.confidence.parameters.alpha).toBe(1);
  expect(capturedClaim.confidence.parameters.beta).toBe(3);
});
