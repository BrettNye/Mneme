import { describe, it, expect } from "vitest";
import { freshSession } from "./test-support.js";
import { supersessionOutcome } from "./belief-change.js";

describe("supersessionOutcome", () => {
  it("reports superseded on a single-cardinality distinct-value write", () => {
    const s = freshSession();
    s.createCorpus({ id: "c", keyCardinality: { plan: "single" } });
    const a = s.write("c", { subject: "p", key: "plan", value: "alpha", valid: { from: 1, to: Infinity } });
    const b = s.write("c", { subject: "p", key: "plan", value: "bravo", valid: { from: 2, to: Infinity } });
    const out = supersessionOutcome(s, "c", b.id);
    expect(out.action).toBe("superseded");
    expect(out.deprecatedIds).toContain(a.id);
    expect(out.reason).toEqual({ kind: "deprecated-by", byId: b.id, via: "single-cardinality" });
    s.close();
  });

  it("reports merged when the just-written claim is absorbed by a token-similar, later-valid claim", () => {
    // ⊕_dedupe's subPartitions keeps the LATEST valid.from member as the survivor
    // (subPartitions doc, combination.ts). Writing `b` with an EARLIER valid.from than the
    // already-present, token-similar `a` deterministically makes `b` the absorbed member.
    const s = freshSession();
    s.createCorpus({ id: "c", keyCardinality: { note: "single" } });
    const a = s.write("c", { subject: "p", key: "note", value: "deploy the api now", valid: { from: 2, to: Infinity } });
    const b = s.write("c", { subject: "p", key: "note", value: "deploy the api", valid: { from: 1, to: Infinity } });
    const out = supersessionOutcome(s, "c", b.id);
    expect(out.action).toBe("merged");
    expect(out.mergedInto).toBe(a.id);
    expect(out.reason).toEqual({ kind: "merged-into", targetId: a.id });
    s.close();
  });

  it("reports duplicate when the just-written claim carries the identical value already present", () => {
    const s = freshSession();
    s.createCorpus({ id: "c", keyCardinality: { note: "single" } });
    const a = s.write("c", { subject: "p", key: "note", value: "deploy the api", valid: { from: 2, to: Infinity } });
    const b = s.write("c", { subject: "p", key: "note", value: "deploy the api", valid: { from: 1, to: Infinity } });
    const out = supersessionOutcome(s, "c", b.id);
    expect(out.action).toBe("duplicate");
    expect(out.mergedInto).toBe(a.id);
    s.close();
  });

  it("reports committed for a distinct write under a multi-cardinality key", () => {
    const s = freshSession();
    s.createCorpus({ id: "c", keyCardinality: { tag: "multi" } });
    s.write("c", { subject: "p", key: "tag", value: "alpha", valid: { from: 1, to: Infinity } });
    const b = s.write("c", { subject: "p", key: "tag", value: "bravo", valid: { from: 2, to: Infinity } });
    const out = supersessionOutcome(s, "c", b.id);
    expect(out.action).toBe("committed");
    expect(out.deprecatedIds).toEqual([]);
    s.close();
  });

  it("does not attribute deprecation to a claim that was merged away by ⊕_dedupe (pipeline fidelity)", () => {
    // ⊕_dedupe runs BEFORE ⊥ in the canonical read pipeline (τ_valid → ⊕_dedupe → ⊥), so
    // pairsOf must run on dedupe SURVIVORS, not the raw τ_valid group — otherwise a merged-away
    // claim can be wrongly reported as a live deprecation target. a and a2 are token-similar
    // (jaccard ≈0.75); a2 has the later valid.from so it is the dedupe survivor and `a` is
    // merged away. `b` is a distinct-value write that should deprecate only the live survivor.
    const s = freshSession();
    s.createCorpus({ id: "c", keyCardinality: { note: "single" } });
    const a = s.write("c", { subject: "p", key: "note", value: "deploy the api now", valid: { from: 1, to: Infinity } });
    const a2 = s.write("c", { subject: "p", key: "note", value: "deploy the api", valid: { from: 2, to: Infinity } });
    const b = s.write("c", { subject: "p", key: "note", value: "rollback everything", valid: { from: 3, to: Infinity } });
    const out = supersessionOutcome(s, "c", b.id);
    expect(out.action).toBe("superseded");
    expect(out.deprecatedIds).toEqual([a2.id]);
    expect(out.deprecatedIds).not.toContain(a.id);
    s.close();
  });

  it("reports committed with empty deprecatedIds for the very first write to a (subject,key)", () => {
    const s = freshSession();
    s.createCorpus({ id: "c", keyCardinality: { plan: "single" } });
    const a = s.write("c", { subject: "p", key: "plan", value: "alpha", valid: { from: 1, to: Infinity } });
    const out = supersessionOutcome(s, "c", a.id);
    expect(out.action).toBe("committed");
    expect(out.deprecatedIds).toEqual([]);
    s.close();
  });

  it("reports committed (no throw) when claimId is not found among written claims", () => {
    const s = freshSession();
    s.createCorpus({ id: "c", keyCardinality: { plan: "single" } });
    s.write("c", { subject: "p", key: "plan", value: "alpha", valid: { from: 1, to: Infinity } });
    const out = supersessionOutcome(s, "c", "nonexistent-id");
    expect(out.action).toBe("committed");
    expect(out.deprecatedIds).toEqual([]);
    s.close();
  });
});
