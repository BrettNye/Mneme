import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "../surface/index.js";
import { remember, recall, listCorpora, ensureCorpus } from "./tools.js";

function freshSession() {
  const db = join(mkdtempSync(join(tmpdir(), "mneme-mcp-")), "store.db");
  return openSession({ dbPath: db, writer: "test" });
}

describe("mcp tools", () => {
  it("remember auto-creates the corpus and commits a claim", () => {
    const s = freshSession();
    const r = remember(s, { subject: "project:mneme", key: "decision", value: "dogfood via MCP", corpus: "dev" });
    expect(r.status).toBe("committed");
    expect(r.corpus).toBe("dev");
    expect(listCorpora(s).corpora.map((c) => c.id)).toContain("dev");
  });

  it("recall similarity-ranks and composes, surfacing confidence", () => {
    const s = freshSession();
    ensureCorpus(s, "dev");
    remember(s, { subject: "project:mneme", key: "decision", value: "dogfood Mneme via an MCP server", corpus: "dev", confidence: 0.9 });
    remember(s, { subject: "project:mneme", key: "note", value: "the weather is sunny today", corpus: "dev", confidence: 0.5 });

    const r = recall(s, { about: "dogfood MCP server", corpus: "dev", maxTokens: 1000, limit: 5 });
    // The relevant claim ranks first and carries its confidence (point estimate).
    expect(r.matches.length).toBeGreaterThan(0);
    expect(r.matches[0].value).toContain("dogfood");
    expect(r.matches[0].confidence).toBeCloseTo(0.9, 5);
    expect(r.matches[0].score).toBeGreaterThan(0);
    // The composed context is a non-empty string mentioning the recalled value.
    expect(r.content).toContain("dogfood");
  });

  it("recall filters by subject/key before ranking", () => {
    const s = freshSession();
    remember(s, { subject: "host:a", key: "status", value: "healthy", corpus: "ops" });
    remember(s, { subject: "host:b", key: "status", value: "degraded", corpus: "ops" });
    const r = recall(s, { about: "status", corpus: "ops", subject: "host:a" });
    expect(r.matches.every((m) => m.subject === "host:a")).toBe(true);
  });

  it("listCorpora reflects created corpora", () => {
    const s = freshSession();
    ensureCorpus(s, "c1");
    ensureCorpus(s, "c2");
    expect(listCorpora(s).corpora.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
  });
});
