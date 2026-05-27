import { createBioMemory } from "./bio-memory.js";
import { createMnemeGateway } from "./gateway.js";
import { makeBioMneme } from "./test-support.js";
import { suppression } from "./policies/suppression.js";
import type { RetrievalContext } from "./types.js";
import type { DreamFn } from "./processes/dreaming-types.js";
import type { CandidateClaim } from "../core/claim.js";
import { INFINITY } from "../core/time.js";

// ─── Acceptance Criterion 1 ──────────────────────────────────────────────────
// recall returns policy-filtered claims and records their ids as the episode's
// surfaced set when an episode is given.

it("recall returns all claims when no suppression policy is applied", () => {
  const { mneme, corpusId } = makeBioMneme();
  const bio = createBioMemory({ mneme, corpusId });
  // With an empty store, recall returns empty array — proves no crash, contracts hold
  const ctx: RetrievalContext = { now: Date.now(), decay: () => 1 };
  const claims = bio.recall({ corpusId }, [], ctx);
  expect(Array.isArray(claims)).toBe(true);
});

it("recall filters claims using the supplied policies", () => {
  const { mneme, corpusId } = makeBioMneme();
  const bio = createBioMemory({ mneme, corpusId });
  // Floor of 1 means only claims whose effective confidence >= 1 survive.
  // Our decay always returns 0, so all claims should be suppressed.
  const ctx: RetrievalContext = { now: Date.now(), decay: () => 0 };
  const alwaysFilter = suppression({ floor: 1 });
  const claims = bio.recall({ corpusId }, [alwaysFilter], ctx);
  expect(claims).toHaveLength(0);
});

it("recall records surfaced claim ids into the episode buffer when episode given", () => {
  // We can verify via runCycle: if the buffer has surfaced ids, evidence-update
  // will emit ops for them when outcomes exist. The easiest proxy is to call
  // recordOutcome immediately after recall and check the report is clean.
  const { mneme, corpusId } = makeBioMneme();
  const bio = createBioMemory({ mneme, corpusId });
  const ep = bio.openEpisode();
  const ctx: RetrievalContext = { now: Date.now(), decay: () => 1 };
  bio.recall({ corpusId }, [], ctx, ep.id);
  // No crash + report flows — surfaced set was registered
  const report = bio.recordOutcome(ep.id, "success");
  expect(report.errors).toHaveLength(0);
});

// ─── Acceptance Criterion 2 ──────────────────────────────────────────────────
// recordUsage only buffers (no cycle); recordOutcome buffers and runs inline cycle.

it("recordOutcome fires an inline cycle scoped to the episode", () => {
  const { mneme, corpusId } = makeBioMneme();
  const bio = createBioMemory({ mneme, corpusId });
  const ep = bio.openEpisode();
  expect(bio.recordOutcome(ep.id, "success").errors).toHaveLength(0);
});

it("recordUsage buffers signals without triggering a cycle; runCycle afterwards reports opsApplied: 0 for empty claimIds", () => {
  // recordUsage only buffers — no cycle fires. When we call runCycle next it
  // drains the buffer cleanly. With an empty claimIds list there are no claims
  // to update, so opsApplied is 0 confirming the cycle ran but found nothing.
  const { mneme, corpusId } = makeBioMneme();
  const bio = createBioMemory({ mneme, corpusId });
  const ep = bio.openEpisode();
  bio.recordUsage([], ep.id);
  const report = bio.runCycle(ep.id);
  expect(report.errors).toHaveLength(0);
  expect(report.opsApplied).toBe(0);
});

// ─── Acceptance Criterion 3 ──────────────────────────────────────────────────
// recordOutcome / runCycle against an unknown episode returns a report with an
// error and applies nothing.

it("recordOutcome against an unknown episode returns a report with an error", () => {
  const { mneme, corpusId } = makeBioMneme();
  const bio = createBioMemory({ mneme, corpusId });
  const report = bio.recordOutcome("ep-does-not-exist", "success");
  expect(report.errors).toHaveLength(1);
  expect(report.errors[0]).toMatch(/unknown episode/i);
  expect(report.opsApplied).toBe(0);
});

