import { describe, it, expect, vi, afterEach } from "vitest";
import { openSession } from "./session.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recall, keyCensus } from "./recall.js";
import { remember, listCorpora, ensureCorpus } from "./remember.js";
import { freshSession, jaccardDeps, makeFakeHybridDeps } from "./test-support.js";
// NOTE (layering exception, test-only): see test-support.ts — _resetEmbeddingsForTest
// has no surface equivalent (mcp-only singleton), same accepted exception.
import { _resetEmbeddingsForTest } from "../mcp/embeddings.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Existing behaviour (minimal churn) ────────────────────────────────────────

describe("mcp tools — existing behaviour", () => {
  it("recall similarity-ranks and composes, surfacing confidence", async () => {
    const s = freshSession();
    ensureCorpus(s, "dev");
    remember(s, { subject: "project:mneme", key: "decision", value: "dogfood Mneme via an MCP server", corpus: "dev", confidence: 0.9 });
    remember(s, { subject: "project:mneme", key: "note", value: "the weather is sunny today", corpus: "dev", confidence: 0.5 });

    const r = await recall(s, { about: "dogfood MCP server", corpus: "dev", maxTokens: 1000, limit: 5 }, jaccardDeps);
    // The relevant claim ranks first and carries its confidence (point estimate).
    expect(r.matches.length).toBeGreaterThan(0);
    expect(r.matches[0].value).toContain("dogfood");
    expect(r.matches[0].confidence).toBeCloseTo(0.9, 5);
    expect(r.matches[0].score).toBeGreaterThan(0);
    // The composed context is a non-empty string mentioning the recalled value.
    expect(r.content).toContain("dogfood");
  });

  it("recall filters by subject/key before ranking", async () => {
    const s = freshSession();
    remember(s, { subject: "host:a", key: "status", value: "healthy", corpus: "ops" });
    remember(s, { subject: "host:b", key: "status", value: "degraded", corpus: "ops" });
    const r = await recall(s, { about: "status", corpus: "ops", subject: "host:a" }, jaccardDeps);
    expect(r.matches.every((m) => m.subject === "host:a")).toBe(true);
  });

  it("recall on an unknown corpus returns empty and does NOT create it (read-only)", async () => {
    const s = freshSession();
    const r = await recall(s, { about: "anything", corpus: "never-seen" }, jaccardDeps);
    expect(r.matches).toEqual([]);
    expect(r.content).toBe("");
    expect(r.abstained).toBe(false);
    // The side-effect-free contract: recall must not have materialized the corpus.
    expect(listCorpora(s).corpora.map((c) => c.id)).not.toContain("never-seen");
  });

  it("persists claims across a session restart (same db file)", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-mcp-persist-")), "store.db");
    const s1 = openSession({ dbPath: db, writer: "test" });
    remember(s1, { subject: "project:x", key: "decision", value: "survives-restart", corpus: "dev" });
    s1.close();

    const s2 = openSession({ dbPath: db, writer: "test" });
    const r = await recall(s2, { about: "decision", corpus: "dev", subject: "project:x" }, jaccardDeps);
    expect(r.matches.length).toBe(1);
    expect(r.matches[0].value).toBe("survives-restart");
    s2.close();
  });
});

// ── Canonical pipeline: supersession ─────────────────────────────────────────

