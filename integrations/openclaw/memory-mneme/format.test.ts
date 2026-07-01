import { describe, it, expect } from "vitest";
import { wrapMemories, mergeScope } from "./format.js";

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
