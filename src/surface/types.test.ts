import { describe, it, expect, expectTypeOf } from "vitest";
import { SURFACE_DEFAULTS, defaultConfidence } from "./types.js";
import type { ReadDeps } from "./types.js";
import type { RecallDeps } from "./recall.js";

describe("surface defaults", () => {
  it("defaults to a persisted file db (not :memory:)", () => {
    expect(SURFACE_DEFAULTS.dbPath).toBe("./mneme.db");
  });
  it("defaults confidence to full scalar certainty", () => {
    expect(defaultConfidence()).toEqual({ distribution: "scalar", parameters: { p: 1 }, raw: 1 });
  });
});

describe("ReadDeps type compatibility", () => {
  it("RecallDeps is a byte-compatible alias of ReadDeps", () => {
    expectTypeOf<RecallDeps>().toEqualTypeOf<ReadDeps>();
  });
});
