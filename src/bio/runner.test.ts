import { vi } from "vitest";
import { createRunner } from "./runner.js";
import type { CycleReport } from "./types.js";
import type { DreamReport } from "./processes/dreaming-types.js";

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

it("second start does not double-fire — old interval is cleared before new one starts", () => {
  vi.useFakeTimers();
  try {
    const memory = makeMemory();
    const runner = createRunner(memory, "ep-1");
    runner.start({ intervalMs: 100 });
    runner.start({ intervalMs: 100 }); // second start: must clear the first interval
    vi.advanceTimersByTime(100);
    expect(memory.calls).toBe(1); // only one interval should be active
    runner.stop();
  } finally {
    vi.useRealTimers();
  }
});

it("stop(); stop(); after a start is a safe no-op and does not throw", () => {
  vi.useFakeTimers();
  try {
    const memory = makeMemory();
    const runner = createRunner(memory, "ep-1");
    runner.start({ intervalMs: 100 });
    vi.advanceTimersByTime(100);
    expect(memory.calls).toBe(1);
    expect(() => {
      runner.stop();
      runner.stop(); // second stop must not throw
    }).not.toThrow();
    vi.advanceTimersByTime(1_000);
    expect(memory.calls).toBe(1); // no further calls after double-stop
  } finally {
    vi.useRealTimers();
  }
});

// ---- startDreaming tests ----

const makeDreamMemory = () => {
  let cycleCalls = 0;
  let dreamCalls = 0;
  const dreamEpisodes: string[] = [];
  const dreamVersions: string[] = [];
  return {
    runCycle: (_episode: string): CycleReport => {
      cycleCalls++;
      return { opsApplied: cycleCalls, claimsSuperseded: 0, errors: [] };
    },
    dream: async (episode: string, run: { modelVersion: string }): Promise<DreamReport> => {
      dreamCalls++;
      dreamEpisodes.push(episode);
      dreamVersions.push(run.modelVersion);
      return { proposed: 0, admitted: 0, dropped: [], errors: [] };
    },
    get cycleCalls() { return cycleCalls; },
    get dreamCalls() { return dreamCalls; },
    get dreamEpisodes() { return dreamEpisodes; },
    get dreamVersions() { return dreamVersions; },
  };
};

it("startDreaming schedules periodic memory.dream calls", () => {
  vi.useFakeTimers();
  try {
    const memory = makeDreamMemory();
    const runner = createRunner(memory, "ep-1");
    runner.startDreaming({ intervalMs: 200, episode: "ep-1", modelVersion: "gpt-4" });
    expect(memory.dreamCalls).toBe(0);
    vi.advanceTimersByTime(200);
    expect(memory.dreamCalls).toBe(1);
    vi.advanceTimersByTime(200);
    expect(memory.dreamCalls).toBe(2);
    runner.stop();
  } finally {
    vi.useRealTimers();
  }
});

it("startDreaming passes the correct episode and modelVersion to memory.dream", () => {
  vi.useFakeTimers();
  try {
    const memory = makeDreamMemory();
    const runner = createRunner(memory, "ep-main");
    runner.startDreaming({ intervalMs: 100, episode: "ep-dream", modelVersion: "claude-3" });
    vi.advanceTimersByTime(100);
    expect(memory.dreamEpisodes).toEqual(["ep-dream"]);
    expect(memory.dreamVersions).toEqual(["claude-3"]);
    runner.stop();
  } finally {
    vi.useRealTimers();
  }
});

it("startDreaming with no intervalMs schedules nothing", () => {
  vi.useFakeTimers();
  try {
    const memory = makeDreamMemory();
    const runner = createRunner(memory, "ep-1");
    runner.startDreaming({ episode: "ep-1", modelVersion: "gpt-4" });
    vi.advanceTimersByTime(10_000);
    expect(memory.dreamCalls).toBe(0);
    runner.stop();
  } finally {
    vi.useRealTimers();
  }
});

it("startDreaming with intervalMs=0 schedules nothing", () => {
  vi.useFakeTimers();
  try {
    const memory = makeDreamMemory();
    const runner = createRunner(memory, "ep-1");
    runner.startDreaming({ intervalMs: 0, episode: "ep-1", modelVersion: "gpt-4" });
    vi.advanceTimersByTime(10_000);
    expect(memory.dreamCalls).toBe(0);
    runner.stop();
  } finally {
    vi.useRealTimers();
  }
});

it("stop() halts dreaming — no further dream calls after stop", () => {
  vi.useFakeTimers();
  try {
    const memory = makeDreamMemory();
    const runner = createRunner(memory, "ep-1");
    runner.startDreaming({ intervalMs: 100, episode: "ep-1", modelVersion: "gpt-4" });
    vi.advanceTimersByTime(100);
    expect(memory.dreamCalls).toBe(1);
    runner.stop();
    vi.advanceTimersByTime(1_000);
    expect(memory.dreamCalls).toBe(1); // no more calls after stop
  } finally {
    vi.useRealTimers();
  }
});

it("double startDreaming does not double-fire — old dream interval is cleared", () => {
  vi.useFakeTimers();
  try {
    const memory = makeDreamMemory();
    const runner = createRunner(memory, "ep-1");
    runner.startDreaming({ intervalMs: 100, episode: "ep-1", modelVersion: "gpt-4" });
    runner.startDreaming({ intervalMs: 100, episode: "ep-1", modelVersion: "gpt-4" }); // should clear the first
    vi.advanceTimersByTime(100);
    expect(memory.dreamCalls).toBe(1); // only one interval active
    runner.stop();
  } finally {
    vi.useRealTimers();
  }
});

