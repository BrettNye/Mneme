/**
 * End-to-end acceptance gate: Reduced Worked Query 1
 *
 * Pipeline: τ_now → σ_subject=lineage-block → δ_exponential(30d)
 *           → (σ_status=validated ∧ confidence>0.7) → ρ_jaccard → γ_2 → κ_xml(12000)
 *
 * Corpus seeded with 6 claims covering every filter branch.
 */

import {
  createMneme,
  createSqliteAdapter,
  pipe,
  leaf,
  sigma,
  tau,
  delta,
  rho,
  gamma,
  kappa,
} from "../../src/index.js";
import type { ComposedContext } from "../../src/index.js";
import { newClaimId } from "../../src/core/ids.js";
import { scopeHash } from "../../src/core/scope.js";
import { valueHash } from "../../src/core/value.js";

const DAY = 86_400_000;

const highConf = {
  distribution: "beta" as const,
  parameters: { alpha: 9, beta: 1 },
  raw: 0.9,
};

const lowConf = {
  distribution: "beta" as const,
  parameters: { alpha: 1, beta: 9 },
  raw: 0.1,
};

function makeCandidate(overrides: {
  subject: string;
  key: string;
  value: string;
  confidence: typeof highConf | typeof lowConf;
  status?: "validated" | "deprecated";
  evidence?: { kind: "claim"; claimId: string }[];
}) {
  return {
    profile: "p" as any,
    workspace: "workspace:canopy" as any,
    subject: overrides.subject,
    key: overrides.key,
    scope: {},
    value: overrides.value,
    confidence: overrides.confidence,
    valid: { from: 0, to: Infinity },
    source: "workflow" as const,
    provenance: {},
    evidence: (overrides.evidence ?? []) as any[],
    tags: [],
    schema: "1.0.0",
    ...(overrides.status ? { status: overrides.status } : {}),
  };
}

it("reduced Worked Query 1: end-to-end pipeline filters and ranks correctly", () => {
  // ── Setup ────────────────────────────────────────────────────────────────────
  const adapter = createSqliteAdapter();
  const m = createMneme({ adapter, availableTiers: [{ kind: "core" }] });

  m.createCorpus({
    id: "workspace:canopy",
    displayName: "Canopy Workspace",
    schema: {
      version: "1.0.0",
      subjects: ["lineage-block", "user"],
      scopeFields: {},
      required: [],
      scalarPseudocount: { workflow: 4, manual: 8 },
    },
    defaults: {
      decayPolicy: { kind: "exponential", halfLifeDays: 30 },
      confidenceThreshold: 0.7,
      contradictionPolicy: { kind: "always_accept" },
      defaultStatus: ["validated"],
    },
    requiredTiers: [{ kind: "core" }],
    metadata: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  // 1. Cited evidence claim (will be pulled in by γ at depth ≤2).
  const cited = m.commit(
    "workspace:canopy",
    makeCandidate({
      subject: "lineage-block",
      key: "lineage-block.evidence",
      value: "lineage block provenance record",
      confidence: highConf,
    }),
    { writer: "test" }
  );

  // 2. Believed claim (should rank #1, references the cited claim).
  m.commit(
    "workspace:canopy",
    makeCandidate({
      subject: "lineage-block",
      key: "lineage-block.schema",
      value: "lineage block schema design considerations",
      confidence: highConf,
      evidence: [{ kind: "claim", claimId: cited.id }],
    }),
    { writer: "test" }
  );

  // 3. Off-subject claim — filtered by σ_subject=lineage-block.
  m.commit(
    "workspace:canopy",
    makeCandidate({
      subject: "user",
      key: "user.pref",
      value: "off-subject user preference",
      confidence: highConf,
    }),
    { writer: "test" }
  );

  // 4. Low-confidence claim — passes subject/status but fails σ_confidence>0.7.
  m.commit(
    "workspace:canopy",
    makeCandidate({
      subject: "lineage-block",
      key: "lineage-block.low",
      value: "lineage block low confidence note",
      confidence: lowConf,
    }),
    { writer: "test" }
  );

  // 5. Deprecated claim — fails σ_status=validated.
  m.commit(
    "workspace:canopy",
    makeCandidate({
      subject: "lineage-block",
      key: "lineage-block.deprecated",
      value: "lineage block deprecated note",
      confidence: highConf,
      status: "deprecated",
    }),
    { writer: "test" }
  );

  // 6. Stale claim — inserted directly so `recorded` can be set to 90 days ago.
  //    With δ_exponential(30d) and age≈90d: effective ≈ 0.9 * 0.5^3 ≈ 0.11 < 0.7 → filtered.
  const staleValue = "lineage block stale schema considerations";
  adapter.insertClaim({
    id: newClaimId(),
    profile: "p" as any,
    workspace: "workspace:canopy" as any,
    subject: "lineage-block",
    key: "lineage-block.stale",
    scope: {},
    scopeHash: scopeHash({}),
    value: staleValue,
    valueHash: valueHash(staleValue),
    confidence: highConf,
    valid: { from: 0, to: Infinity },
    recorded: Date.now() - 90 * DAY,
    recordedSeq: 999,
    status: "validated",
    source: "workflow",
    provenance: {},
    evidence: [],
    tags: [],
    schema: "1.0.0",
  } as any);

  // ── Run the pipeline ─────────────────────────────────────────────────────────
  const ctx = m.query(
    "workspace:canopy",
    pipe(
      leaf("workspace:canopy"),
      tau.now(),
      sigma({ op: "subjectEq", value: "lineage-block" }),
      delta.exponential(30),
      sigma({
        op: "and",
        preds: [
          { op: "statusEq", value: "validated" },
          { op: "confidenceGt", value: 0.7 },
        ],
      }),
      rho.jaccard("lineage block schema considerations"),
      gamma(2),
      kappa.xml(12000)
    )
  ) as ComposedContext;

  // ── Assertions ───────────────────────────────────────────────────────────────

  // Well-formed XML output
  expect(ctx.format).toBe("xml");
  expect(ctx.content.startsWith("<context>")).toBe(true);

  // Within token budget
  expect(ctx.tokenCount).toBeLessThanOrEqual(12000);

  // Survived claims are present
  expect(ctx.content).toContain("schema design considerations");
  expect(ctx.content).toContain("provenance record");

  // Filtered claims are absent. Each guard uses a multi-word fragment unique to
  // that claim's value so it cannot collide with XML structural tokens/metadata.
  expect(ctx.content).not.toContain("off-subject");
  expect(ctx.content).not.toContain("low confidence");
  expect(ctx.content).not.toContain("deprecated note");
  // The stale claim is removed specifically by decay (high raw 0.9, but δ_exponential
  // over its ~90-day age drops effective <0.7); "stale schema considerations" is unique
  // to its value — a bare "stale" could false-match future decay-policy metadata.
  expect(ctx.content).not.toContain("stale schema considerations");

  // Believed claim ranks before the score-0 evidence claim
  const believedPos = ctx.content.indexOf("schema design considerations");
  const evidencePos = ctx.content.indexOf("provenance record");
  expect(believedPos).toBeGreaterThanOrEqual(0);
  expect(evidencePos).toBeGreaterThanOrEqual(0);
  expect(believedPos).toBeLessThan(evidencePos);
});
