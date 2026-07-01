import { describe, it, expect } from "vitest";
import { wrapMemories, mergeScope, coverageNote, provenanceFooter } from "./format.js";

describe("wrapMemories", () => {
  it("emits no envelope for blank content", () => {
    expect(wrapMemories("   ")).toBe("");
  });

  it("emits no envelope for empty content", () => {
    expect(wrapMemories("")).toBe("");
  });

  it("wraps non-empty content in exactly one tag pair", () => {
    const out = wrapMemories("project:mneme status = green");
    expect(out.startsWith("<relevant-memories>")).toBe(true);
    expect(out.trim().endsWith("</relevant-memories>")).toBe(true);
    expect(out).toContain("green");
    const openCount = (out.match(/<relevant-memories>/g) ?? []).length;
    const closeCount = (out.match(/<\/relevant-memories>/g) ?? []).length;
    expect(openCount).toBe(1);
    expect(closeCount).toBe(1);
  });

  it("wraps content directly with no injected narration", () => {
    const out = wrapMemories("project:mneme status = green");
    expect(out).toBe(
      "<relevant-memories>\nproject:mneme status = green\n</relevant-memories>",
    );
  });
});

describe("mergeScope", () => {
  it("overlays write scope onto default scope, write keys win", () => {
    expect(mergeScope({ project: "x" }, { context: "y" })).toEqual({
      project: "x",
      context: "y",
    });
  });

  it("write key overrides default key", () => {
    expect(mergeScope({ a: "1" }, { a: "2" })).toEqual({ a: "2" });
  });

  it("returns undefined when both are undefined", () => {
    expect(mergeScope(undefined, undefined)).toBeUndefined();
  });

  it("returns default scope when write scope is undefined", () => {
    expect(mergeScope({ project: "x" }, undefined)).toEqual({ project: "x" });
  });

  it("returns write scope when default scope is undefined", () => {
    expect(mergeScope(undefined, { context: "y" })).toEqual({ context: "y" });
  });
});

describe("coverageNote", () => {
  it("returns empty string for undefined missing", () => {
    expect(coverageNote(undefined)).toBe("");
  });

  it("returns empty string for an empty missing array", () => {
    expect(coverageNote([])).toBe("");
  });

  it("includes the missing entities when non-empty", () => {
    const note = coverageNote(["Sacramento", "Denver"]);
    expect(note).toContain("Sacramento");
    expect(note).toContain("Denver");
  });

  it("caps the shown list at max and appends a '+N more' suffix", () => {
    const missing = ["a", "b", "c", "d", "e", "f", "g"];
    const note = coverageNote(missing);
    expect(note).toContain("a, b, c, d, e");
    expect(note).not.toContain(", f");
    expect(note).toContain("(+2 more)");
  });

  it("respects a custom max", () => {
    const note = coverageNote(["a", "b", "c"], 2);
    expect(note).toContain("a, b");
    expect(note).toContain("(+1 more)");
  });
});

describe("provenanceFooter", () => {
  it("returns empty string for undefined matches", () => {
    expect(provenanceFooter(undefined)).toBe("");
  });

  it("returns empty string for an empty matches array", () => {
    expect(provenanceFooter([])).toBe("");
  });

  it("lists each claim id, subject, and key", () => {
    const footer = provenanceFooter([
      { id: "claim-1", subject: "project:mneme", key: "status" },
      { id: "claim-2", subject: "user", key: "accommodation" },
    ]);
    expect(footer).toContain("claim-1");
    expect(footer).toContain("project:mneme status");
    expect(footer).toContain("claim-2");
    expect(footer).toContain("user accommodation");
  });
});
