import { describe, it, expect, vi, afterEach } from "vitest";
import { openSession } from "./session.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recall,
  recallAsync,
  buildFilterPlan,
  loadAliasContext,
  aliasContextFrom,
  buildRecallRanker,
  buildRecallRankerPure,
  warmRecallValuesOver,
  type RecallSource,
} from "./recall.js";
import { remember, listCorpora, ensureCorpus } from "./remember.js";
import { freshSession, jaccardDeps, makeFakeHybridDeps, makeSpySession } from "./test-support.js";
import { _resetEmbeddingsForTest } from "./embeddings.js";
import { KEY_ALIAS_KEY } from "../retrieval/key-alias.js";
import type { Session } from "./types.js";
import { corpusOf } from "../algebra/types.js";
import type { Corpus } from "../algebra/types.js";
import type { EvalContext } from "../algebra/expression.js";

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

  it("recallCore never calls mneme.query (task-recall-core: replaced by ONE hinted read + pure stages)", async () => {
    const s = freshSession();
    const corpus = "onequery-corpus";
    remember(s, { subject: "s", key: "k", value: "test value", corpus });

    const querySpy = vi.spyOn(s.mneme, "query");
    await recall(s, { about: "test", corpus }, jaccardDeps);
    expect(querySpy).toHaveBeenCalledTimes(0);
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

    // 2. Warm-up collapses to ONE read carrying `keys: family` (amendment A9) —
    //    not one read per family member. Alias reads use key === "alias-of"; exclude those.
    //    task-recall-core: the shared-prefix read ALSO goes over the `source.read` seam
    //    now (was a separate mneme.query/adapter path), carrying the SAME `keys: family`
    //    hint — so TWO reads are expected here (warm-up + shared prefix), both correctly
    //    family-scoped.
    const warmupReadOpts = readSpy.mock.calls
      .map(([, opts]) => opts as { key?: string; keys?: string[]; corpusId: string })
      .filter((opts) => opts.key !== "alias-of");
    expect(warmupReadOpts.length).toBe(2);
    for (const opts of warmupReadOpts) {
      expect(opts.keys).toEqual(expect.arrayContaining(["editor", "preferred_editor"]));
      expect(opts.keys?.length).toBe(2);
    }
  });
});

// keyCensus tests moved to census.test.ts (task-census).

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