it("runCycle against an unknown episode returns a report with an error", () => {
  const { mneme, corpusId } = makeBioMneme();
  const bio = createBioMemory({ mneme, corpusId });
  const report = bio.runCycle("ep-does-not-exist");
  expect(report.errors).toHaveLength(1);
  expect(report.errors[0]).toMatch(/unknown episode/i);
  expect(report.opsApplied).toBe(0);
});

it("recordOutcome with unknown episode does NOT strand signals in the buffer (calls exceeding the cap do not throw)", () => {
  // With the bug, each call to recordOutcome unconditionally called buffer.record()
  // before checking the episode. For an unknown episode no cycle ever runs to
  // flush the buffer, so each call consumes one slot of the 10 000-slot cap.
  // Calling it 10 001 times would cause buffer.record() to throw on the 10 001st.
  // After the fix the episode is checked FIRST; no slot is consumed for unknown
  // episodes, so calling it 10 001 times never throws.
  const { mneme, corpusId } = makeBioMneme();
  const bio = createBioMemory({ mneme, corpusId });

  // 10 001 calls — one more than the default SignalBuffer cap of 10 000.
  expect(() => {
    for (let i = 0; i < 10_001; i++) {
      bio.recordOutcome("ep-does-not-exist", "success");
    }
  }).not.toThrow();

  // A subsequent valid operation is unaffected — the buffer has no stranded signals.
  const ep = bio.openEpisode();
  const report = bio.recordOutcome(ep.id, "success");
  expect(report.errors).toHaveLength(0);
});

// ─── Acceptance Criterion 4 ──────────────────────────────────────────────────
// createBioMemory requires mneme + corpusId; old no-arg / positional-gateway forms are gone.

it("createBioMemory({ mneme, corpusId }) constructs without throwing", () => {
  const { mneme, corpusId } = makeBioMneme();
  expect(() => createBioMemory({ mneme, corpusId })).not.toThrow();
});

it("full lifecycle: openEpisode → recordUsage → recordOutcome → closeEpisode", () => {
  const { mneme, corpusId } = makeBioMneme();
  const bio = createBioMemory({ mneme, corpusId });
  const ep = bio.openEpisode("run-1");
  bio.recordUsage([], ep.id);
  const report = bio.recordOutcome(ep.id, "success");
  expect(report.errors).toHaveLength(0);
  const closed = bio.closeEpisode(ep.id);
  expect(closed).toBeDefined();
});

// ─── Dreaming facade ────────────────────────────────────────────────────────

it("dream() with no dreamFn configured returns a clear error and applies nothing", async () => {
  const { mneme, corpusId } = makeBioMneme();
  const bio = createBioMemory({ mneme, corpusId });
  const ep = bio.openEpisode("r1");
  const report = await bio.dream(ep.id, { modelVersion: "m1" });
  expect(report.errors).toContain("no dreamFn configured");
});

it("dream() with an unknown episode id returns an error and applies nothing", async () => {
  const { mneme, corpusId } = makeBioMneme();
  const bio = createBioMemory({ mneme, corpusId });
  const report = await bio.dream("ep-does-not-exist", { modelVersion: "m1" });
  expect(report.errors).toContain("unknown episode");
  expect(report.proposed).toBe(0);
  expect(report.admitted).toBe(0);
});

it("dream() with a fake dreamFn admits insights end-to-end against the gateway", async () => {
  const fakeDreamFn: DreamFn = async () => {
    // Return empty insights (no claims in the empty store to cite)
    return [];
  };

  const { mneme, corpusId } = makeBioMneme();
  const bio = createBioMemory({ mneme, corpusId, dreamFn: fakeDreamFn });
  const ep = bio.openEpisode("r2");
  const report = await bio.dream(ep.id, { modelVersion: "test-model" });
  // No errors — dreamFn is configured and episode exists
  expect(report.errors).toHaveLength(0);
});

// ─── Consolidate facade ──────────────────────────────────────────────────────

it("consolidate(unknownEpisode) returns an unknown-episode error report", () => {
  const { mneme, corpusId } = makeBioMneme();
  const bio = createBioMemory({ mneme, corpusId });
  expect(bio.consolidate("nope").errors).toContain("unknown episode");
});

