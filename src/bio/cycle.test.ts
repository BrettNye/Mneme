import { createCycle } from "./cycle.js";

it("applies process ops in one batch and flushes the buffer", () => {
  const applied: any[] = [];
  const gateway = {
    read: () => [],
    readByIds: () => [],
    apply: (ops: any[]) => {
      applied.push(...ops);
      return { applied: ops.length, skipped: 0 };
    },
  } as any;
  const flushed: string[] = [];
  const buffer = { flush: (e: string) => flushed.push(e) } as any;
  const proc = { name: "p", run: () => [{ kind: "supersede" } as any] };
  const report = createCycle(gateway, [proc]).run({ id: "ep-1" } as any, buffer);
  expect(report.opsApplied).toBe(1);
  expect(flushed).toContain("ep-1");
});

it("concatenates ops from multiple processes in order", () => {
  const capturedOps: any[] = [];
  const gateway = {
    read: () => [],
    readByIds: () => [],
    apply: (ops: any[]) => {
      capturedOps.push(...ops);
      return { applied: ops.length, skipped: 0 };
    },
  } as any;
  const buffer = { flush: () => {} } as any;
  const procA = { name: "a", run: () => [{ kind: "derive", seq: 1 } as any] };
  const procB = { name: "b", run: () => [{ kind: "promote", seq: 2 } as any, { kind: "supersede", seq: 3 } as any] };
  createCycle(gateway, [procA, procB]).run({ id: "ep-2" } as any, buffer);
  expect(capturedOps).toHaveLength(3);
  expect(capturedOps[0].seq).toBe(1);
  expect(capturedOps[1].seq).toBe(2);
  expect(capturedOps[2].seq).toBe(3);
});

it("calls gateway.apply exactly once per cycle even with multiple processes", () => {
  let applyCalls = 0;
  const gateway = {
    read: () => [],
    readByIds: () => [],
    apply: (ops: any[]) => {
      applyCalls++;
      return { applied: ops.length, skipped: 0 };
    },
  } as any;
  const buffer = { flush: () => {} } as any;
  const procA = { name: "a", run: () => [{ kind: "derive" } as any] };
  const procB = { name: "b", run: () => [{ kind: "derive" } as any] };
  createCycle(gateway, [procA, procB]).run({ id: "ep-3" } as any, buffer);
  expect(applyCalls).toBe(1);
});

it("returns claimsSuperseded count matching supersede ops", () => {
  const gateway = {
    read: () => [],
    readByIds: () => [],
    apply: (ops: any[]) => ({ applied: ops.length, skipped: 0 }),
  } as any;
  const buffer = { flush: () => {} } as any;
  const proc = {
    name: "p",
    run: () => [
      { kind: "supersede" } as any,
      { kind: "supersede" } as any,
      { kind: "derive" } as any,
    ],
  };
  const report = createCycle(gateway, [proc]).run({ id: "ep-4" } as any, buffer);
  expect(report.claimsSuperseded).toBe(2);
  expect(report.opsApplied).toBe(3);
  expect(report.errors).toHaveLength(0);
});

it("single-flight: returns error immediately if run is already in progress", () => {
  let resolveApply!: () => void;
  const applyPromise = new Promise<void>((res) => { resolveApply = res; });
  let applyCalls = 0;

  // Synchronous but we simulate overlap via a flag trick:
  // Use a process whose run() triggers a re-entrant call.
  const gateway = {
    read: () => [],
    readByIds: () => [],
    apply: (ops: any[]) => {
      applyCalls++;
      return { applied: ops.length, skipped: 0 };
    },
  } as any;
  const buffer = { flush: () => {} } as any;

  let innerReport: any;
  const cycle = createCycle(gateway, [
    {
      name: "reentrant",
      run: () => {
        // Attempt a reentrant call while the outer run is in progress
        innerReport = cycle.run({ id: "ep-5" } as any, buffer);
        return [{ kind: "derive" } as any];
      },
    },
  ]);

  const outerReport = cycle.run({ id: "ep-5" } as any, buffer);
  expect(outerReport.errors).toHaveLength(0); // outer succeeded
  expect(innerReport.errors).toHaveLength(1); // inner blocked
  expect(innerReport.errors[0]).toMatch(/single-flight/i);
  expect(innerReport.opsApplied).toBe(0);
  expect(applyCalls).toBe(1); // only outer applied
});