describe("recall — canonical pipeline", () => {
  it("supersession returns ONLY the newer value (resolveDeprecateOlder)", async () => {
    const s = freshSession();
    const corpus = "test-supersede";
    const base = { subject: "user:brett", corpus };
    remember(s, { ...base, key: "editor", value: "vim", validFrom: "2026-01-01T00:00:00Z" });
    remember(s, { ...base, key: "editor", value: "helix", validFrom: "2026-03-01T00:00:00Z" });
    const r = await recall(s, { about: "editor", corpus }, jaccardDeps);
    expect(r.matches.map((m) => m.value)).toEqual(["helix"]);
  });

  it("no-validFrom writes default valid.from to now → last-write-wins, no tie flag", async () => {
    const s = freshSession();
    const corpus = "test-now-supersede";
    const base = { subject: "user:brett", corpus };
    // Stub Date.now to two distinct instants so the second write strictly
    // post-dates the first (no reliance on wall-clock millisecond resolution).
    const t1 = Date.parse("2026-06-01T00:00:00Z");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t1);
    remember(s, { ...base, key: "editor", value: "vim" });
    nowSpy.mockReturnValue(t1 + 60_000);
    remember(s, { ...base, key: "editor", value: "helix" });
    nowSpy.mockRestore(); // recall evaluates τ_valid at the real "now"

    const r = await recall(s, { about: "editor", corpus }, jaccardDeps);
    // Last write wins via supersession: ONLY the second value, and no
    // contradiction-flag artifact left in matches.
    expect(r.matches.map((m) => m.value)).toEqual(["helix"]);
  });

  it("multi-key (keyCardinality=multi) returns both values", async () => {
    const s = freshSession();
    const corpus = "test-multi";
    const base = { subject: "user:brett", corpus };
    remember(s, { ...base, key: "lang", value: "TypeScript" });
    remember(s, { ...base, key: "lang", value: "Rust" });
    const r = await recall(
      s,
      { about: "lang", corpus },
      { ...jaccardDeps, keyCardinality: { lang: "multi" } },
    );
    const vals = r.matches.map((m) => m.value as string).sort();
    expect(vals).toEqual(["Rust", "TypeScript"].sort());
  });

  it("paraphrase restatements merged (dedupe stage) yields single match", async () => {
    const s = freshSession();
    const corpus = "test-dedupe";
    // Two claims with high token overlap — oplusDedupe should merge them
    remember(s, { subject: "project:mneme", key: "fact", value: "Mneme is the memory layer for RaState", corpus });
    remember(s, { subject: "project:mneme", key: "fact", value: "Mneme serves as the memory layer for RaState", corpus });
    const r = await recall(s, { about: "Mneme memory layer RaState", corpus }, jaccardDeps);
    // After dedupe, near-duplicate claims merge → single match
    expect(r.matches.length).toBe(1);
  });
});

// ── topScore, abstained, rankFn ───────────────────────────────────────────────

describe("recall — topScore / abstained / rankFn fields", () => {
  it("topScore is present even when corpus exists (non-empty result)", async () => {
    const s = freshSession();
    const corpus = "ts-corpus";
    remember(s, { subject: "s", key: "k", value: "some value about the query", corpus });
    const r = await recall(s, { about: "query", corpus }, jaccardDeps);
    expect(typeof r.topScore).toBe("number");
    expect(r.topScore).toBeGreaterThanOrEqual(0);
  });

  it("abstainBelowTop: weak top score → abstained=true, empty matches/content, topScore PRESENT", async () => {
    const s = freshSession();
    const corpus = "abstain-corpus";
    // "xyz xyz xyz" vs "abc" → very low jaccard score
    remember(s, { subject: "s", key: "k", value: "xyz xyz xyz", corpus });
    const r = await recall(s, { about: "abc", corpus, abstainBelowTop: 0.99 }, jaccardDeps);
    expect(r.abstained).toBe(true);
    expect(r.matches).toEqual([]);
    expect(r.content).toBe("");
    // topScore extracted BEFORE abstain knob
    expect(typeof r.topScore).toBe("number");
    expect(r.topScore).toBeDefined();
  });

  it("relevanceFloor filters entries WITHOUT triggering abstained", async () => {
    const s = freshSession();
    const corpus = "floor-corpus";
    remember(s, { subject: "s", key: "k", value: "xyz xyz xyz", corpus });
    const r = await recall(s, { about: "abc", corpus, relevanceFloor: 0.99 }, jaccardDeps);
    // Floor empties the result — but NOT abstained (floor = precision filter, not abstention)
    expect(r.abstained).toBe(false);
    expect(r.matches).toEqual([]);
  });

  it("rankFn field reflects the deps.embeddings.rankFn", async () => {
    const s = freshSession();
    const corpus = "rankfn-corpus";
    const r = await recall(s, { about: "test", corpus }, jaccardDeps);
    expect(r.rankFn).toBe("jaccard");
  });

  it("exactly ONE mneme.query call per recall (single execution)", async () => {
    const s = freshSession();
    const corpus = "onequery-corpus";
    remember(s, { subject: "s", key: "k", value: "test value", corpus });

    const querySpy = vi.spyOn(s.mneme, "query");
    await recall(s, { about: "test", corpus }, jaccardDeps);
    expect(querySpy).toHaveBeenCalledTimes(1);
  });
});

// ── Hybrid deps: warm-up ──────────────────────────────────────────────────────

