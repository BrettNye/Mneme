import { describe, it, expect } from "vitest";
import { freshSession } from "./test-support.js";
import {
  resolveKeyCardinality,
  effectiveKeyCardinality,
  cardinalitySafetyWarnings,
  cardinalityCollisions,
  formatCardinalityCollision,
} from "./cardinality.js";

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

  it("cardinalityCollisions: returns structured {subject,key,distinctValues,totalClaims} for a collision", () => {
    const s = freshSession();
    s.createCorpus({ id: "c" });
    s.write("c", { subject: "proj", key: "status", value: "a", valid: { from: 1, to: Infinity } });
    s.write("c", { subject: "proj", key: "status", value: "b", valid: { from: 2, to: Infinity } });
    s.write("c", { subject: "proj", key: "status", value: "c", valid: { from: 3, to: Infinity } });
    const corpus = { claims: s.mneme.read("c", { corpusId: "c" }) };
    const collisions = cardinalityCollisions(corpus, undefined, {});
    expect(collisions).toEqual([
      { subject: "proj", key: "status", distinctValues: 3, totalClaims: 3 },
    ]);
    // multi cardinality suppresses the collision entirely
    expect(cardinalityCollisions(corpus, { status: "multi" }, {})).toHaveLength(0);
    s.close();
  });

  it("cardinalitySafetyWarnings is derived from cardinalityCollisions via formatCardinalityCollision (byte-identical)", () => {
    const s = freshSession();
    s.createCorpus({ id: "c" });
    s.write("c", { subject: "proj", key: "status", value: "a", valid: { from: 1, to: Infinity } });
    s.write("c", { subject: "proj", key: "status", value: "b", valid: { from: 2, to: Infinity } });
    const corpus = { claims: s.mneme.read("c", { corpusId: "c" }) };
    const collisions = cardinalityCollisions(corpus, undefined, {});
    const warnings = cardinalitySafetyWarnings(corpus, undefined, {});
    expect(warnings).toEqual(collisions.map(formatCardinalityCollision));
    expect(warnings[0]).toBe(
      `single-cardinality (subject:proj, key:status) holds 2 distinct values` +
      ` — recall serves only the latest; declare keyCardinality:"multi" if they should coexist.`,
    );
    s.close();
  });
});

describe("effectiveKeyCardinality — pure extraction over the RecallSource seam (task-pure-helpers)", () => {
  it("resolveKeyCardinality(session, ...) delegates to effectiveKeyCardinality(session.mneme, ...)", () => {
    const s = freshSession();
    s.createCorpus({ id: "c", keyCardinality: { status: "single", tags: "multi" } });
    const override = { tags: "single" as const, other: "multi" as const };
    expect(effectiveKeyCardinality(s.mneme, "c", override)).toEqual(
      resolveKeyCardinality(s, "c", override),
    );
    expect(effectiveKeyCardinality(s.mneme, "c", override)).toEqual({
      tags: "multi", other: "multi", status: "single",
    });
    s.close();
  });

  it("undeclared corpus + empty override → undefined, matching resolveKeyCardinality", () => {
    const s = freshSession();
    s.createCorpus({ id: "c" });
    expect(effectiveKeyCardinality(s.mneme, "c", undefined)).toBeUndefined();
    expect(effectiveKeyCardinality(s.mneme, "c", undefined)).toEqual(
      resolveKeyCardinality(s, "c", undefined),
    );
    s.close();
  });
});
