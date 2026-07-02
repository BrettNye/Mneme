import { describe, it, expect } from "vitest";
import { freshSession } from "./test-support.js";
import { lineageOf } from "./history.js";

describe("lineageOf", () => {
  it("returns the full non-destructive lineage: deprecated versions retained + attributed", () => {
    const s = freshSession();
    s.createCorpus({ id: "c", keyCardinality: { plan: "single" } });
    s.write("c", { subject: "p", key: "plan", value: "alpha", valid: { from: 1, to: Infinity } });
    s.write("c", { subject: "p", key: "plan", value: "bravo", valid: { from: 2, to: Infinity } });
    s.write("c", { subject: "p", key: "plan", value: "gamma", valid: { from: 3, to: Infinity } });
    const r = lineageOf(s, { corpus: "c", subject: "p", key: "plan" });
    expect(r.entries).toHaveLength(3);
    expect(r.entries.at(-1)!.disposition).toBe("served");
    expect(r.entries.filter((e) => e.disposition === "deprecated")).toHaveLength(2);
    expect(r.entries[0].valid.from).toBeLessThan(r.entries[1].valid.from);
    s.close();
  });

  it("orders entries by valid.from then recordedSeq", () => {
    const s = freshSession();
    s.createCorpus({ id: "c", keyCardinality: { plan: "single" } });
    s.write("c", { subject: "p", key: "plan", value: "gamma", valid: { from: 3, to: Infinity } });
    s.write("c", { subject: "p", key: "plan", value: "alpha", valid: { from: 1, to: Infinity } });
    s.write("c", { subject: "p", key: "plan", value: "bravo", valid: { from: 2, to: Infinity } });
    const r = lineageOf(s, { corpus: "c", subject: "p", key: "plan" });
    expect(r.entries.map((e) => e.value)).toEqual(["alpha", "bravo", "gamma"]);
    s.close();
  });

  it("attributes token-similar restatements as merged", () => {
    const s = freshSession();
    s.createCorpus({ id: "c", keyCardinality: { note: "single" } });
    s.write("c", { subject: "p", key: "note", value: "deploy the api now", valid: { from: 2, to: Infinity } });
    s.write("c", { subject: "p", key: "note", value: "deploy the api", valid: { from: 1, to: Infinity } });
    const r = lineageOf(s, { corpus: "c", subject: "p", key: "note" });
    expect(r.entries).toHaveLength(2);
    expect(r.entries.filter((e) => e.disposition === "merged")).toHaveLength(1);
    s.close();
  });

  it("attributes a future-dated claim as tau-invalid at the default asOf", () => {
    const s = freshSession();
    s.createCorpus({ id: "c", keyCardinality: { plan: "single" } });
    s.write("c", { subject: "p", key: "plan", value: "alpha", valid: { from: 1, to: Infinity } });
    const future = Date.now() + 1000 * 60 * 60 * 24 * 365 * 10; // 10 years out
    s.write("c", { subject: "p", key: "plan", value: "far-future", valid: { from: future, to: Infinity } });
    const r = lineageOf(s, { corpus: "c", subject: "p", key: "plan" });
    const futureEntry = r.entries.find((e) => e.value === "far-future");
    expect(futureEntry!.disposition).toBe("tau-invalid");
    s.close();
  });

  it("returns all entries served under multi cardinality (no deprecation)", () => {
    const s = freshSession();
    s.createCorpus({ id: "c", keyCardinality: { tag: "multi" } });
    s.write("c", { subject: "p", key: "tag", value: "alpha", valid: { from: 1, to: Infinity } });
    s.write("c", { subject: "p", key: "tag", value: "bravo", valid: { from: 2, to: Infinity } });
    const r = lineageOf(s, { corpus: "c", subject: "p", key: "tag" });
    expect(r.entries).toHaveLength(2);
    expect(r.entries.every((e) => e.disposition === "served")).toBe(true);
    s.close();
  });

  it("returns empty for an unknown corpus and does not create it", () => {
    const s = freshSession();
    const r = lineageOf(s, { corpus: "nope", subject: "p", key: "plan" });
    expect(r.entries).toEqual([]);
    expect(s.listCorpora().some((c) => c.id === "nope")).toBe(false);
    s.close();
  });

  it("composes a non-empty markdown content timeline", () => {
    const s = freshSession();
    s.createCorpus({ id: "c", keyCardinality: { plan: "single" } });
    s.write("c", { subject: "p", key: "plan", value: "alpha", valid: { from: 1, to: Infinity } });
    s.write("c", { subject: "p", key: "plan", value: "bravo", valid: { from: 2, to: Infinity } });
    const r = lineageOf(s, { corpus: "c", subject: "p", key: "plan" });
    expect(r.content.length).toBeGreaterThan(0);
    expect(r.content).toContain("served");
    expect(r.content).toContain("deprecated");
    s.close();
  });
});