describe("recall — hybrid deps warm-up", () => {
  afterEach(() => {
    _resetEmbeddingsForTest();
  });

  it("hybrid deps: warm-up before query (no cache-miss throw), rankFn reflects hybrid", async () => {
    // NOTE: must be the FIRST hybrid test — after this, the registered "cosine"/"hybrid"
    // similarity fns are locked to this test's cache (stale-closure; see test-support.ts).
    const s = freshSession();
    const corpus = "hybrid-corpus";
    remember(s, { subject: "s", key: "k", value: "some hybrid value", corpus });

    const deps = await makeFakeHybridDeps();
    // Should not throw (warm-up seeds the cache before the query)
    const r = await recall(s, { about: "hybrid value", corpus }, deps);
    expect(r.rankFn).toBe("hybrid");
    expect(r.matches.length).toBeGreaterThan(0);
  });

  it("jaccard deps: no warm-up needed, result is non-empty", async () => {
    const s = freshSession();
    const corpus = "jac-warmup-corpus";
    remember(s, { subject: "s", key: "k", value: "jaccard test value", corpus });
    const r = await recall(s, { about: "jaccard test", corpus }, jaccardDeps);
    expect(r.rankFn).toBe("jaccard");
    expect(r.matches.length).toBeGreaterThan(0);
  });

  it("hybrid warm-up with subject filter only embeds matching-subject values (+ query)", async () => {
    // Stale-closure note: this test runs after the first hybrid test, so the registered
    // "cosine"/"hybrid" fns use that test's cache. warmValues still fills the new cache
    // correctly — we verify the warm-up scope via the adapter spy and ignore scoring.
    // (warmValues is called BEFORE session.mneme.query, so spy data is captured even if
    //  the scoring phase throws due to stale closure.)
    const s = freshSession();
    const corpus = "hybrid-scoped-corpus";
    // Two subjects — warm-up should only embed "target" values when subject filter is applied
    remember(s, { subject: "target", key: "info", value: "relevant value", corpus });
    remember(s, { subject: "other", key: "info", value: "unrelated noise", corpus });

    const deps = await makeFakeHybridDeps();
    // Spy on embed to capture what warmValues passes to the adapter
    const embedSpy = vi.spyOn(deps.embeddings.adapter!, "embed");

    // Scoring may throw after warm-up (stale-closure); warm-up spy is populated before scoring.
    try { await recall(s, { about: "relevant", corpus, subject: "target" }, deps); } catch (_) { /* expected */ }

    // embed() should have been called with ONLY "relevant value" + "relevant" (query),
    // NOT "unrelated noise" (warm-up must be scoped to the subject filter)
    const allEmbedded = embedSpy.mock.calls.flatMap((call) => call[0] as string[]);
    expect(allEmbedded).toContain("relevant value");
    expect(allEmbedded).not.toContain("unrelated noise");
  });
});

// ── alias-aware recall ────────────────────────────────────────────────────────

