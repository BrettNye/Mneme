import { describe, it, expect } from "vitest";
import { SURFACE_DEFAULTS, defaultConfidence } from "./types.js";

describe("surface defaults", () => {
  it("defaults to a persisted file db (not :memory:)", () => {
    expect(SURFACE_DEFAULTS.dbPath).toBe("./mneme.db");
  });
  it("defaults confidence to full scalar certainty", () => {
    expect(defaultConfidence()).toEqual({ distribution: "scalar", parameters: { p: 1 }, raw: 1 });
  });
});
