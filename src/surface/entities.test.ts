import { describe, it, expect } from "vitest";
import { freshSession, jaccardDeps, makeFakeHybridDeps } from "./test-support.js";
import { distinctEntities, entityScorer } from "./entities.js";

describe("distinctEntities", () => {
  it("returns live distinct subjects with per-subject counts", () => {
    const s = freshSession();
    const corpus = "c";
    s.createCorpus({ id: corpus });
    s.write(corpus, { subject: "s1", key: "k1", value: "a" });
    s.write(corpus, { subject: "s1", key: "k2", value: "b" });
    s.write(corpus, { subject: "s2", key: "k1", value: "c" });

    const got = distinctEntities(s, corpus, "subject", jaccardDeps, {}, Date.now());
    expect(got.find((e) => e.value === "s1")?.claims).toBe(2);
    expect(got.find((e) => e.value === "s2")?.claims).toBe(1);
  });

  it("returns live distinct keys with per-key counts (axis: key)", () => {
    const s = freshSession();
    const corpus = "c";
    s.createCorpus({ id: corpus });
    s.write(corpus, { subject: "s1", key: "k1", value: "a" });
    s.write(corpus, { subject: "s2", key: "k1", value: "b" });
    s.write(corpus, { subject: "s1", key: "k2", value: "c" });

    const got = distinctEntities(s, corpus, "key", jaccardDeps, {}, Date.now());
    expect(got.find((e) => e.value === "k1")?.claims).toBe(2);
    expect(got.find((e) => e.value === "k2")?.claims).toBe(1);
  });

  it("excludes deprecated claims (only the newer value on the same subject/key survives)", () => {
    const s = freshSession();
    const corpus = "c";
    s.createCorpus({ id: corpus });
    s.write(corpus, { subject: "user:brett", key: "editor", value: "vim", valid: { from: Date.parse("2026-01-01T00:00:00Z"), to: Infinity } });
    s.write(corpus, { subject: "user:brett", key: "editor", value: "helix", valid: { from: Date.parse("2026-03-01T00:00:00Z"), to: Infinity } });

    const got = distinctEntities(s, corpus, "subject", jaccardDeps, {}, Date.now());
    expect(got.find((e) => e.value === "user:brett")?.claims).toBe(1);
  });

  it("results are sorted by count desc, then value asc", () => {
    const s = freshSession();
    const corpus = "c";
    s.createCorpus({ id: corpus });
    s.write(corpus, { subject: "b", key: "k1", value: "1" });
    s.write(corpus, { subject: "a", key: "k1", value: "2" });
    s.write(corpus, { subject: "a", key: "k2", value: "3" });

    const got = distinctEntities(s, corpus, "subject", jaccardDeps, {}, Date.now());
    expect(got.map((e) => e.value)).toEqual(["a", "b"]);
  });

  it("uses the caller-supplied now, not Date.now(), for the pipeline instant", () => {
    const s = freshSession();
    const corpus = "c";
    s.createCorpus({ id: corpus });
    // Claim valid only in the future relative to a fixed `past` instant.
    const future = Date.parse("2099-01-01T00:00:00Z");
    s.write(corpus, { subject: "s1", key: "k1", value: "a", valid: { from: future, to: Infinity } });

    const past = Date.parse("2000-01-01T00:00:00Z");
    const gotPast = distinctEntities(s, corpus, "subject", jaccardDeps, {}, past);
    expect(gotPast.find((e) => e.value === "s1")).toBeUndefined();

    const gotFuture = distinctEntities(s, corpus, "subject", jaccardDeps, {}, future + 1);
    expect(gotFuture.find((e) => e.value === "s1")?.claims).toBe(1);
  });
});

describe("entityScorer", () => {
  it("returns the registered rank fn and a symmetric scoreOne with jaccard deps", async () => {
    const { rankFn, warnings, scoreOne } = await entityScorer(["foo", "bar"], jaccardDeps);
    expect(rankFn).toBe("jaccard");
    expect(warnings).toEqual([]);
    expect(scoreOne("foo", "bar")).toBeCloseTo(scoreOne("bar", "foo"), 10);
  });

  it("falls back to jaccard with a warning when warm-up throws", async () => {
    const deps = await makeFakeHybridDeps();
    // Force warm-up to fail on this call while leaving the registered fns intact.
    deps.embeddings.adapter!.embed = async () => {
      throw new Error("boom");
    };
    const { rankFn, warnings } = await entityScorer(["foo", "bar"], deps);
    expect(rankFn).toBe("jaccard");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/warm-up failed/);
  });
});
