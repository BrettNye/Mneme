import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "./session.js";
import { freshSession, jaccardDeps } from "./test-support.js";
import { reverseReconcile } from "./reverse-reconcile.js";
import { initEmbeddings } from "./embeddings.js";
import type { ReadDeps } from "./types.js";
import type { EmbeddingAdapter } from "../algebra/embedding.js";

const deps = { embeddings: { rankFn: "jaccard" as const } };
const tmpDb = () => join(mkdtempSync(join(tmpdir(), "mneme-rr-")), "s.db");

/**
 * Fake hybrid deps whose fake adapter embeds text as a one-hot bag-of-words vector
 * over a fixed vocabulary. Mirrors real embedding geometry: two texts with ZERO
 * shared tokens are ORTHOGONAL, so cosine maps them to the ~0.5 neutral baseline
 * ((1+cos)/2 with cos=0) — NOT ~0 the way jaccard would score them. This is exactly
 * the hybrid-scorer baseline the production `entityScorer` (rankFn:"hybrid" =
 * max(jaccard,cosine)) exhibits, which is what let the jaccard-only-tuned
 * CLUSTER_EDGE_THRESHOLD silently no-op in production (Approach A never split
 * anything because every pair scored >= the old absolute threshold).
 *
 * initEmbeddings is a module-singleton: only the FIRST call in this file actually
 * runs the factory and registers "cosine"/"hybrid" against this adapter/cache;
 * later calls return the same cached state. The vocab below is a fixed superset
 * covering every value written by every hybrid test in this file, so it stays
 * correct regardless of which test invokes it first.
 */
const HYBRID_VOCAB = [
  "alpha", "bravo", "charlie", "delta", "echo",
  "foxtrot", "golf", "hotel", "india", "juliet",
  "kilo", "lima", "mike", "november", "oscar", "papa",
];
let _hybridAdapterSeq = 0;
async function makeWordBagHybridDeps(): Promise<ReadDeps> {
  const id = `fake-wordbag-adapter-${++_hybridAdapterSeq}`;
  const adapter: EmbeddingAdapter = {
    id, version: "v1", dim: HYBRID_VOCAB.length,
    embed: async (texts) => texts.map((t) => {
      const toks = new Set(t.toLowerCase().split(/\W+/).filter(Boolean));
      return HYBRID_VOCAB.map((w) => (toks.has(w) ? 1 : 0));
    }),
  };
  const embeddings = await initEmbeddings(async () => adapter);
  return { embeddings };
}