describe("recall — alias-aware key matching", () => {
  /**
   * Helper: write an alias claim (key="alias-of", subject="key:<variant>", value=<canonical>)
   * to a corpus so that aliasMapOf() can build the map.
   */
  function rememberAlias(
    s: ReturnType<typeof freshSession>,
    variant: string,
    canonical: string,
    corpus: string,
  ) {
    remember(s, {
      subject: `key:${variant}`,
      key: "alias-of",
      value: canonical,
      corpus,
    });
  }

  it("recall by canonical key retrieves the surviving variant-key claim", async () => {
    const s = freshSession();
    const corpus = "alias-canonical";
    // editor (old, vim) — the variant key
    remember(s, {
      subject: "user:brett",
      key: "editor",
      value: "vim",
      corpus,
      validFrom: "2026-01-01T00:00:00Z",
    });
    // preferred_editor (new, emacs) — the canonical key supersedes editor
    remember(s, {
      subject: "user:brett",
      key: "preferred_editor",
      value: "emacs",
      corpus,
      validFrom: "2026-03-01T00:00:00Z",
    });
    // Alias: editor → preferred_editor (editor is the old variant, preferred_editor is the canonical)
    rememberAlias(s, "editor", "preferred_editor", corpus);

    const r = await recall(s, { about: "editor", key: "editor", corpus }, jaccardDeps);
    // The canonical key's value should be returned; the stale variant claim is resolved away
    expect(r.matches.map((m) => m.key)).toEqual(["preferred_editor"]);
  });

  it("recall by variant key (preferred_editor) also retrieves across the family", async () => {
    const s = freshSession();
    const corpus = "alias-variant-dir";
    remember(s, {
      subject: "user:brett",
      key: "editor",
      value: "vim",
      corpus,
      validFrom: "2026-01-01T00:00:00Z",
    });
    remember(s, {
      subject: "user:brett",
      key: "preferred_editor",
      value: "emacs",
      corpus,
      validFrom: "2026-03-01T00:00:00Z",
    });
    rememberAlias(s, "editor", "preferred_editor", corpus);

    // Query by canonical key → should still retrieve the surviving claim
    const r = await recall(s, { about: "preferred editor", key: "preferred_editor", corpus }, jaccardDeps);
    expect(r.matches.map((m) => m.key)).toEqual(["preferred_editor"]);
  });

  it("zero alias claims — behavior identical to today (no warnings, same results)", async () => {
    const s = freshSession();
    const corpus = "no-aliases";
    remember(s, { subject: "user:brett", key: "editor", value: "helix", corpus });

    const r = await recall(s, { about: "editor", key: "editor", corpus }, jaccardDeps);
    expect(r.matches.length).toBe(1);
    expect(r.matches[0].value).toBe("helix");
    // No warnings when there are no alias claims
    expect(r.warnings).toBeUndefined();
  });

  it("loader warnings from aliasMapOf appear on result.warnings", async () => {
    const s = freshSession();
    const corpus = "alias-warnings";
    remember(s, { subject: "user:brett", key: "preferred_editor", value: "emacs", corpus });
    // Create a cycle: a → b, b → a
    rememberAlias(s, "a", "b", corpus);
    rememberAlias(s, "b", "a", corpus);

    const r = await recall(s, { about: "editor", corpus }, jaccardDeps);
    // Cycle warning from aliasMapOf should surface on the result
    expect(r.warnings).toBeDefined();
    expect(r.warnings!.some((w) => w.includes("cycle"))).toBe(true);
  });

  it("variant-cardinality warning emitted when alias key has cardinality override", async () => {
    const s = freshSession();
    const corpus = "alias-cardinality-warn";
    remember(s, { subject: "user:brett", key: "editor", value: "vim", corpus });
    remember(s, { subject: "user:brett", key: "preferred_editor", value: "emacs", corpus });
    rememberAlias(s, "editor", "preferred_editor", corpus);

    // keyCardinality has "editor" marked as multi — but there's an alias for it
    const deps = { ...jaccardDeps, keyCardinality: { editor: "multi" as const } };
    const r = await recall(s, { about: "editor", corpus }, deps);
    // Should emit a warning about the variant key having a cardinality declaration
    expect(r.warnings).toBeDefined();
    expect(r.warnings!.some((w) => /cardinality|variant/.test(w))).toBe(true);
  });

  it("alias fetch failure degrades gracefully with a warning (recall succeeds)", async () => {
    const s = freshSession();
    const corpus = "alias-fetch-fail";
    remember(s, { subject: "user:brett", key: "editor", value: "vim", corpus });

    // Simulate a read failure by spying on session.mneme.read and throwing for alias key
    const readSpy = vi.spyOn(s.mneme, "read").mockImplementation((cid, opts) => {
      if ((opts as { key?: string }).key === "alias-of") {
        throw new Error("simulated alias read failure");
      }
      // Non-alias reads return empty — the test only cares that recall succeeds with a warning, not that claims are returned.
      return [];
    });

    const r = await recall(s, { about: "editor", key: "editor", corpus }, jaccardDeps);
    readSpy.mockRestore();

    // Recall should succeed (not throw), but with a degraded result
    expect(r).toBeDefined();
    expect(r.abstained).toBe(false);
    // A warning should be present indicating alias load failed
    expect(r.warnings).toBeDefined();
    expect(r.warnings!.some((w) => /alias/.test(w))).toBe(true);
  });

  it("warm-up covers family-expanded claims (hybrid: variant-key claim is cosine-scored)", async () => {
    const s = freshSession();
    const corpus = "alias-warmup-hybrid";
    // editor (variant, old)
    remember(s, {
      subject: "user:brett",
      key: "editor",
      value: "vim",
      corpus,
      validFrom: "2026-01-01T00:00:00Z",
    });
    // preferred_editor (canonical, new)
    remember(s, {
      subject: "user:brett",
      key: "preferred_editor",
      value: "emacs",
      corpus,
      validFrom: "2026-03-01T00:00:00Z",
    });
    rememberAlias(s, "editor", "preferred_editor", corpus);

    const deps = await makeFakeHybridDeps();
    const embedSpy = vi.spyOn(deps.embeddings.adapter!, "embed");

    // Spy on mneme.read to capture which key arguments the warm-up uses.
    // Each family member must be read with an explicit key — no unfiltered read.
    const readSpy = vi.spyOn(s.mneme, "read");

    // Scoring may throw due to stale-closure; we still check warm-up coverage
    try {
      await recall(s, { about: "editor", key: "editor", corpus }, deps);
    } catch (_) {
      // expected in stale-closure test environment
    }

    // 1. BOTH claim values must be embedded (not just one).
    const allEmbedded = embedSpy.mock.calls.flatMap((call) => call[0] as string[]);
    expect(allEmbedded).toContain("vim");
    expect(allEmbedded).toContain("emacs");

    // 2. Every warm-up read must carry an explicit key filter (no unfiltered read).
    //    Alias reads use key === "alias-of"; exclude those. The remaining reads are
    //    warm-up reads. Each must carry an explicit key value, and together they must
    //    cover every family member ("editor" and "preferred_editor").
    const warmupReadOpts = readSpy.mock.calls
      .map(([, opts]) => opts as { key?: string; corpusId: string })
      .filter((opts) => opts.key !== "alias-of");
    const warmupReadKeys = warmupReadOpts.map((opts) => opts.key);
    // Every warm-up read must have an explicit key (not undefined — no unfiltered read).
    expect(warmupReadKeys.every((k) => k !== undefined)).toBe(true);
    // There must be one read per family member — "editor" and "preferred_editor".
    expect(warmupReadKeys).toContain("editor");
    expect(warmupReadKeys).toContain("preferred_editor");
  });
});

