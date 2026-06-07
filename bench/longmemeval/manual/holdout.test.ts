import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { isTrain, splitFolds } from "./holdout.js";

it("matches the deep-dive inline split expression exactly", () => {
  for (const qid of ["q-1", "q-2", "abc_abs", "5f3e", "x"]) {
    const inline =
      parseInt(createHash("sha256").update(qid).digest("hex").slice(0, 8), 16) % 2 === 0;
    expect(isTrain(qid)).toBe(inline);
  }
});

describe("splitFolds", () => {
  it("partitions: every item in exactly one fold", () => {
    const items = ["q-1", "q-2", "q-3", "q-4", "q-5"];
    const { A, B } = splitFolds(items, (x) => x);
    // Every item appears exactly once in A or B
    for (const item of items) {
      const inA = A.includes(item);
      const inB = B.includes(item);
      expect(inA !== inB).toBe(true); // exactly one of the two
    }
    expect(A.length + B.length).toBe(items.length);
  });

  it("A = isTrain true, B = isTrain false", () => {
    const items = ["q-1", "q-2", "q-3", "q-4", "q-5", "abc_abs", "5f3e", "x"];
    const { A, B } = splitFolds(items, (x) => x);
    for (const item of A) {
      expect(isTrain(item)).toBe(true);
    }
    for (const item of B) {
      expect(isTrain(item)).toBe(false);
    }
  });

  it("works with object items via idOf", () => {
    const items = [
      { id: "q-1", val: 10 },
      { id: "q-2", val: 20 },
      { id: "q-3", val: 30 },
    ];
    const { A, B } = splitFolds(items, (t) => t.id);
    const all = [...A, ...B];
    expect(all.length).toBe(items.length);
    for (const item of A) {
      expect(isTrain(item.id)).toBe(true);
    }
    for (const item of B) {
      expect(isTrain(item.id)).toBe(false);
    }
  });

  it("empty input returns empty folds", () => {
    const { A, B } = splitFolds([], (x: string) => x);
    expect(A).toEqual([]);
    expect(B).toEqual([]);
  });
});