it("fail-safe: when a process throws, returns non-empty errors and does NOT flush the buffer", () => {
  const gateway = {
    read: () => [],
    readByIds: () => [],
    apply: (ops: any[]) => ({ applied: ops.length, skipped: 0 }),
  } as any;
  const flushed: string[] = [];
  const buffer = { flush: (e: string) => flushed.push(e) } as any;
  const badProc = {
    name: "bad",
    run: () => { throw new Error("process failed badly"); },
  };
  const report = createCycle(gateway, [badProc]).run({ id: "ep-6" } as any, buffer);
  expect(report.errors).toHaveLength(1);
  expect(report.errors[0]).toContain("process failed badly");
  expect(report.opsApplied).toBe(0);
  expect(flushed).not.toContain("ep-6");
});

it("fail-safe: when gateway.apply throws, signals are NOT flushed", () => {
  const gateway = {
    read: () => [],
    readByIds: () => [],
    apply: () => { throw new Error("apply exploded"); },
  } as any;
  const flushed: string[] = [];
  const buffer = { flush: (e: string) => flushed.push(e) } as any;
  const proc = { name: "p", run: () => [{ kind: "derive" } as any] };
  const report = createCycle(gateway, [proc]).run({ id: "ep-7" } as any, buffer);
  expect(report.errors).toHaveLength(1);
  expect(report.errors[0]).toContain("apply exploded");
  expect(flushed).not.toContain("ep-7");
});

it("flushes signals only after successful apply, not before", () => {
  const callOrder: string[] = [];
  const gateway = {
    read: () => [],
    readByIds: () => [],
    apply: (ops: any[]) => {
      callOrder.push("apply");
      return { applied: ops.length, skipped: 0 };
    },
  } as any;
  const buffer = {
    flush: (e: string) => { callOrder.push("flush"); },
  } as any;
  const proc = { name: "p", run: () => [{ kind: "derive" } as any] };
  createCycle(gateway, [proc]).run({ id: "ep-8" } as any, buffer);
  expect(callOrder).toEqual(["apply", "flush"]);
});

it("claimsSuperseded counts emitted (attempted) supersede ops; opsApplied reflects gateway committed count — these diverge on idempotent retry", () => {
  // This test documents the intentional attempted-vs-committed distinction:
  //   - claimsSuperseded = supersede ops emitted this cycle (pre-idempotency)
  //   - opsApplied       = ops the gateway actually committed (post-idempotency dedup)
  // On a retry of the same episode the gateway skips all ops (applied: 0),
  // but claimsSuperseded still reflects what was emitted. This asymmetry is
  // intentional until AppendResult gains a committed-per-kind breakdown (deferred).
  let callCount = 0;
  const gateway = {
    read: () => [],
    readByIds: () => [],
    apply: (ops: any[]) => {
      callCount++;
      if (callCount === 1) {
        // First call: gateway commits all ops
        return { applied: ops.length, skipped: 0 };
      }
      // Second call (retry / idempotent replay): gateway skips everything
      return { applied: 0, skipped: ops.length };
    },
  } as any;
  const buffer = { flush: () => {} } as any;
  const proc = {
    name: "p",
    run: () => [
      { kind: "supersede" } as any,
      { kind: "supersede" } as any,
    ],
  };
  const cycle = createCycle(gateway, [proc]);

  // First run — gateway commits both ops
  const first = cycle.run({ id: "ep-9" } as any, buffer);
  expect(first.opsApplied).toBe(2);
  expect(first.claimsSuperseded).toBe(2);

  // Second run (same episode, idempotent retry) — gateway skips everything.
  // opsApplied drops to 0 because the gateway committed nothing.
  // claimsSuperseded stays at 2 because the cycle still emitted 2 supersede ops.
  const second = cycle.run({ id: "ep-9" } as any, buffer);
  expect(second.opsApplied).toBe(0);
  expect(second.claimsSuperseded).toBe(2);
});
