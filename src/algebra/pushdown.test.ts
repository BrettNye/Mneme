import { describe, it, expect } from "vitest";
import type { Predicate } from "./predicate.js";
import { leafHintsOf } from "./pushdown.js";

describe("leafHintsOf", () => {
  it("subjectEq folds into subject", () => {
    expect(leafHintsOf([{ op: "subjectEq", value: "s1" }])).toEqual({ subject: "s1" });
  });

  it("keyEq folds into key", () => {
    expect(leafHintsOf([{ op: "keyEq", value: "k1" }])).toEqual({ key: "k1" });
  });

  it("multi-element keyIn folds into keys", () => {
    expect(leafHintsOf([{ op: "keyIn", values: ["a", "b", "c"] }])).toEqual({
      keys: ["a", "b", "c"],
    });
  });

  it("one-element keyIn folds into key (not keys)", () => {
    expect(leafHintsOf([{ op: "keyIn", values: ["only"] }])).toEqual({ key: "only" });
  });

  it("and recurses into conjuncts", () => {
    const p: Predicate = {
      op: "and",
      preds: [
        { op: "subjectEq", value: "s1" },
        { op: "keyIn", values: ["x", "y"] },
      ],
    };
    expect(leafHintsOf([p])).toEqual({ subject: "s1", keys: ["x", "y"] });
  });

  it("keyEq ∧ keyIn sets BOTH key and keys (AND-intersection contract)", () => {
    expect(
      leafHintsOf([
        { op: "keyEq", value: "a" },
        { op: "keyIn", values: ["b", "c"] },
      ])
    ).toEqual({ key: "a", keys: ["b", "c"] });
  });

  it("empty keyIn contributes nothing — field omitted, not keys: []", () => {
    expect(leafHintsOf([{ op: "keyIn", values: [] }])).toEqual({});
  });

  it("same-field conflicting conjuncts (two different subjectEq) — first wins", () => {
    expect(
      leafHintsOf([
        { op: "subjectEq", value: "first" },
        { op: "subjectEq", value: "second" },
      ])
    ).toEqual({ subject: "first" });
  });

  it("empty input returns {}", () => {
    expect(leafHintsOf([])).toEqual({});
  });

  it("subjectIn (deferred per spec §10) contributes nothing", () => {
    expect(leafHintsOf([{ op: "subjectIn", values: ["a", "b"] }])).toEqual({});
  });

  it("or contributes nothing", () => {
    expect(
      leafHintsOf([
        { op: "or", preds: [{ op: "subjectEq", value: "a" }, { op: "subjectEq", value: "b" }] },
      ])
    ).toEqual({});
  });

  it("not contributes nothing", () => {
    expect(leafHintsOf([{ op: "not", pred: { op: "subjectEq", value: "a" } }])).toEqual({});
  });

  it("statusEq contributes nothing", () => {
    expect(leafHintsOf([{ op: "statusEq", value: "valid" }])).toEqual({});
  });

  it("statusIn contributes nothing", () => {
    expect(leafHintsOf([{ op: "statusIn", values: ["valid", "deprecated"] }])).toEqual({});
  });

  it("scopeEq contributes nothing", () => {
    expect(leafHintsOf([{ op: "scopeEq", field: "corpus", value: "c1" }])).toEqual({});
  });

  it("tagIn contributes nothing", () => {
    expect(leafHintsOf([{ op: "tagIn", values: ["tag1"] }])).toEqual({});
  });

  it("confidenceGt contributes nothing", () => {
    expect(leafHintsOf([{ op: "confidenceGt", value: 0.5 }])).toEqual({});
  });

  it("validAt contributes nothing", () => {
    expect(leafHintsOf([{ op: "validAt", t: 12345 }])).toEqual({});
  });

  it("recordedAfter contributes nothing", () => {
    expect(leafHintsOf([{ op: "recordedAfter", t: 12345 }])).toEqual({});
  });

  it("valueEq (a value predicate) contributes nothing", () => {
    expect(leafHintsOf([{ op: "valueEq", path: "$", value: "x" }])).toEqual({});
  });
});