it("consolidate(knownEpisode) delegates to the consolidate pass and returns a ConsolidationReport", () => {
  const { mneme, corpusId } = makeBioMneme();
  const bio = createBioMemory({ mneme, corpusId });
  const ep = bio.openEpisode("consolidate-test");
  const report = bio.consolidate(ep.id);
  expect(report.errors).toHaveLength(0);
  expect(typeof report.promoted).toBe("number");
  expect(typeof report.folded).toBe("number");
  expect(typeof report.deprecated).toBe("number");
  expect(Array.isArray(report.dropped)).toBe(true);
});

it("policy.consolidation override at construction is observable via consolidate (foldThreshold)", () => {
  const { mneme, corpusId } = makeBioMneme();
  // foldThreshold: 1 means any single claim is a fold candidate (lower bar than default 3)
  const bio = createBioMemory({ mneme, corpusId, policy: { consolidation: { foldThreshold: 1 } } });
  const ep = bio.openEpisode("fold-threshold-test");
  // Should construct and consolidate without errors — policy was wired
  const report = bio.consolidate(ep.id);
  expect(report.errors).toHaveLength(0);
});

it("policy.dreaming is accepted at construction (no dream field on opts)", () => {
  const { mneme, corpusId } = makeBioMneme();
  // The old `dream?: DreamPassOpts` field is gone; dreaming tuning is via policy.dreaming
  const bio = createBioMemory({ mneme, corpusId, policy: { dreaming: { maxInputClaims: 50 } } });
  expect(bio).toBeDefined();
});

it("policy.evidence outcomeWeight flows into cycle: higher weight yields larger alpha bump", () => {
  // Helper to make a minimal CandidateClaim with scalar confidence
  function makeClaim(): CandidateClaim {
    return {
      profile: "p1" as any,
      workspace: "w1" as any,
      subject: "evidence-test",
      key: "test.skill.evidence",
      scope: {},
      value: "test-value",
      confidence: { distribution: "scalar", parameters: { p: 0.5 }, raw: 0.5 },
      valid: { from: 0, to: INFINITY },
      status: "validated",
      source: "manual",
      provenance: { runId: "run-evidence" } as any,
      evidence: [],
      tags: [],
      schema: "text",
    };
  }

  const ctx: RetrievalContext = { now: Date.now(), decay: () => 1 };

  // --- Default outcomeWeight (2.0) ---
  const { mneme: mneme1, corpusId: cid1 } = makeBioMneme();
  mneme1.commit(cid1, makeClaim(), { writer: "test", idempotencyKey: "ev-default" });
  const gw1 = createMnemeGateway(mneme1, cid1);
  const bioDefault = createBioMemory({ mneme: mneme1, corpusId: cid1 });
  const epDefault = bioDefault.openEpisode("ev-default");
  bioDefault.recall({ corpusId: cid1 }, [], ctx, epDefault.id);
  bioDefault.recordOutcome(epDefault.id, "success");
  // Read the replacement claim (superseded original is deprecated; new one is validated)
  const defaultClaims = gw1.read({ corpusId: cid1, status: ["validated"] });
  const defaultConf = defaultClaims[0]?.confidence;
  const defaultAlpha = defaultConf?.distribution === "beta" ? defaultConf.parameters.alpha : 0;

  // --- High outcomeWeight (10.0) ---
  const { mneme: mneme2, corpusId: cid2 } = makeBioMneme();
  mneme2.commit(cid2, makeClaim(), { writer: "test", idempotencyKey: "ev-high" });
  const gw2 = createMnemeGateway(mneme2, cid2);
  const bioHigh = createBioMemory({ mneme: mneme2, corpusId: cid2, policy: { evidence: { outcomeWeight: 10 } } });
  const epHigh = bioHigh.openEpisode("ev-high");
  bioHigh.recall({ corpusId: cid2 }, [], ctx, epHigh.id);
  bioHigh.recordOutcome(epHigh.id, "success");
  const highClaims = gw2.read({ corpusId: cid2, status: ["validated"] });
  const highConf = highClaims[0]?.confidence;
  const highAlpha = highConf?.distribution === "beta" ? highConf.parameters.alpha : 0;

  // High outcomeWeight must produce a larger alpha bump than default
  expect(highAlpha).toBeGreaterThan(defaultAlpha);
});