// ── keyCensus ─────────────────────────────────────────────────────────────────

describe("keyCensus", () => {
  afterEach(() => {
    _resetEmbeddingsForTest();
  });

  /**
   * Helper: write an alias claim to a corpus.
   */
  function rememberAlias(
    s: ReturnType<typeof freshSession>,
    variant: string,
    canonical: string,
    corpus: string,
  ) {
    remember(s, {
      subject: `key:${variant}`,
      key: "alias-of",
      value: canonical,
      corpus,
    });
  }

  it("census scores key pairs with jaccard fallback and reports rankFn", async () => {
    const s = freshSession();
    const corpus = "c";
    // Two similar keys: "editor" and "preferred_editor"
    remember(s, { subject: "user:brett", key: "editor", value: "vim", corpus });
    remember(s, { subject: "user:brett", key: "preferred_editor", value: "emacs", corpus });
    const r = await keyCensus(s, { corpus, limit: 5 }, jaccardDeps);
    expect(r.rankFn).toBe("jaccard");
    expect(r.candidates[0]).toMatchObject({ a: "editor", b: "preferred_editor" });
    expect(r.candidates.length).toBeLessThanOrEqual(5);
  });

  it("unknown corpus returns empty report and does NOT create it", async () => {
    const s = freshSession();
    const r = await keyCensus(s, { corpus: "never-seen" }, jaccardDeps);
    expect(r.keys).toEqual([]);
    expect(r.candidates).toEqual([]);
    expect(r.aliases).toEqual({});
    expect(r.unratified).toEqual([]);
    // Must not have created the corpus
    expect(listCorpora(s).corpora.map((c) => c.id)).not.toContain("never-seen");
  });

  it("reports distinct keys with claim counts", async () => {
    const s = freshSession();
    const corpus = "census-counts";
    remember(s, { subject: "user:brett", key: "lang", value: "TypeScript", corpus });
    remember(s, { subject: "user:alice", key: "lang", value: "Rust", corpus });
    remember(s, { subject: "user:brett", key: "editor", value: "helix", corpus });
    const r = await keyCensus(s, { corpus }, jaccardDeps);
    const langEntry = r.keys.find((k) => k.key === "lang");
    const editorEntry = r.keys.find((k) => k.key === "editor");
    expect(langEntry).toBeDefined();
    expect(langEntry!.claims).toBeGreaterThanOrEqual(1);
    expect(editorEntry).toBeDefined();
    expect(editorEntry!.claims).toBe(1);
  });

  it("excludes alias-shaped claims and CONTRADICTION_FLAG_KEY from keys and candidates", async () => {
    const s = freshSession();
    const corpus = "census-exclude";
    remember(s, { subject: "user:brett", key: "editor", value: "vim", corpus });
    // Write an alias claim (isKeyAliasShaped) — should be excluded
    rememberAlias(s, "editor", "preferred_editor", corpus);
    const r = await keyCensus(s, { corpus }, jaccardDeps);
    // "alias-of" key should NOT appear in keys list
    expect(r.keys.map((k) => k.key)).not.toContain("alias-of");
    // CONTRADICTION_FLAG_KEY should not appear
    expect(r.keys.map((k) => k.key)).not.toContain("contradiction.flag");
  });

  it("deprecated claims excluded from census population", async () => {
    const s = freshSession();
    const corpus = "census-deprecated";
    // Write two claims for same subject/key — the older one should be deprecated by supersession
    remember(s, { subject: "user:brett", key: "editor", value: "vim", corpus, validFrom: "2026-01-01T00:00:00Z" });
    remember(s, { subject: "user:brett", key: "editor", value: "helix", corpus, validFrom: "2026-03-01T00:00:00Z" });
    const r = await keyCensus(s, { corpus }, jaccardDeps);
    // After supersession, only 1 non-deprecated claim for "editor"
    const editorEntry = r.keys.find((k) => k.key === "editor");
    expect(editorEntry).toBeDefined();
    // census counts non-deprecated valid claims
    expect(editorEntry!.claims).toBe(1);
  });

  it("candidates sorted descending by score, truncated to limit", async () => {
    const s = freshSession();
    const corpus = "census-sort";
    remember(s, { subject: "s1", key: "alpha", value: "v", corpus });
    remember(s, { subject: "s2", key: "beta", value: "v", corpus });
    remember(s, { subject: "s3", key: "gamma", value: "v", corpus });
    const r = await keyCensus(s, { corpus, limit: 2 }, jaccardDeps);
    expect(r.candidates.length).toBeLessThanOrEqual(2);
    // Candidates should be sorted descending by score
    for (let i = 0; i < r.candidates.length - 1; i++) {
      expect(r.candidates[i].score).toBeGreaterThanOrEqual(r.candidates[i + 1].score);
    }
  });

  it("reports resolved aliases, unratified self-aliases, and warnings", async () => {
    const s = freshSession();
    const corpus = "census-aliases";
    remember(s, { subject: "user:brett", key: "editor", value: "vim", corpus });
    remember(s, { subject: "user:brett", key: "preferred_editor", value: "emacs", corpus });
    // A valid alias
    rememberAlias(s, "editor", "preferred_editor", corpus);
    // A self-alias (un-ratified)
    rememberAlias(s, "theme", "theme", corpus);
    const r = await keyCensus(s, { corpus }, jaccardDeps);
    expect(r.aliases).toMatchObject({ editor: "preferred_editor" });
    expect(r.unratified).toContain("theme");
  });

  it("alias cycle warning appears in census warnings", async () => {
    const s = freshSession();
    const corpus = "census-cycle-warn";
    remember(s, { subject: "user:brett", key: "a", value: "v1", corpus });
    remember(s, { subject: "user:brett", key: "b", value: "v2", corpus });
    // Cycle: a → b, b → a
    rememberAlias(s, "a", "b", corpus);
    rememberAlias(s, "b", "a", corpus);
    const r = await keyCensus(s, { corpus }, jaccardDeps);
    expect(r.warnings.some((w) => w.includes("cycle"))).toBe(true);
  });

  it("variant-cardinality warning appears in census warnings", async () => {
    const s = freshSession();
    const corpus = "census-cardinality-warn";
    remember(s, { subject: "user:brett", key: "editor", value: "vim", corpus });
    remember(s, { subject: "user:brett", key: "preferred_editor", value: "emacs", corpus });
    rememberAlias(s, "editor", "preferred_editor", corpus);
    const deps = { ...jaccardDeps, keyCardinality: { editor: "multi" as const } };
    const r = await keyCensus(s, { corpus }, deps);
    expect(r.warnings.some((w) => /cardinality|variant/.test(w))).toBe(true);
  });

  it("content includes remember ratification shape", async () => {
    const s = freshSession();
    const corpus = "census-content";
    remember(s, { subject: "user:brett", key: "editor", value: "vim", corpus });
    remember(s, { subject: "user:brett", key: "preferred_editor", value: "emacs", corpus });
    const r = await keyCensus(s, { corpus }, jaccardDeps);
    // Content should include a remember-shape hint for ratification
    expect(r.content).toContain("remember");
  });

  it("census performs zero writes (no recall-log and no claim creation)", async () => {
    const s = freshSession();
    const corpus = "census-readonly";
    remember(s, { subject: "user:brett", key: "editor", value: "vim", corpus });
    const countBefore = s.mneme.read(corpus, { corpusId: corpus }).length;
    await keyCensus(s, { corpus }, jaccardDeps);
    const countAfter = s.mneme.read(corpus, { corpusId: corpus }).length;
    expect(countAfter).toBe(countBefore);
  });

  it("default limit is 20 (at most 20 candidate pairs)", async () => {
    const s = freshSession();
    const corpus = "census-default-limit";
    // Create 7 distinct keys → 21 pairs
    const keys = ["a", "b", "c", "d", "e", "f", "g"];
    for (const k of keys) {
      remember(s, { subject: "s", key: k, value: "v", corpus });
    }
    const r = await keyCensus(s, { corpus }, jaccardDeps);
    expect(r.candidates.length).toBeLessThanOrEqual(20);
  });

  it("hybrid deps: key strings passed to embed during warm-up", async () => {
    const s = freshSession();
    const corpus = "census-hybrid-warmup";
    remember(s, { subject: "s", key: "editor", value: "vim", corpus });
    remember(s, { subject: "s", key: "preferred_editor", value: "emacs", corpus });

    const deps = await makeFakeHybridDeps();
    const embedSpy = vi.spyOn(deps.embeddings.adapter!, "embed");

    // Scoring may throw due to stale-closure; warm-up spy is populated before scoring.
    try { await keyCensus(s, { corpus }, deps); } catch (_) { /* expected */ }

    // embed() should have been called with the key strings (not values)
    const allEmbedded = embedSpy.mock.calls.flatMap((call) => call[0] as string[]);
    expect(allEmbedded).toContain("editor");
    expect(allEmbedded).toContain("preferred_editor");
  });

  it("warm-up throws: census still returns with fallback warning, jaccard rankFn, and scored candidates", async () => {
    const s = freshSession();
    const corpus = "census-warmup-throws";
    remember(s, { subject: "s", key: "editor", value: "vim", corpus });
    remember(s, { subject: "s", key: "preferred_editor", value: "emacs", corpus });

    const deps = await makeFakeHybridDeps();
    // Force warmValues to throw a dim-mismatch-style error
    vi.spyOn(deps.embeddings.adapter!, "embed").mockRejectedValue(new Error("dim mismatch"));

    const r = await keyCensus(s, { corpus }, deps);

    // Must not throw — should degrade gracefully
    expect(r.warnings.some((w) => w.includes("warm-up failed"))).toBe(true);
    expect(r.rankFn).toBe("jaccard");
    // Should still have scored candidates using jaccard fallback
    expect(r.candidates.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// evidencePoolingRule at the MCP surface (sweep-discovered crash)
// ---------------------------------------------------------------------------

describe("recall/census - scalar pooling under aliases", () => {
  it("recall does not crash when a ratified alias co-locates same-VALUE scalar claims in a contested cluster", async () => {
    const s = freshSession();
    const corpus = "pooling-crash";
    // Same value under DRIFTED keys (dedupe is alias-blind; these reach contest un-merged)
    remember(s, { subject: "user:a", key: "service-date", value: "March 15", corpus, confidence: 0.8, validFrom: "2026-01-01T00:00:00Z" });
    remember(s, { subject: "user:a", key: "car-service-date", value: "March 15", corpus, confidence: 0.9, validFrom: "2026-01-02T00:00:00Z" });
    // Rival value under the canonical key -> contested cluster -> pooling fires
    remember(s, { subject: "user:a", key: "service-date", value: "March 16", corpus, confidence: 0.7, validFrom: "2026-01-03T00:00:00Z" });
    // Ratify the alias
    remember(s, { subject: "key:car-service-date", key: "alias-of", value: "service-date", corpus });

    const r = await recall(s, { about: "service date", corpus }, jaccardDeps);
    expect(r.abstained).toBe(false);
    expect(r.matches.length).toBeGreaterThan(0);
    s.close();
  });

  it("key_census does not crash on the same corpus shape", async () => {
    const s = freshSession();
    const corpus = "pooling-crash-census";
    remember(s, { subject: "user:a", key: "service-date", value: "March 15", corpus, confidence: 0.8, validFrom: "2026-01-01T00:00:00Z" });
    remember(s, { subject: "user:a", key: "car-service-date", value: "March 15", corpus, confidence: 0.9, validFrom: "2026-01-02T00:00:00Z" });
    remember(s, { subject: "user:a", key: "service-date", value: "March 16", corpus, confidence: 0.7, validFrom: "2026-01-03T00:00:00Z" });
    remember(s, { subject: "key:car-service-date", key: "alias-of", value: "service-date", corpus });

    const r = await keyCensus(s, { corpus }, jaccardDeps);
    expect(r.keys.length).toBeGreaterThan(0);
    s.close();
  });
});

describe("recall — coverage annotation + provenance handles", () => {
  it("reports missing entities with the auditable warning wording", async () => {
    const s = freshSession();
    remember(s, { subject: "user", key: "accommodation", value: "Airbnb", corpus: "cov" });
    const r = await recall(s, { about: "When did I book the Airbnb in Sacramento?", corpus: "cov" }, jaccardDeps);
    expect(r.coverage.missing).toEqual(["Sacramento"]);
    expect(r.coverage.entities).toEqual([
      { text: "Airbnb", supported: true },
      { text: "Sacramento", supported: false },
    ]);
    expect(r.warnings?.some((w) => w.includes("no claim available to this recall") && w.includes("'Sacramento'"))).toBe(true);
    s.close();
  });

  it("fully covered question: coverage present, no coverage warning", async () => {
    const s = freshSession();
    remember(s, { subject: "user", key: "city", value: "Sacramento trip", corpus: "cov2" });
    const r = await recall(s, { about: "What about Sacramento?", corpus: "cov2" }, jaccardDeps);
    expect(r.coverage.missing).toEqual([]);
    expect(r.warnings?.some((w) => w.includes("no claim available"))).toBeFalsy();
    s.close();
  });

  it("basis is PRE-knob: a floor-dropped claim still counts as available", async () => {
    const s = freshSession();
    remember(s, { subject: "user", key: "note", value: "Sacramento mention", corpus: "cov3" });
    // relevanceFloor 0.99 drops everything from matches, but the claim was AVAILABLE
    const r = await recall(s, { about: "Sacramento?", corpus: "cov3", relevanceFloor: 0.99 }, jaccardDeps);
    expect(r.matches).toEqual([]);
    expect(r.coverage.missing).toEqual([]); // Sacramento was available pre-knob
    s.close();
  });

  it("empty corpus: every entity missing and the warning fires", async () => {
    const s = freshSession();
    ensureCorpus(s, "cov-empty");
    const r = await recall(s, { about: "Anything about Sacramento?", corpus: "cov-empty" }, jaccardDeps);
    expect(r.coverage.missing).toEqual(["Anything", "Sacramento"]);
    expect(r.warnings?.some((w) => w.includes("no claim available to this recall"))).toBe(true);
    s.close();
  });

  it("UNKNOWN corpus early-return still carries all-missing coverage + warning (audit M1)", async () => {
    const s = freshSession();
    const r = await recall(s, { about: "Anything about Sacramento?", corpus: "never-created" }, jaccardDeps);
    expect(r.matches).toEqual([]);
    expect(r.coverage.missing).toEqual(["Anything", "Sacramento"]);
    expect(r.warnings?.some((w) => w.includes("no claim available to this recall"))).toBe(true);
    s.close();
  });

  it("matches carry id and tags from the underlying claim", async () => {
    const s = freshSession();
    remember(s, { subject: "user", key: "editor", value: "vim", corpus: "prov", tags: ["session:s1"] });
    const r = await recall(s, { about: "editor", corpus: "prov" }, jaccardDeps);
    expect(r.matches[0].id).toEqual(expect.any(String));
    expect(r.matches[0].id.length).toBeGreaterThan(0);
    expect(r.matches[0].tags).toContain("session:s1");
    s.close();
  });
});

describe("recall recency", () => {
  const DAY = 86_400_000;
  const iso = (ms: number) => new Date(ms).toISOString();

  it("recencyAlpha=1 reproduces pure-similarity ordering (no recency leak)", async () => {
    const s = freshSession();
    const corpus = "rec-alpha1";
    ensureCorpus(s, corpus);
    // Older claim is the exact match; newer claim is irrelevant.
    remember(s, { subject: "x", key: "fact", value: "the quick brown fox", corpus, validFrom: iso(Date.now() - 100 * DAY) });
    remember(s, { subject: "x", key: "note", value: "totally unrelated", corpus });
    const r = await recall(s, { about: "the quick brown fox", corpus, recencyAlpha: 1 }, jaccardDeps);
    expect(r.matches[0].value).toBe("the quick brown fox");
  });

  it("default recency (alpha=0.5) still returns the exact match on top at moderate ages", async () => {
    const s = freshSession();
    const corpus = "rec-default";
    ensureCorpus(s, corpus);
    remember(s, { subject: "x", key: "fact", value: "the quick brown fox", corpus });
    remember(s, { subject: "x", key: "note", value: "unrelated noise", corpus });
    const r = await recall(s, { about: "the quick brown fox", corpus }, jaccardDeps);
    expect(r.matches[0].value).toBe("the quick brown fox");
  });

  it("asOf anchors both tauValid and recency: a claim valid only in the past is surfaced as-of then", async () => {
    const s = freshSession();
    const corpus = "rec-asof";
    ensureCorpus(s, corpus);
    const past = Date.now() - 365 * DAY;
    remember(s, { subject: "role", key: "title", value: "engineer", corpus, validFrom: iso(past) });
    remember(s, { subject: "role", key: "title", value: "manager", corpus }); // validFrom defaults to now
    const r = await recall(
      s,
      { about: "what is the title", corpus, recencyAlpha: 0, asOf: iso(past + DAY) },
      jaccardDeps,
    );
    // As-of (past+1d): the "manager" claim (valid from now) is excluded by tauValid
    // (its valid.from > asOf); only "engineer" is valid at the as-of instant.
    expect(r.matches.map((m) => m.value)).toContain("engineer");
    expect(r.matches.map((m) => m.value)).not.toContain("manager");
  });

  it("rejects an unparseable asOf string", async () => {
    const s = freshSession();
    const corpus = "rec-badasof";
    ensureCorpus(s, corpus);
    remember(s, { subject: "x", key: "fact", value: "v", corpus });
    await expect(
      recall(s, { about: "v", corpus, asOf: "not-a-date" }, jaccardDeps),
    ).rejects.toThrow(/asOf/);
  });
});
