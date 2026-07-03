import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "./session.js";
import { freshSession, jaccardDeps } from "./test-support.js";
import { reverseReconcile } from "./reverse-reconcile.js";

const deps = { embeddings: { rankFn: "jaccard" as const } };
const tmpDb = () => join(mkdtempSync(join(tmpdir(), "mneme-rr-")), "s.db");

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
    expect(r.content).toBe("");
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

  it("a subject below minClaims is never flagged by approach A regardless of value diversity", async () => {
    const s = freshSession();
    s.createCorpus({ id: "c" });
    s.write("c", { subject: "project:z", key: "k1", value: "totally unrelated alpha", source: "llm", confidence: 0.8 });
    s.write("c", { subject: "project:z", key: "k2", value: "completely different beta", source: "llm", confidence: 0.8 });

    const r = await reverseReconcile(s, { corpus: "c", minClaims: 3 }, jaccardDeps);

    expect(r.proposals.some((p) => p.subject === "project:z" && p.confidence === "low")).toBe(false);
    s.close();
  });
});