describe("reverseReconcile", () => {
  it("flags an over-merged subject (two token-disjoint value clusters), not a cohesive one", async () => {
    const s = openSession({ dbPath: tmpDb(), writer: "t" });
    s.createCorpus({ id: "c" });
    s.write("c", { subject: "project:x", key: "capability", value: "payroll export csv adp", valid: { from: 1, to: Infinity }, source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:x", key: "capability", value: "payroll timesheet approval flow", valid: { from: 2, to: Infinity }, source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:x", key: "capability", value: "geofencing biometric clock gate", valid: { from: 3, to: Infinity }, source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:x", key: "capability", value: "geofencing location perimeter alerts", valid: { from: 4, to: Infinity }, source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:y", key: "capability", value: "scheduling shift calendar", valid: { from: 5, to: Infinity }, source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:y", key: "capability", value: "scheduling shift roster", valid: { from: 6, to: Infinity }, source: "llm", confidence: 0.8 });
    const r = await reverseReconcile(s, { corpus: "c" }, deps);
    expect(r.proposals.some((p) => p.subject === "project:x")).toBe(true);
    expect(r.proposals.some((p) => p.subject === "project:y")).toBe(false);
    s.close();
  });

  it("flags an over-anchored claim (approach B) whose value coheres more with a different subject", async () => {
    const s = freshSession();
    s.createCorpus({ id: "c" });
    s.write("c", { subject: "project:a", key: "feature1", value: "widget inventory tracking barcode scan", source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:a", key: "feature2", value: "widget inventory tracking barcode label", source: "llm", confidence: 0.8 });
    const misattributed = s.write("c", { subject: "project:a", key: "feature3", value: "vehicle telemetry fuel diesel engine", source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:b", key: "feature1", value: "vehicle telemetry fuel diesel", source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:b", key: "feature2", value: "vehicle telemetry fuel gasoline", source: "llm", confidence: 0.8 });

    const r = await reverseReconcile(s, { corpus: "c" }, jaccardDeps);

    const flagged = r.proposals.find(
      (p) => p.confidence === "medium" && p.claim === misattributed.id,
    );
    expect(flagged).toBeDefined();
    expect(flagged?.subject).toBe("project:a");
    expect(flagged?.betterSubject).toBe("project:b");
    expect(flagged?.detail).toMatch(/possible over-merge — review/);
    s.close();
  });

  it("performs NO writes — corpus claim count unchanged after the call (I3)", async () => {
    const s = freshSession();
    s.createCorpus({ id: "c" });
    s.write("c", { subject: "project:x", key: "capability", value: "payroll export csv adp", source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:x", key: "capability2", value: "payroll timesheet approval flow", source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:x", key: "capability3", value: "geofencing biometric clock gate", source: "llm", confidence: 0.8 });

    const before = s.mneme.read("c", { corpusId: "c" }).length;
    await reverseReconcile(s, { corpus: "c" }, jaccardDeps);
    const after = s.mneme.read("c", { corpusId: "c" }).length;

    expect(after).toBe(before);
    s.close();
  });

  it("unknown corpus → empty proposals, no throw, no corpus created", async () => {
    const s = freshSession();
    const r = await reverseReconcile(s, { corpus: "does-not-exist" }, jaccardDeps);

    expect(r.proposals).toEqual([]);
    expect(r.content).toBe('## Reverse Reconcile: corpus "does-not-exist"\n\nNo over-fold signals detected.');
    expect(s.listCorpora().some((c) => c.id === "does-not-exist")).toBe(false);
    s.close();
  });

  it("empty corpus (created, no claims) → empty proposals, no throw", async () => {
    const s = freshSession();
    s.createCorpus({ id: "c" });
    const r = await reverseReconcile(s, { corpus: "c" }, jaccardDeps);

    expect(r.proposals).toEqual([]);
    s.close();
  });

  it("never emits confidence \"high\" — only low/medium, across both detectors", async () => {
    const s = freshSession();
    s.createCorpus({ id: "c" });
    s.write("c", { subject: "project:x", key: "capability", value: "payroll export csv adp", source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:x", key: "capability2", value: "payroll timesheet approval flow", source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:x", key: "capability3", value: "geofencing biometric clock gate", source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:x", key: "capability4", value: "geofencing location perimeter alerts", source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:y", key: "capability", value: "scheduling shift calendar", source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:y", key: "capability2", value: "scheduling shift roster", source: "llm", confidence: 0.8 });

    const r = await reverseReconcile(s, { corpus: "c" }, jaccardDeps);

    expect(r.proposals.length).toBeGreaterThan(0);
    for (const p of r.proposals) {
      expect(p.kind).toBe("subject-over-merge");
      expect(["low", "medium"]).toContain(p.confidence);
      expect(p.detail).toMatch(/possible over-merge — review/);
    }
    s.close();
  });

  it("ranks medium (approach B) proposals before low (approach A) proposals", async () => {
    const s = freshSession();
    s.createCorpus({ id: "c" });
    s.write("c", { subject: "project:a", key: "feature1", value: "widget inventory tracking barcode scan", source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:a", key: "feature2", value: "widget inventory tracking barcode label", source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:a", key: "feature3", value: "vehicle telemetry fuel diesel engine", source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:b", key: "feature1", value: "vehicle telemetry fuel diesel", source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:b", key: "feature2", value: "vehicle telemetry fuel gasoline", source: "llm", confidence: 0.8 });

    const r = await reverseReconcile(s, { corpus: "c" }, jaccardDeps);

    const firstLowIdx = r.proposals.findIndex((p) => p.confidence === "low");
    const firstMediumIdx = r.proposals.findIndex((p) => p.confidence === "medium");
    expect(firstMediumIdx).toBeGreaterThanOrEqual(0);
    if (firstLowIdx >= 0) expect(firstMediumIdx).toBeLessThan(firstLowIdx);
    s.close();
  });

  it("approach A discriminates under hybrid scoring: flags a genuinely two-entity subject and spares a cohesive one, even though cosine maps unrelated text to a ~0.5 baseline (not jaccard's ~0)", async () => {
    const s = freshSession();
    s.createCorpus({ id: "c" });
    // Two-cluster subject: cluster1 shares {alpha,bravo,charlie}; cluster2 shares
    // {foxtrot,golf,hotel}. Cross-cluster pairs share NOTHING — jaccard scores them 0,
    // but the fake cosine adapter scores them at the ~0.5 orthogonal baseline.
    s.write("c", { subject: "project:split", key: "k1", value: "alpha bravo charlie delta", source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:split", key: "k2", value: "alpha bravo charlie echo", source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:split", key: "k3", value: "foxtrot golf hotel india", source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:split", key: "k4", value: "foxtrot golf hotel juliet", source: "llm", confidence: 0.8 });
    // Cohesive subject: every pair shares a common core {kilo,lima} — no meaningful
    // separation, so it must NOT be flagged under either scorer.
    s.write("c", { subject: "project:cohesive", key: "k1", value: "kilo lima mike november", source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:cohesive", key: "k2", value: "kilo lima mike oscar", source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:cohesive", key: "k3", value: "kilo lima papa november", source: "llm", confidence: 0.8 });

    const hybridDeps = await makeWordBagHybridDeps();
    const r = await reverseReconcile(s, { corpus: "c" }, hybridDeps);

    expect(r.rankFn).toBe("hybrid");
    expect(r.proposals.some((p) => p.subject === "project:split" && p.confidence === "low")).toBe(true);
    expect(r.proposals.some((p) => p.subject === "project:cohesive" && p.confidence === "low")).toBe(false);
    s.close();
  });

  it("a subject below minClaims is never flagged by approach A regardless of value diversity", async () => {
    const s = freshSession();
    s.createCorpus({ id: "c" });
    s.write("c", { subject: "project:z", key: "k1", value: "totally unrelated alpha", source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:z", key: "k2", value: "completely different beta", source: "llm", confidence: 0.8 });

    const r = await reverseReconcile(s, { corpus: "c", minClaims: 3 }, jaccardDeps);

    expect(r.proposals.some((p) => p.subject === "project:z" && p.confidence === "low")).toBe(false);
    s.close();
  });

  it("aggregates approach B per subject into ONE proposal (not one per mis-cohering claim)", async () => {
    const s = freshSession();
    s.createCorpus({ id: "c" });
    s.write("c", { subject: "project:a", key: "feature1", value: "widget inventory tracking barcode scan", source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:a", key: "feature2", value: "widget inventory tracking barcode label", source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:a", key: "feature3", value: "vehicle telemetry fuel diesel engine", source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:a", key: "feature4", value: "vehicle telemetry fuel electric hybrid", source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:b", key: "feature1", value: "vehicle telemetry fuel diesel", source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:b", key: "feature2", value: "vehicle telemetry fuel gasoline", source: "llm", confidence: 0.8 });

    const r = await reverseReconcile(s, { corpus: "c" }, jaccardDeps);

    const bProposals = r.proposals.filter((p) => p.confidence === "medium" && p.subject === "project:a");
    expect(bProposals.length).toBe(1);
    expect(bProposals[0].betterSubject).toBe("project:b");
    expect(bProposals[0].affectedClaims).toBeGreaterThanOrEqual(2);
    expect(bProposals[0].detail).toMatch(/possible over-merge — review/);
    s.close();
  });

  it("approach A requires >=2 clusters each with >=2 members — a lone-outlier split (2,1) does not flag; (2,2) does", async () => {
    const s = freshSession();
    s.createCorpus({ id: "c" });
    s.write("c", { subject: "project:floor", key: "k1", value: "payroll export timesheet flow", source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:floor", key: "k2", value: "payroll approval timesheet review", source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:floor", key: "k3", value: "totally unrelated theme node", source: "llm", confidence: 0.8 });

    const r1 = await reverseReconcile(s, { corpus: "c" }, jaccardDeps);
    expect(r1.proposals.some((p) => p.subject === "project:floor" && p.confidence === "low")).toBe(false);

    s.write("c", { subject: "project:floor", key: "k4", value: "totally unrelated theme service", source: "llm", confidence: 0.8 });
    const r2 = await reverseReconcile(s, { corpus: "c" }, jaccardDeps);
    expect(r2.proposals.some((p) => p.subject === "project:floor" && p.confidence === "low")).toBe(true);
    s.close();
  });
});
