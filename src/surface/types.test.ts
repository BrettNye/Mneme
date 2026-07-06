import { describe, it, expect, expectTypeOf } from "vitest";
import { SURFACE_DEFAULTS, defaultConfidence, corpusDefFromSpec, DEFAULT_SCALAR_PSEUDOCOUNT } from "./types.js";
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

describe("corpusDefFromSpec", () => {
  it("expands a defaults-only spec to the exact CorpusDef literal", () => {
    const def = corpusDefFromSpec({ id: "c" });
    expect(def).toEqual({
      id: "c",
      displayName: "c",
      schema: {
        version: "1",
        subjects: [],
        scopeFields: {},
        required: [],
        scalarPseudocount: { ...DEFAULT_SCALAR_PSEUDOCOUNT },
      },
      defaults: {
        decayPolicy: { kind: "none" },
        confidenceThreshold: 0,
        contradictionPolicy: { kind: "always_accept" },
        defaultStatus: ["validated"],
      },
      requiredTiers: [{ kind: "core" }],
      metadata: {},
      createdAt: 0,
      updatedAt: 0,
    });
  });

  it("honors a custom schemaVersion", () => {
    const def = corpusDefFromSpec({ id: "c", schemaVersion: "7" });
    expect(def.schema.version).toBe("7");
  });

  it("persists keyCardinality when declared, absent when omitted", () => {
    const withCard = corpusDefFromSpec({ id: "c", keyCardinality: { status: "single", tags: "multi" } });
    expect(withCard.schema.keyCardinality).toEqual({ status: "single", tags: "multi" });

    const without = corpusDefFromSpec({ id: "c" });
    expect(without.schema.keyCardinality).toBeUndefined();
  });

  it("throws on an invalid keyCardinality value", () => {
    expect(() => corpusDefFromSpec({ id: "c", keyCardinality: { k: "many" as "single" } }))
      .toThrow(/invalid keyCardinality/);
  });

  it("merges scalarPseudocount overrides over the A.1 defaults", () => {
    const def = corpusDefFromSpec({ id: "c", scalarPseudocount: { llm: 4 } });
    expect(def.schema.scalarPseudocount).toEqual({ ...DEFAULT_SCALAR_PSEUDOCOUNT, llm: 4 });
  });

  it("corpusDefFromSpec strips explicit-undefined pseudocounts BEFORE merging over defaults", () => {
    const def = corpusDefFromSpec({ id: "c", scalarPseudocount: { llm: undefined } });
    expect(def.schema.scalarPseudocount.llm).toBe(DEFAULT_SCALAR_PSEUDOCOUNT.llm); // not undefined
    expect(Object.keys(def.schema.scalarPseudocount)).toHaveLength(6);
  });

  it("throws the exact invalid-scalarPseudocount text for NaN, Infinity, negative; accepts 0", () => {
    expect(() => corpusDefFromSpec({ id: "c", scalarPseudocount: { llm: NaN } }))
      .toThrow('invalid scalarPseudocount for source "llm": NaN (must be a finite number >= 0)');
    expect(() => corpusDefFromSpec({ id: "c", scalarPseudocount: { llm: Infinity } }))
      .toThrow('invalid scalarPseudocount for source "llm": Infinity (must be a finite number >= 0)');
    expect(() => corpusDefFromSpec({ id: "c", scalarPseudocount: { llm: -1 } }))
      .toThrow('invalid scalarPseudocount for source "llm": -1 (must be a finite number >= 0)');
    expect(() => corpusDefFromSpec({ id: "c", scalarPseudocount: { llm: 0 } })).not.toThrow();
    expect(corpusDefFromSpec({ id: "c", scalarPseudocount: { llm: 0 } }).schema.scalarPseudocount.llm).toBe(0);
  });
});