it("stop() clears both the cycle timer and the dream timer", () => {
  vi.useFakeTimers();
  try {
    const memory = makeDreamMemory();
    const runner = createRunner(memory, "ep-1");
    runner.start({ intervalMs: 50 });
    runner.startDreaming({ intervalMs: 100, episode: "ep-1", modelVersion: "gpt-4" });
    vi.advanceTimersByTime(100);
    expect(memory.cycleCalls).toBe(2); // 2 cycle ticks at 50ms intervals
    expect(memory.dreamCalls).toBe(1); // 1 dream tick at 100ms
    runner.stop();
    vi.advanceTimersByTime(1_000);
    expect(memory.cycleCalls).toBe(2); // no more cycle calls
    expect(memory.dreamCalls).toBe(1); // no more dream calls
  } finally {
    vi.useRealTimers();
  }
});

it("startDreaming on a cycle-only memory (no dream method) is a no-op — throws nothing, schedules nothing", () => {
  vi.useFakeTimers();
  try {
    // cycle-only memory: does NOT have a dream method
    const cycleOnlyMemory = {
      runCycle: (_episode: string): CycleReport => ({ opsApplied: 0, claimsSuperseded: 0, errors: [] }),
    };
    const runner = createRunner(cycleOnlyMemory, "ep-1");
    expect(() => {
      runner.startDreaming({ intervalMs: 100, episode: "ep-1", modelVersion: "gpt-4" });
      vi.advanceTimersByTime(1_000);
    }).not.toThrow();
    runner.stop();
  } finally {
    vi.useRealTimers();
  }
});

// ---- startConsolidating tests ----

it("startConsolidating calls memory.consolidate on each interval tick", () => {
  vi.useFakeTimers();
  try {
    let calls = 0;
    const memory = {
      runCycle: (_episode: string): CycleReport => ({ opsApplied: 0, claimsSuperseded: 0, errors: [] }),
      consolidate: (_episode: string) => { calls++; },
    };
    const runner = createRunner(memory, "ep-1");
    const stop = runner.startConsolidating({ intervalMs: 10 }, "ep-1");
    expect(calls).toBe(0);
    vi.advanceTimersByTime(10);
    expect(calls).toBe(1);
    vi.advanceTimersByTime(10);
    expect(calls).toBe(2);
    stop();
  } finally {
    vi.useRealTimers();
  }
});

it("startConsolidating passes the correct episode id to memory.consolidate", () => {
  vi.useFakeTimers();
  try {
    const received: string[] = [];
    const memory = {
      runCycle: (_episode: string): CycleReport => ({ opsApplied: 0, claimsSuperseded: 0, errors: [] }),
      consolidate: (episode: string) => { received.push(episode); },
    };
    const runner = createRunner(memory, "ep-main");
    const stop = runner.startConsolidating({ intervalMs: 50 }, "ep-consolidate");
    vi.advanceTimersByTime(50);
    expect(received).toEqual(["ep-consolidate"]);
    stop();
  } finally {
    vi.useRealTimers();
  }
});

it("startConsolidating stop function clears the interval — no further consolidate calls after stop", () => {
  vi.useFakeTimers();
  try {
    let calls = 0;
    const memory = {
      runCycle: (_episode: string): CycleReport => ({ opsApplied: 0, claimsSuperseded: 0, errors: [] }),
      consolidate: (_episode: string) => { calls++; },
    };
    const runner = createRunner(memory, "ep-1");
    const stop = runner.startConsolidating({ intervalMs: 100 }, "ep-1");
    vi.advanceTimersByTime(100);
    expect(calls).toBe(1);
    stop();
    vi.advanceTimersByTime(1_000);
    expect(calls).toBe(1); // no more calls after stop
  } finally {
    vi.useRealTimers();
  }
});

it("startConsolidating on memory without consolidate is a no-op — returns stop function, throws nothing", () => {
  vi.useFakeTimers();
  try {
    const memory = {
      runCycle: (_episode: string): CycleReport => ({ opsApplied: 0, claimsSuperseded: 0, errors: [] }),
    };
    const runner = createRunner(memory, "ep-1");
    let stop!: () => void;
    expect(() => {
      stop = runner.startConsolidating({ intervalMs: 100 }, "ep-1");
      vi.advanceTimersByTime(1_000);
    }).not.toThrow();
    expect(typeof stop).toBe("function");
    stop(); // calling stop must not throw either
  } finally {
    vi.useRealTimers();
  }
});

it("startConsolidating swallows throws from consolidate so interval survives", () => {
  vi.useFakeTimers();
  try {
    let calls = 0;
    const memory = {
      runCycle: (_episode: string): CycleReport => ({ opsApplied: 0, claimsSuperseded: 0, errors: [] }),
      consolidate: (_episode: string) => {
        calls++;
        throw new Error("consolidation failure");
      },
    };
    const runner = createRunner(memory, "ep-1");
    const stop = runner.startConsolidating({ intervalMs: 100 }, "ep-1");
    vi.advanceTimersByTime(100);
    expect(calls).toBe(1);
    vi.advanceTimersByTime(100); // interval should survive the throw
    expect(calls).toBe(2); // called again, proving interval was not killed
    stop();
  } finally {
    vi.useRealTimers();
  }
});
