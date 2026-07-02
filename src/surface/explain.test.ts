import { describe, it, expect } from "vitest";
import { recall } from "./recall.js";
import { explainRecall } from "./explain.js";
import { remember } from "./remember.js";
import { freshSession, jaccardDeps } from "./test-support.js";

describe("explainRecall — consistency invariant", () => {
  it("served dispositions === recall().matches (same query, same deps)", async () => {
    const s = freshSession();
    const corpus = "c";

    // A merge pair: two token-similar restatements on the same (subject,key).
    remember(s, { subject: "project:mneme", key: "fact", value: "Mneme is the memory layer for RaState", corpus });
    remember(s, { subject: "project:mneme", key: "fact", value: "Mneme serves as the memory layer for RaState", corpus });

    // A single-cardinality supersession: two distinct values, increasing validFrom.
    remember(s, { subject: "user:brett", key: "editor", value: "vim", corpus, validFrom: "2026-01-01T00:00:00Z" });
    remember(s, { subject: "user:brett", key: "editor", value: "helix", corpus, validFrom: "2026-03-01T00:00:00Z" });

    // A plain served claim relevant to the query.
    remember(s, { subject: "project:mneme", key: "decision", value: "dogfood Mneme via an MCP server for deploy tracking", corpus });

    const args = { about: "deploy", corpus: "c", limit: 5 } as const;
    const r = await recall(s, args, jaccardDeps);
    const t = await explainRecall(s, args, jaccardDeps);
    const served = t.claims.filter((d) => d.disposition === "served").map((d) => d.id);
    expect(new Set(served)).toEqual(new Set(r.matches.map((m) => m.id)));
  });

  it("served dispositions === recall().matches with a knob active (relevanceFloor)", async () => {
    const s = freshSession();
    const corpus = "c";

    // A merge pair: two token-similar restatements on the same (subject,key).
    remember(s, { subject: "project:mneme", key: "fact", value: "Mneme is the memory layer for RaState", corpus });
    remember(s, { subject: "project:mneme", key: "fact", value: "Mneme serves as the memory layer for RaState", corpus });

    // A single-cardinality supersession: two distinct values, increasing validFrom.
    remember(s, { subject: "user:brett", key: "editor", value: "vim", corpus, validFrom: "2026-01-01T00:00:00Z" });
    remember(s, { subject: "user:brett", key: "editor", value: "helix", corpus, validFrom: "2026-03-01T00:00:00Z" });

    // A plain served claim relevant to the query.
    remember(s, { subject: "project:mneme", key: "decision", value: "dogfood Mneme via an MCP server for deploy tracking", corpus });

    const args = { about: "deploy", corpus: "c", limit: 5, relevanceFloor: 0.01 } as const;
    const r = await recall(s, args, jaccardDeps);
    const t = await explainRecall(s, args, jaccardDeps);
    const served = t.claims.filter((d) => d.disposition === "served").map((d) => d.id);
    expect(new Set(served)).toEqual(new Set(r.matches.map((m) => m.id)));
  });
});

// ── Reproduction tests: the disposition cases we hit live ─────────────────────

describe("explainRecall — dispositions", () => {
  it("single-cardinality (subject,key) with 3 increasing-validFrom distinct values → 2 deprecated-by + 1 served", async () => {
    const s = freshSession();
    const corpus = "c";
    const deps = jaccardDeps;
    // key defaults to single cardinality; 3 DISTINCT, non-token-similar values so ⊕_dedupe does NOT merge them.
    remember(s, { subject: "s", key: "status", value: "green", corpus, validFrom: "2026-01-01T00:00:00Z" });
    remember(s, { subject: "s", key: "status", value: "yellow", corpus, validFrom: "2026-01-02T00:00:00Z" });
    remember(s, { subject: "s", key: "status", value: "red", corpus, validFrom: "2026-01-03T00:00:00Z" });
    const t = await explainRecall(s, { about: "status", corpus: "c", subject: "s", key: "status", limit: 5 }, deps);
    const deprecated = t.claims.filter((d) => d.disposition === "deprecated");
    const served = t.claims.filter((d) => d.disposition === "served");
    expect(deprecated).toHaveLength(2);
    expect(served).toHaveLength(1);
    for (const d of deprecated) {
      expect(d.reason).toMatchObject({ kind: "deprecated-by", via: "single-cardinality" });
      expect((d.reason as { byId: string }).byId).toBeTruthy();
    }
  });

  it("same three values but key declared multi → all 3 served, zero deprecations", async () => {
    const s = freshSession();
    const corpus = "c";
    remember(s, { subject: "s", key: "status", value: "green", corpus, validFrom: "2026-01-01T00:00:00Z" });
    remember(s, { subject: "s", key: "status", value: "yellow", corpus, validFrom: "2026-01-02T00:00:00Z" });
    remember(s, { subject: "s", key: "status", value: "red", corpus, validFrom: "2026-01-03T00:00:00Z" });
    const multiDeps = { ...jaccardDeps, keyCardinality: { status: "multi" as const } };
    const t = await explainRecall(s, { about: "status", corpus: "c", subject: "s", key: "status", limit: 5 }, multiDeps);
    expect(t.claims.filter((d) => d.disposition === "deprecated")).toHaveLength(0);
    expect(t.claims.filter((d) => d.disposition === "served")).toHaveLength(3);
  });

  it("two token-similar values (jaccard ≥ 0.5) → one merged-into the other", async () => {
    const s = freshSession();
    const corpus = "c";
    remember(s, { subject: "s2", key: "note", value: "deploy the web api", corpus });
    remember(s, { subject: "s2", key: "note", value: "deploy the web api now", corpus });
    const t = await explainRecall(s, { about: "deploy", corpus: "c", subject: "s2", key: "note", limit: 5 }, jaccardDeps);
    const merged = t.claims.filter((d) => d.disposition === "merged");
    expect(merged).toHaveLength(1);
    expect((merged[0].reason as { kind: string; targetId: string }).kind).toBe("merged-into");
    expect((merged[0].reason as { targetId: string }).targetId).toBeTruthy();
  });

  it("a future-dated claim → tau-invalid", async () => {
    const s = freshSession();
    const corpus = "c";
    remember(s, { subject: "s3", key: "k", value: "future value", corpus, validFrom: "2099-01-01T00:00:00Z" });
    const t = await explainRecall(s, { about: "future", corpus: "c", subject: "s3", key: "k", limit: 5 }, jaccardDeps);
    expect(t.claims.some((d) => d.reason.kind === "tau-invalid")).toBe(true);
  });

  it("candidates past limit → over-limit", async () => {
    const s = freshSession();
    const corpus = "c";
    remember(s, { subject: "s4", key: "tag", value: "alpha tag", corpus });
    remember(s, { subject: "s4", key: "tag", value: "beta tag", corpus });
    remember(s, { subject: "s4", key: "tag", value: "gamma tag", corpus });
    const multiDeps = { ...jaccardDeps, keyCardinality: { tag: "multi" as const } };
    const t = await explainRecall(s, { about: "tag", corpus: "c", subject: "s4", key: "tag", limit: 1 }, multiDeps);
    expect(t.claims.filter((d) => d.disposition === "served")).toHaveLength(1);
    expect(t.claims.some((d) => d.reason.kind === "over-limit")).toBe(true);
  });

  it("unknown corpus → empty trace, no throw", async () => {
    const s = freshSession();
    const t = await explainRecall(s, { about: "x", corpus: "does-not-exist", limit: 5 }, jaccardDeps);
    expect(t.candidateCount).toBe(0);
    expect(t.claims).toEqual([]);
  });
});