describe("recall — cardinality safety warning", () => {
  it("recall warns when a single-cardinality key holds >=2 distinct values, and multi suppresses it", async () => {
    const s = freshSession();
    s.createCorpus({ id: "c", keyCardinality: { plan: "single" } });
    s.write("c", { subject: "proj", key: "plan", value: "alpha", valid: { from: 1, to: Infinity } });
    s.write("c", { subject: "proj", key: "plan", value: "bravo", valid: { from: 2, to: Infinity } });
    const single = await recall(s, { about: "plan", corpus: "c" }, jaccardDeps);
    expect(single.warnings?.some((w) => /single-cardinality.*plan.*distinct values/.test(w))).toBe(true);
    s.close();

    const s2 = freshSession();
    s2.createCorpus({ id: "c", keyCardinality: { plan: "multi" } });
    s2.write("c", { subject: "proj", key: "plan", value: "alpha", valid: { from: 1, to: Infinity } });
    s2.write("c", { subject: "proj", key: "plan", value: "bravo", valid: { from: 2, to: Infinity } });
    const multi = await recall(s2, { about: "plan", corpus: "c" }, jaccardDeps);
    expect(multi.warnings?.some((w) => /single-cardinality/.test(w))).toBeFalsy();
    expect(multi.matches.length).toBe(2); // both coexist
    s2.close();
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

// ── buildFilterPlan / leaf hint pushdown (task-recall-callsites, spec §4 A1) ──

describe("buildFilterPlan — the sealed σ+hint pair", () => {
  it("subject only → hints = { subject }", () => {
    const plan = buildFilterPlan({ about: "x", corpus: "c", subject: "a" });
    expect(plan.hints).toEqual({ subject: "a" });
    expect(plan.sigmas.length).toBe(1);
  });

  it("key only (no family) → hints = { key }", () => {
    const plan = buildFilterPlan({ about: "x", corpus: "c", key: "k" });
    expect(plan.hints).toEqual({ key: "k" });
    expect(plan.sigmas.length).toBe(1);
  });

  it("subject+key → hints = { subject, key }", () => {
    const plan = buildFilterPlan({ about: "x", corpus: "c", subject: "a", key: "k" });
    expect(plan.hints).toEqual({ subject: "a", key: "k" });
    expect(plan.sigmas.length).toBe(2);
  });

  it("subject+family (>1 keys) → hints = { subject, keys: family }", () => {
    const plan = buildFilterPlan({ about: "x", corpus: "c", subject: "a", key: "k" }, ["k", "k2"]);
    expect(plan.hints).toEqual({ subject: "a", keys: ["k", "k2"] });
    expect(plan.sigmas.length).toBe(2);
  });
});

describe("recall — leaf hint pushdown", () => {
  const CORPUS = "hint-pushdown";

  function seedClaims(
    s: Session,
    entries: { subject: string; key: string; value?: string }[],
    corpus = CORPUS,
  ): void {
    for (const e of entries) {
      remember(s, { subject: e.subject, key: e.key, value: e.value ?? `${e.subject}-${e.key}`, corpus });
    }
  }

  it("scoped recall serves identical results while hydrating only matching rows", async () => {
    const { session, plansSeen } = makeSpySession();
    seedClaims(session, [
      { subject: "a", key: "k" },
      { subject: "b", key: "k" },
      { subject: "b", key: "x" },
    ]);
    // Only inspect plans issued BY recall() itself — writes (via remember()'s
    // supersessionOutcome attribution) issue their own unrelated {corpusId}-only reads.
    const before = plansSeen.length;
    const res = await recall(
      session,
      { about: "k", corpus: CORPUS, subject: "a", key: "k" },
      jaccardDeps,
    );
    const recallPlans = plansSeen.slice(before);
    expect(res.matches.map((m) => m.subject)).toEqual(["a"]);
    // Every plan except the alias-key read carries the subject/key scope.
    expect(
      recallPlans
        .filter((p) => p.key !== KEY_ALIAS_KEY)
        .every((p) => p.subject === "a" && p.key === "k"),
    ).toBe(true);
    // No plan is corpusId-only (i.e. the hint was actually threaded to leaf()).
    expect(
      recallPlans
        .filter((p) => p.key !== KEY_ALIAS_KEY)
        .every((p) => p.subject !== undefined || p.key !== undefined || p.keys !== undefined),
    ).toBe(true);
  });

  it("hints-off transformPlan strips scoping — differential arm still serves correct results", async () => {
    const { session } = makeSpySession({ transformPlan: (p) => ({ corpusId: p.corpusId }) });
    seedClaims(session, [
      { subject: "a", key: "k" },
      { subject: "b", key: "k" },
    ]);
    const res = await recall(
      session,
      { about: "k", corpus: CORPUS, subject: "a", key: "k" },
      jaccardDeps,
    );
    // σ re-filters in memory regardless of the (stripped) adapter hint — same result.
    expect(res.matches.map((m) => m.subject)).toEqual(["a"]);
  });

  it("recall issues exactly ONE non-alias adapter query after the shared-prefix restructure (was 2)", async () => {
    const { session, plansSeen } = makeSpySession();
    seedClaims(session, [
      { subject: "s0", key: "k0" },
      { subject: "s1", key: "k0" },
    ]);
    const before = plansSeen.length;
    await recall(session, { about: "q", corpus: CORPUS, subject: "s0", key: "k0" }, jaccardDeps);
    const recallPlans = plansSeen.slice(before).filter((p) => p.key !== KEY_ALIAS_KEY);
    expect(recallPlans).toHaveLength(1);
  });

  it("warmRecallValues + the shared-prefix read both carry keys: family (task-recall-core: prefix now shares the read seam)", async () => {
    const { session } = makeSpySession();
    const corpus = "warm-family-hint";
    remember(session, {
      subject: "user:x", key: "editor", value: "vim", corpus,
      validFrom: "2026-01-01T00:00:00Z",
    });
    remember(session, {
      subject: "user:x", key: "preferred_editor", value: "emacs", corpus,
      validFrom: "2026-03-01T00:00:00Z",
    });
    remember(session, { subject: "key:editor", key: KEY_ALIAS_KEY, value: "preferred_editor", corpus });

    const deps = await makeFakeHybridDeps();
    const readSpy = vi.spyOn(session.mneme, "read");
    try {
      await recall(session, { about: "editor", key: "editor", corpus }, deps);
    } catch (_) {
      // stale-closure scoring may throw (see test-support.ts note); warm-up spy data
      // is captured before scoring regardless.
    }

    // task-recall-core: the shared-prefix read now also goes over `source.read` (mneme.read),
    // carrying the SAME `keys: family` hint as the warm-up read — TWO calls, both family-scoped.
    const warmupReadCalls = readSpy.mock.calls
      .map(([, opts]) => opts as { key?: string; keys?: string[] })
      .filter((opts) => opts.key !== KEY_ALIAS_KEY);
    expect(warmupReadCalls.length).toBe(2);
    for (const opts of warmupReadCalls) {
      expect(opts.keys).toEqual(expect.arrayContaining(["editor", "preferred_editor"]));
      expect(opts.keys?.length).toBe(2);
    }
  });
});

// ── task-pure-helpers: zero-behavior-change extractions behind the read seam ──

describe("aliasContextFrom — the pure post-read part of loadAliasContext", () => {
  it("given the same already-read alias claims, matches loadAliasContext's result exactly", () => {
    const s = freshSession();
    const corpus = "alias-pure-basic";
    remember(s, { subject: "user:brett", key: "preferred_editor", value: "emacs", corpus });
    remember(s, { subject: "key:editor", key: "alias-of", value: "preferred_editor", corpus });
    const now = Date.now();
    const aliasClaims = s.mneme.read(corpus, { corpusId: corpus, key: KEY_ALIAS_KEY });

    const pure = aliasContextFrom(aliasClaims, now, undefined);
    const wrapped = loadAliasContext(s, corpus, now, undefined);

    expect(pure).toEqual(wrapped);
    expect(pure.aliasMap).toEqual({ editor: "preferred_editor" });
    expect(pure.warnings).toEqual([]);
    s.close();
  });

  it("emits the same variant-cardinality warning as loadAliasContext when a variant carries a cardinality override", () => {
    const s = freshSession();
    const corpus = "alias-pure-cardinality";
    remember(s, { subject: "user:brett", key: "editor", value: "vim", corpus });
    remember(s, { subject: "user:brett", key: "preferred_editor", value: "emacs", corpus });
    remember(s, { subject: "key:editor", key: "alias-of", value: "preferred_editor", corpus });
    const now = Date.now();
    const keyCardinality = { editor: "multi" as const };
    const aliasClaims = s.mneme.read(corpus, { corpusId: corpus, key: KEY_ALIAS_KEY });

    const pure = aliasContextFrom(aliasClaims, now, keyCardinality);
    const wrapped = loadAliasContext(s, corpus, now, keyCardinality);

    expect(pure).toEqual(wrapped);
    expect(pure.warnings.some((w) => /cardinality|variant/.test(w))).toBe(true);
    s.close();
  });

  it("loadAliasContext still degrades gracefully on a read failure (aliasContextFrom is never reached)", () => {
    const s = freshSession();
    const corpus = "alias-pure-fail";
    const readSpy = vi.spyOn(s.mneme, "read").mockImplementation(() => {
      throw new Error("simulated failure");
    });
    const result = loadAliasContext(s, corpus, Date.now(), undefined);
    readSpy.mockRestore();
    expect(result.aliasMap).toEqual({});
    expect(result.warnings.some((w) => /alias load failed — proceeding without alias expansion:/.test(w))).toBe(true);
    s.close();
  });
});

describe("buildFilterPlan — sigmas are pure stages (task-pure-helpers B4)", () => {
  it("apply without a ctx argument, and filter identically to before", () => {
    const s = freshSession();
    const corpus = "filterplan-pure";
    remember(s, { subject: "a", key: "k", value: "v1", corpus });
    remember(s, { subject: "b", key: "k", value: "v2", corpus });
    const mixed = s.mneme.read(corpus, { corpusId: corpus });

    const { sigmas } = buildFilterPlan({ about: "q", corpus, subject: "a" });
    const filtered = sigmas.reduce((acc, stage) => (stage as (c: Corpus) => Corpus)(acc), corpusOf(mixed));
    expect(filtered.claims.every((cl) => cl.subject === "a")).toBe(true);
    expect(filtered.claims.length).toBe(1);
    s.close();
  });
});

describe("buildRecallRankerPure — the ONE home for the alpha/half-life dials", () => {
  it("recencyAlpha=1 reduces to pure similarity ranking, callable without ctx", () => {
    const s = freshSession();
    const corpus = "ranker-pure-alpha1";
    remember(s, { subject: "x", key: "fact", value: "the quick brown fox", corpus });
    remember(s, { subject: "x", key: "note", value: "totally unrelated", corpus });
    const claims = s.mneme.read(corpus, { corpusId: corpus });

    const ranker = buildRecallRankerPure(
      { about: "the quick brown fox", corpus, recencyAlpha: 1 },
      "jaccard",
      Date.now(),
    );
    const ranked = ranker(corpusOf(claims));
    expect(ranked.scored[0].claim.value).toBe("the quick brown fox");
    s.close();
  });

  it("default (blended) ranking matches buildRecallRanker's Stage wrapper for the same `now`", () => {
    const s = freshSession();
    const corpus = "ranker-pure-blend";
    remember(s, { subject: "x", key: "fact", value: "hello world", corpus });
    remember(s, { subject: "x", key: "note", value: "unrelated noise", corpus });
    const claims = s.mneme.read(corpus, { corpusId: corpus });
    const now = Date.now();

    const args = { about: "hello world", corpus };
    const pure = buildRecallRankerPure(args, "jaccard", now)(corpusOf(claims));
    const wrapped = buildRecallRanker(args, "jaccard")(
      corpusOf(claims),
      { evaluationClock: now } as unknown as EvalContext,
    );
    expect(pure).toEqual(wrapped);
    s.close();
  });
});

describe("warmRecallValuesOver — sync warmRecallValues delegates over the RecallSource seam", () => {
  afterEach(() => {
    _resetEmbeddingsForTest();
  });

  it("session.mneme satisfies RecallSource; delegation warms values identically", async () => {
    const s = freshSession();
    const corpus = "warm-over-hybrid";
    remember(s, { subject: "s", key: "k", value: "some hybrid value", corpus });
    const deps = await makeFakeHybridDeps();
    const embedSpy = vi.spyOn(deps.embeddings.adapter!, "embed");

    await warmRecallValuesOver(s.mneme, { about: "hybrid value", corpus }, deps.embeddings);

    const embedded = embedSpy.mock.calls.flatMap((call) => call[0] as string[]);
    expect(embedded).toContain("some hybrid value");
    s.close();
  });

  it("jaccard rankFn is a no-op (no adapter/cache required)", async () => {
    const s = freshSession();
    await expect(
      warmRecallValuesOver(s.mneme, { about: "x", corpus: "no-warm" }, { rankFn: "jaccard" }),
    ).resolves.toBeUndefined();
    s.close();
  });
});

// ── recallAsync — the async twin over the RecallSource seam (task-recall-core) ──

describe("recallAsync — the async twin over the RecallSource seam", () => {
  it("recallAsync over an async source serves the same matches as sync recall", async () => {
    const { session } = makeSpySession();
    const corpus = "async-seam-parity";
    remember(session, { subject: "project:mneme", key: "fact", value: "Mneme dogfoods via MCP", corpus });
    remember(session, { subject: "project:mneme", key: "note", value: "unrelated weather chatter", corpus });
    // Pin asOf so both calls anchor the recency term at the SAME instant — recall's
    // default `now` is `Date.now()`, which would otherwise drift by a few ms between
    // the sync and async calls and produce a spuriously non-identical recency-blended score.
    const args = { about: "Mneme dogfoods via MCP", corpus, limit: 5, asOf: Date.now() };

    const sync = await recall(session, args, jaccardDeps);
    const asyncSource: RecallSource = {
      listCorpora: (f) => session.mneme.listCorpora(f),
      read: async (c, p) => session.mneme.read(c, p),
    };
    const viaSeam = await recallAsync(asyncSource, args, jaccardDeps);
    expect(viaSeam).toEqual(sync);
  });

  it("read order: alias read strictly precedes the prefix read (jaccardDeps skips warm-up)", async () => {
    const s = freshSession();
    const corpus = "async-read-order";
    remember(s, { subject: "x", key: "fact", value: "some value about recall order", corpus });

    const labels: string[] = [];
    const labeledSource: RecallSource = {
      listCorpora: (f) => s.mneme.listCorpora(f),
      read: (cid, plan) => {
        labels.push((plan as { key?: string }).key === KEY_ALIAS_KEY ? "alias" : "other");
        return s.mneme.read(cid, plan);
      },
    };

    await recallAsync(labeledSource, { about: "recall order", corpus }, jaccardDeps);

    // jaccardDeps: warm-up early-returns (no read), so exactly TWO reads occur —
    // the alias read strictly before the (shared-prefix) non-alias read.
    expect(labels).toEqual(["alias", "other"]);
  });

  it("recallAsync alias-load failure degrades with the exact sync warning text", async () => {
    const s = freshSession();
    const corpus = "async-alias-fail";
    remember(s, { subject: "user:brett", key: "editor", value: "vim", corpus });

    const failingSource: RecallSource = {
      listCorpora: (f) => s.mneme.listCorpora(f),
      read: async (cid, plan) => {
        if ((plan as { key?: string }).key === KEY_ALIAS_KEY) {
          throw new Error("simulated async alias read failure");
        }
        return s.mneme.read(cid, plan);
      },
    };

    const r = await recallAsync(failingSource, { about: "editor", key: "editor", corpus }, jaccardDeps);
    expect(r.abstained).toBe(false);
    expect(r.warnings).toBeDefined();
    expect(
      r.warnings!.some(
        (w) => w === "alias load failed — proceeding without alias expansion: simulated async alias read failure",
      ),
    ).toBe(true);
  });
});
