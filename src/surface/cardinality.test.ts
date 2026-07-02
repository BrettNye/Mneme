import { describe, it, expect } from "vitest";
import { freshSession } from "./test-support.js";
import { resolveKeyCardinality, cardinalitySafetyWarnings } from "./cardinality.js";

describe("cardinality", () => {
  it("resolveKeyCardinality: corpus declaration wins over deps map", () => {
    const s = freshSession();
    s.createCorpus({ id: "c", keyCardinality: { status: "single", tags: "multi" } });
    expect(resolveKeyCardinality(s, "c", { tags: "single", other: "multi" }))
      .toEqual({ tags: "multi", other: "multi", status: "single" });
    s.close();
  });

  it("resolveKeyCardinality: undeclared corpus returns the deps map; both empty → undefined", () => {
    const s = freshSession();
    s.createCorpus({ id: "c" });
    expect(resolveKeyCardinality(s, "c", { k: "multi" })).toEqual({ k: "multi" });
    expect(resolveKeyCardinality(s, "c", undefined)).toBeUndefined();
    s.close();
  });

  it("cardinalitySafetyWarnings: single key with 3 distinct values → one warning; multi → none", () => {
    const s = freshSession();
    s.createCorpus({ id: "c" });
    s.write("c", { subject: "proj", key: "status", value: "a", valid: { from: 1, to: Infinity } });
    s.write("c", { subject: "proj", key: "status", value: "b", valid: { from: 2, to: Infinity } });
    s.write("c", { subject: "proj", key: "status", value: "c", valid: { from: 3, to: Infinity } });
    const corpus = { claims: s.mneme.read("c", { corpusId: "c" }) };
    expect(cardinalitySafetyWarnings(corpus, undefined, {})).toHaveLength(1);
    expect(cardinalitySafetyWarnings(corpus, { status: "multi" }, {})).toHaveLength(0);
    s.close();
  });
});
