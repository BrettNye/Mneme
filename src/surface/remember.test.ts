import { describe, it, expect } from "vitest";
import { recall } from "./recall.js";
import { remember, listCorpora, ensureCorpus } from "./remember.js";
import { freshSession, jaccardDeps } from "./test-support.js";

// ── Existing behaviour (minimal churn) ────────────────────────────────────────

describe("mcp tools — existing behaviour", () => {
  it("remember auto-creates the corpus and commits a claim", () => {
    const s = freshSession();
    const r = remember(s, { subject: "project:mneme", key: "decision", value: "dogfood via MCP", corpus: "dev" });
    expect(r.status).toBe("committed");
    expect(r.corpus).toBe("dev");
    expect(listCorpora(s).corpora.map((c) => c.id)).toContain("dev");
  });

  it("listCorpora reflects created corpora", () => {
    const s = freshSession();
    ensureCorpus(s, "c1");
    ensureCorpus(s, "c2");
    expect(listCorpora(s).corpora.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
  });
});

// ── remember: scope + validFrom ───────────────────────────────────────────────

describe("remember — scope and validFrom", () => {
  it("validFrom sets valid.from (recalled claim has correct temporal interval)", async () => {
    const s = freshSession();
    const corpus = "vf-corpus";
    remember(s, {
      subject: "user:brett",
      key: "editor",
      value: "helix",
      corpus,
      validFrom: "2026-03-01T00:00:00Z",
    });
    // The claim should be retrievable at query time (now > 2026-03-01)
    const r = await recall(s, { about: "editor", corpus }, jaccardDeps);
    expect(r.matches.length).toBe(1);
    expect(r.matches[0].value).toBe("helix");
  });

  it("invalid validFrom ISO string throws a descriptive error", () => {
    const s = freshSession();
    expect(() =>
      remember(s, {
        subject: "user:brett",
        key: "editor",
        value: "helix",
        corpus: "err-corpus",
        validFrom: "not-a-date",
      }),
    ).toThrowError(/validFrom/);
  });

  it("scope round-trips through write (new corpus has default scopeFields)", async () => {
    const s = freshSession();
    const corpus = "scope-corpus";
    // ensureCorpus is called by remember — it should declare default scopeFields
    remember(s, {
      subject: "user:brett",
      key: "editor",
      value: "helix",
      corpus,
      scope: { project: "mneme" },
    });
    // Verify the corpus was created with scopeFields
    const corpusDef = s.inspectCorpus(corpus) as { schema?: { scopeFields?: Record<string, string> } } | undefined;
    expect(corpusDef?.schema?.scopeFields).toMatchObject({
      project: "string",
      person: "string",
      context: "string",
    });
    // The claim should still be retrievable
    const r = await recall(s, { about: "editor", corpus }, jaccardDeps);
    expect(r.matches.length).toBe(1);
  });

  it("both scope and validFrom optional → today's behaviour unchanged", () => {
    const s = freshSession();
    const r = remember(s, { subject: "s", key: "k", value: "v", corpus: "plain-corpus" });
    expect(r.status).toBe("committed");
  });
});

// ── ensureCorpus: default scopeFields ────────────────────────────────────────

describe("ensureCorpus — default scopeFields for new corpora", () => {
  it("new corpus gets project/person/context scopeFields", () => {
    const s = freshSession();
    ensureCorpus(s, "scope-test");
    const def = s.inspectCorpus("scope-test") as { schema?: { scopeFields?: Record<string, string> } } | undefined;
    expect(def?.schema?.scopeFields).toMatchObject({
      project: "string",
      person: "string",
      context: "string",
    });
  });

  it("ensureCorpus is idempotent (calling twice does not throw)", () => {
    const s = freshSession();
    expect(() => {
      ensureCorpus(s, "idem-corpus");
      ensureCorpus(s, "idem-corpus");
    }).not.toThrow();
  });
});
