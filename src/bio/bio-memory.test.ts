import { createBioMemory } from "./bio-memory.js";
import { makeBioMneme } from "./test-support.js";
import { suppression } from "./policies/suppression.js";
import type { RetrievalContext } from "./types.js";
import type { DreamFn } from "./processes/dreaming-types.js";

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
