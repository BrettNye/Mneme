import { createSignalBuffer } from "./signals.js";
import type { ClaimId } from "../core/ids.js";
import type { EpisodeId } from "./types.js";

const ep1 = "ep-1" as EpisodeId;
const ep2 = "ep-2" as EpisodeId;
const c1 = "c1" as ClaimId;
const c2 = "c2" as ClaimId;
const c3 = "c3" as ClaimId;

it("buffers usage and exposes it via the SignalView, then flush clears it", () => {
  const b = createSignalBuffer();
  b.record({ kind: "usage", claimIds: [c1], episode: ep1 });
  expect(b.usageFor(ep1)).toHaveLength(1);
  b.flush(ep1);
  expect(b.usageFor(ep1)).toHaveLength(0);
});

it("buffers outcome signals and exposes them via outcomesFor", () => {
  const b = createSignalBuffer();
  b.record({ kind: "outcome", episode: ep1, result: "success", weight: 1.0 });
  b.record({ kind: "outcome", episode: ep1, result: "failure" });
  const outcomes = b.outcomesFor(ep1);
  expect(outcomes).toHaveLength(2);
  expect(outcomes[0]).toEqual({ result: "success", weight: 1.0 });
  expect(outcomes[1]).toEqual({ result: "failure", weight: undefined });
});

it("recordSurfaced accumulates surfaced claim set per episode", () => {
  const b = createSignalBuffer();
  b.recordSurfaced(ep1, [c1, c2]);
  b.recordSurfaced(ep1, [c3]);
  expect(b.surfacedFor(ep1)).toHaveLength(3);
  expect(b.surfacedFor(ep1)).toContain(c1);
  expect(b.surfacedFor(ep1)).toContain(c3);
});

it("flush clears usage, outcomes and surfaced for the given episode only", () => {
  const b = createSignalBuffer();
  b.record({ kind: "usage", claimIds: [c1], episode: ep1 });
  b.record({ kind: "outcome", episode: ep1, result: "success" });
  b.recordSurfaced(ep1, [c1]);
  b.record({ kind: "usage", claimIds: [c2], episode: ep2 });
  b.flush(ep1);
  expect(b.usageFor(ep1)).toHaveLength(0);
  expect(b.outcomesFor(ep1)).toHaveLength(0);
  expect(b.surfacedFor(ep1)).toHaveLength(0);
  // ep2 should still be present
  expect(b.usageFor(ep2)).toHaveLength(1);
});

it("SignalView accessors return empty arrays for unknown episodes", () => {
  const b = createSignalBuffer();
  expect(b.usageFor(ep1)).toEqual([]);
  expect(b.outcomesFor(ep1)).toEqual([]);
  expect(b.surfacedFor(ep1)).toEqual([]);
});

it("accessors do not mutate internal state", () => {
  const b = createSignalBuffer();
  b.record({ kind: "usage", claimIds: [c1], episode: ep1 });
  const view = b.usageFor(ep1);
  view.push(c2 as ClaimId);
  // internal state should be unaffected
  expect(b.usageFor(ep1)).toHaveLength(1);
});

it("throws when cap is exceeded", () => {
  const b = createSignalBuffer(2);
  b.record({ kind: "usage", claimIds: [c1], episode: ep1 });
  b.record({ kind: "outcome", episode: ep1, result: "success" });
  expect(() =>
    b.record({ kind: "usage", claimIds: [c2], episode: ep2 })
  ).toThrow(/cap 2 exceeded/);
});

it("size returns current count of buffered signals", () => {
  const b = createSignalBuffer();
  expect(b.size()).toBe(0);
  b.record({ kind: "usage", claimIds: [c1], episode: ep1 });
  expect(b.size()).toBe(1);
  b.record({ kind: "outcome", episode: ep1, result: "failure" });
  expect(b.size()).toBe(2);
  b.flush(ep1);
  expect(b.size()).toBe(0);
});

it("multiple usage records for same episode accumulate", () => {
  const b = createSignalBuffer();
  b.record({ kind: "usage", claimIds: [c1], episode: ep1 });
  b.record({ kind: "usage", claimIds: [c2, c3], episode: ep1 });
  expect(b.usageFor(ep1)).toHaveLength(3);
});
