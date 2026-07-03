import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "./session.js";
import { ingest, type IngestContext } from "./ingest.js";

const deps = { embeddings: { rankFn: "jaccard" as const } };
const tmpDb = () => join(mkdtempSync(join(tmpdir(), "mneme-ingest-")), "store.db");

describe("ingest", () => {
  it("auto-remaps a reuse-match candidate to the canonical subject instead of minting", async () => {
    const s = openSession({ dbPath: tmpDb(), writer: "t" });
    s.createCorpus({ id: "c" });
    s.write("c", {
      subject: "project:crewtracks", key: "status", value: "active",
      valid: { from: 1, to: Infinity }, source: "llm", confidence: 0.8,
    });
    const report = await ingest(s, {
      corpus: "c",
      extract: () => [{
        subject: "project:crewtracks", key: "status", value: "shipping",
        validFrom: "2026-02-01T00:00:00Z",
      }],
    }, deps);
    const claim = report.claims[0];
    expect(claim.subject.final).toBe("project:crewtracks");
    expect(claim.subject.disposition).toBe("reuse");
    // Exact-spelling reuse (the common case: extractor reuses the canonical spelling
    // verbatim from IngestContext) must NOT set remappedFrom — remappedFrom === final
    // would be misleading "X -> X" noise.
    expect(claim.subject.remappedFrom).toBeUndefined();
    s.close();
  });

  it("records remappedFrom for a genuine spelling variant that still scores reuse", async () => {
    const s = openSession({ dbPath: tmpDb(), writer: "t" });
    s.createCorpus({ id: "c" });
    s.write("c", {
      subject: "project:crewtracks", key: "status", value: "active",
      valid: { from: 1, to: Infinity }, source: "llm", confidence: 0.8,
    });
    const report = await ingest(s, {
      corpus: "c",
      // Differs only in case from the canonical spelling — jaccard tokenizes
      // case-insensitively, so this still scores a full-confidence "reuse" match,
      // but the raw candidate bytes genuinely differ from the matched existing value.
      extract: () => [{
        subject: "Project:CrewTracks", key: "status", value: "shipping",
        validFrom: "2026-02-01T00:00:00Z",
      }],
    }, deps);
    const claim = report.claims[0];
    expect(claim.subject.disposition).toBe("reuse");
    expect(claim.subject.final).toBe("project:crewtracks");
    expect(claim.subject.remappedFrom).toBe("Project:CrewTracks");
    s.close();
  });

  it("passes the corpus's live canonical subjects/keys to extract via IngestContext", async () => {
    const s = openSession({ dbPath: tmpDb(), writer: "t" });
    s.createCorpus({ id: "c" });
    s.write("c", {
      subject: "project:crewtracks", key: "status", value: "active",
      valid: { from: 1, to: Infinity },
    });
    let seenCtx: IngestContext | undefined;
    await ingest(s, {
      corpus: "c",
      extract: (ctx) => {
        seenCtx = ctx;
        return [];
      },
    }, deps);
    expect(seenCtx?.corpus).toBe("c");
    expect(seenCtx?.canonicalSubjects).toContain("project:crewtracks");
    expect(seenCtx?.canonicalKeys).toContain("status");
    // canonPrompt lists the live canon AND carries the anti-over-anchoring framing
    // (reuse-when-SAME / mint-when-NEW, mint-when-unsure) — validated by the real-LLM A/B,
    // where a "prefer existing" prompt collapsed 17 distinct entities onto 2 subjects.
    const cp = seenCtx?.canonPrompt ?? "";
    expect(cp).toContain("project:crewtracks");
    expect(cp).toMatch(/same entity/i);
    expect(cp).toMatch(/\bmint\b/i);
    expect(cp).toMatch(/when unsure.*mint/i);
    s.close();
  });

  it("does not auto-fold a genuinely-distinct candidate (over-anchoring guard)", async () => {
    const s = openSession({ dbPath: tmpDb(), writer: "t" });
    s.createCorpus({ id: "c" });
    s.write("c", {
      subject: "project:crewtracks", key: "status", value: "active",
      valid: { from: 1, to: Infinity },
    });
    const report = await ingest(s, {
      corpus: "c",
      extract: () => [{
        subject: "division:traffic-control", key: "status", value: "active",
        validFrom: "2026-02-01T00:00:00Z",
      }],
    }, deps);
    const claim = report.claims[0];
    expect(["new", "uncertain"]).toContain(claim.subject.disposition);
    expect(claim.subject.final).toBe("division:traffic-control");
    expect(claim.subject.remappedFrom).toBeUndefined();
    expect(claim.write?.id).toBeDefined();
    s.close();
  });

  it("reports supersession when a second distinct value lands on a single-cardinality key", async () => {
    const s = openSession({ dbPath: tmpDb(), writer: "t" });
    s.createCorpus({ id: "c" });
    const first = s.write("c", {
      subject: "project:crewtracks", key: "status", value: "active",
      valid: { from: 1, to: Infinity },
    });
    const report = await ingest(s, {
      corpus: "c",
      extract: () => [{
        subject: "project:crewtracks", key: "status", value: "shipping",
        validFrom: "2026-02-01T00:00:00Z",
      }],
    }, deps);
    const claim = report.claims[0];
    expect(claim.write?.supersession?.action).toBe("superseded");
    expect(claim.write?.supersession?.deprecatedIds).toContain(first.id);
    expect(report.counts.superseded).toBe(1);
    s.close();
  });

  it("dryRun performs extract+reconcile+audit but writes nothing", async () => {
    const s = openSession({ dbPath: tmpDb(), writer: "t" });
    s.createCorpus({ id: "c", keyCardinality: { plan: "single" } });
    s.write("c", { subject: "p", key: "plan", value: "alpha", valid: { from: 1, to: Infinity } });
    s.write("c", { subject: "p", key: "plan", value: "bravo", valid: { from: 2, to: Infinity } });
    const before = s.mneme.read("c", { corpusId: "c" }).length;
    const report = await ingest(s, {
      corpus: "c",
      extract: () => [{ subject: "p", key: "plan", value: "charlie", validFrom: "2026-03-01T00:00:00Z" }],
      dryRun: true,
    }, deps);
    expect(s.mneme.read("c", { corpusId: "c" }).length).toBe(before);
    expect(report.claims).toHaveLength(1);
    expect(report.claims.every((c) => c.write === undefined)).toBe(true);
    expect(report.dryRun).toBe(true);
    expect(report.proposals.some((p) => p.kind === "cardinality-declare")).toBe(true);
    s.close();
  });

  it("autoDeclareCardinality defaults to false: proposals surfaced but schema untouched", async () => {
    const s = openSession({ dbPath: tmpDb(), writer: "t" });
    s.createCorpus({ id: "c", keyCardinality: { plan: "single" } });
    s.write("c", { subject: "p", key: "plan", value: "alpha", valid: { from: 1, to: Infinity } });
    s.write("c", { subject: "p", key: "plan", value: "bravo", valid: { from: 2, to: Infinity } });
    const report = await ingest(s, { corpus: "c", extract: () => [] }, deps);
    expect(report.proposals.some((p) => p.kind === "cardinality-declare")).toBe(true);
    expect(
      (s.inspectCorpus("c") as { schema: { keyCardinality: Record<string, string> } }).schema.keyCardinality,
    ).toEqual({ plan: "single" });
    s.close();
  });

  it("autoDeclareCardinality:true applies ONLY cardinality-declare proposals via declareCardinality", async () => {
    const s = openSession({ dbPath: tmpDb(), writer: "t" });
    s.createCorpus({ id: "c", keyCardinality: { plan: "single" } });
    s.write("c", { subject: "p", key: "plan", value: "alpha", valid: { from: 1, to: Infinity } });
    s.write("c", { subject: "p", key: "plan", value: "bravo", valid: { from: 2, to: Infinity } });
    await ingest(s, { corpus: "c", extract: () => [], autoDeclareCardinality: true }, deps);
    expect(
      (s.inspectCorpus("c") as { schema: { keyCardinality: Record<string, string> } }).schema.keyCardinality,
    ).toEqual({ plan: "multi" });
    s.close();
  });

  it("unknown corpus degrades gracefully: well-formed report reflecting the callback, no throw", async () => {
    const s = openSession({ dbPath: tmpDb(), writer: "t" });
    const report = await ingest(s, {
      corpus: "never-seen",
      extract: () => [{ subject: "project:new", key: "status", value: "active" }],
    }, deps);
    expect(report.counts.extracted).toBe(1);
    expect(report.claims).toHaveLength(1);
    expect(report.corpus).toBe("never-seen");
    s.close();
  });

  it("composes a human-readable content string", async () => {
    const s = openSession({ dbPath: tmpDb(), writer: "t" });
    s.createCorpus({ id: "c" });
    s.write("c", { subject: "project:crewtracks", key: "status", value: "active", valid: { from: 1, to: Infinity } });
    const report = await ingest(s, {
      corpus: "c",
      extract: () => [{ subject: "project:crewtracks", key: "status", value: "shipping", validFrom: "2026-02-01T00:00:00Z" }],
    }, deps);
    expect(report.content).toContain("Ingest");
    expect(report.content.length).toBeGreaterThan(0);
    s.close();
  });
});
