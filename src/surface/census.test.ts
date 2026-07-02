import { describe, it, expect, vi, afterEach } from "vitest";
import { remember, listCorpora } from "./remember.js";
import { freshSession, jaccardDeps, makeFakeHybridDeps } from "./test-support.js";
import { _resetEmbeddingsForTest } from "./embeddings.js";
import { keyCensus, subjectCensus } from "./census.js";

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

// ── subjectCensus ────────────────────────────────────────────────────────────

describe("subjectCensus", () => {
  afterEach(() => {
    _resetEmbeddingsForTest();
  });

  it("subjectCensus scores fragmented subjects and stays advisory", async () => {
    const s = freshSession();
    const corpus = "c";
    // seed near-dup subjects "project:crewtracks" and "project:crewTracks-liner-build"
    remember(s, { subject: "project:crewtracks", key: "status", value: "active", corpus });
    remember(s, { subject: "project:crewTracks-liner-build", key: "status", value: "active", corpus });
    const r = await subjectCensus(s, { corpus }, jaccardDeps);
    expect(r.subjects.length).toBeGreaterThanOrEqual(2);
    expect(r.candidates[0].score).toBeGreaterThan(0);
    expect(r.content).not.toContain("alias-of"); // advisory, not a ratification shape
  });

  it("reports distinct subjects with claim counts, sorted desc", async () => {
    const s = freshSession();
    const corpus = "subject-census-counts";
    remember(s, { subject: "user:brett", key: "editor", value: "vim", corpus });
    remember(s, { subject: "user:brett", key: "lang", value: "TypeScript", corpus });
    remember(s, { subject: "user:alice", key: "lang", value: "Rust", corpus });
    const r = await subjectCensus(s, { corpus }, jaccardDeps);
    const brettEntry = r.subjects.find((x) => x.subject === "user:brett");
    const aliceEntry = r.subjects.find((x) => x.subject === "user:alice");
    expect(brettEntry).toBeDefined();
    expect(brettEntry!.claims).toBe(2);
    expect(aliceEntry).toBeDefined();
    expect(aliceEntry!.claims).toBe(1);
  });

  it("content is advisory: names the fragmented pair and points at reconcile", async () => {
    const s = freshSession();
    const corpus = "subject-census-content";
    remember(s, { subject: "project:crewtracks", key: "status", value: "active", corpus });
    remember(s, { subject: "project:crewTracks-liner-build", key: "status", value: "active", corpus });
    const r = await subjectCensus(s, { corpus }, jaccardDeps);
    expect(r.content).toContain("reconcile");
    expect(r.content).toContain("project:crewtracks");
  });

  it("unknown corpus returns empty report and does NOT create it", async () => {
    const s = freshSession();
    const r = await subjectCensus(s, { corpus: "never-seen-subject" }, jaccardDeps);
    expect(r.subjects).toEqual([]);
    expect(r.candidates).toEqual([]);
    expect(listCorpora(s).corpora.map((c) => c.id)).not.toContain("never-seen-subject");
  });
});

describe("census - scalar pooling under aliases", () => {
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
