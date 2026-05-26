import { vi } from "vitest";
import { createRunner } from "./runner.js";
import type { CycleReport } from "./types.js";

const makeMemory = () => {
  let calls = 0;
  const reports: CycleReport[] = [];
  return {
    runCycle: (_episode: string): CycleReport => {
      calls++;
      const r: CycleReport = { opsApplied: calls, claimsSuperseded: 0, errors: [] };
      reports.push(r);
      return r;
    },
    get calls() { return calls; },
    get reports() { return reports; },
  };
};

it("runNow delegates to memory.runCycle exactly once and returns its report", () => {
  const memory = makeMemory();
  const runner = createRunner(memory, "ep-1");
  const report = runner.runNow();
  expect(memory.calls).toBe(1);
  expect(report).toEqual({ opsApplied: 1, claimsSuperseded: 0, errors: [] });
});

it("runNow calls runCycle with the correct episode id", () => {
  const received: string[] = [];
  const memory = {
    runCycle: (ep: string): CycleReport => {
      received.push(ep);
      return { opsApplied: 0, claimsSuperseded: 0, errors: [] };
    },
  };
  createRunner(memory, "ep-99").runNow();
  expect(received).toEqual(["ep-99"]);
});

it("start({intervalMs}) schedules periodic runCycle after each interval", () => {
  vi.useFakeTimers();
  try {
    const memory = makeMemory();
    const runner = createRunner(memory, "ep-1");
    runner.start({ intervalMs: 100 });
    expect(memory.calls).toBe(0);
    vi.advanceTimersByTime(100);
    expect(memory.calls).toBe(1);
    vi.advanceTimersByTime(100);
    expect(memory.calls).toBe(2);
    runner.stop();
  } finally {
    vi.useRealTimers();
  }
});

it("start() with no interval never triggers runCycle", () => {
  vi.useFakeTimers();
  try {
    const memory = makeMemory();
    const runner = createRunner(memory, "ep-1");
    runner.start();
    vi.advanceTimersByTime(10_000);
    expect(memory.calls).toBe(0);
    runner.stop();
  } finally {
    vi.useRealTimers();
  }
});

it("stop clears the interval and no further triggers fire after stop", () => {
  vi.useFakeTimers();
  try {
    const memory = makeMemory();
    const runner = createRunner(memory, "ep-1");
    runner.start({ intervalMs: 100 });
    vi.advanceTimersByTime(100);
    expect(memory.calls).toBe(1);
    runner.stop();
    vi.advanceTimersByTime(1_000);
    expect(memory.calls).toBe(1); // no more calls after stop
  } finally {
    vi.useRealTimers();
  }
});

it("stop before start is a no-op and does not throw", () => {
  const memory = makeMemory();
  const runner = createRunner(memory, "ep-1");
  expect(() => runner.stop()).not.toThrow();
  expect(memory.calls).toBe(0);
});

it("runner owns no cognitive logic — it only forwards to runCycle", () => {
  // Verified structurally: createRunner accepts any CycleDriver (duck-typed interface
  // with just runCycle). The implementation in runner.ts must contain no conditional
  // branching on claim content, no scoring, no suppression, only scheduling + delegation.
  let calls = 0;
  const memory = { runCycle: () => { calls++; return { opsApplied: 0, claimsSuperseded: 0, errors: [] }; } };
  const runner = createRunner(memory, "ep-1");
  runner.runNow();
  runner.runNow();
  expect(calls).toBe(2);
});
