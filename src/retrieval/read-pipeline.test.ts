/**
 * Tests for the read-pipeline composition layer.
 *
 * These tests use a direct stage-application helper (applyStages) rather than
 * the full mneme.query / evaluate stack, so they exercise the Stage composition
 * without needing an adapter or catalog.
 */
import { describe, it, expect } from "vitest";
import { canonicalReadStages, rankedTailStages } from "./read-pipeline.js";
import { corpusOf, filterCorpus, type Corpus, type RankedCorpus } from "../algebra/types.js";
import { pairsOf } from "../algebra/contradiction.js";
import { oplusDedupe } from "../algebra/combination.js";
import { resolveDeprecateOlder, CONTRADICTION_FLAG_KEY } from "../algebra/resolution.js";
import { rho as rhoOp } from "../algebra/similarity.js";
import { KEY_ALIAS_KEY, KEY_SUBJECT_PREFIX, isKeyAliasShaped } from "./key-alias.js";
import type { EvalContext } from "../algebra/expression.js";

// ── Time constants ────────────────────────────────────────────────────────────

const T0 = 1_700_000_000_000; // base epoch ms
const DAY = 86_400_000;
const T10 = T0 + 10 * DAY;
const T20 = T0 + 20 * DAY;
const T30 = T0 + 30 * DAY;
const T_FUTURE = T0 + 9999 * DAY;

// ── Minimal claim factory ─────────────────────────────────────────────────────

const mk = (
  id: string,
  subject: string,
  key: string,
  value: unknown,
  fromTs: number,
  toTs: number = Infinity,
  valueHash?: string,
  status: string = "candidate",
) =>
  ({
    id,
    profile: "p",
    workspace: "w",
    subject,
    key,
    scope: {},
    scopeHash: "_",
    value,
    valueHash: valueHash ?? `vh-${id}`,
    confidence: {
      distribution: "beta",
      parameters: { alpha: 5, beta: 5 },
      raw: 0.5,
    },
    valid: { from: fromTs, to: toTs },
    recorded: T0,
    recordedSeq: 0,
    status,
    source: "manual",
    provenance: {},
    evidence: [],
    tags: [],
    schema: "v1",
    audience: {},
  } as any);

// ── Stage runner ──────────────────────────────────────────────────────────────

/**
 * Applies a stage array to an initial input without a full EvalContext.
 * Since all canonicalReadStages + rankedTailStages are pure (don't use ctx),
 * we thread a minimal ctx stub.
 */
const stubCtx: EvalContext = {
  adapter: null as any,
  catalog: null as any,
};

function applyStages<O>(stages: Array<(input: any, ctx: EvalContext) => any>, input: any): O {
  return stages.reduce<any>((acc, stage) => stage(acc, stubCtx), input) as O;
}

/** Helper: extract values for a given key from a Corpus. */
function values(c: Corpus, key: string): unknown[] {
  return c.claims.filter((cl) => cl.key === key).map((cl) => cl.value);
}

// ── canonicalReadStages ───────────────────────────────────────────────────────

describe("canonicalReadStages", () => {
  it("resolves supersession and keeps multi-declared keys", () => {
    // phone has two claims: older one (T10) and newer one (T20) — older should be deprecated + dropped
    // hobby is "multi" — both paint and run should survive
    const phoneOld = mk("phone-old", "me", "phone", "Galaxy", T10);
    const phoneNew = mk("phone-new", "me", "phone", "Pixel", T20);
    const hobbyA = mk("hobby-a", "me", "hobby", "paint", T10, Infinity, "vh-paint");
    const hobbyB = mk("hobby-b", "me", "hobby", "run", T20, Infinity, "vh-run");

    const corpus = corpusOf([phoneOld, phoneNew, hobbyA, hobbyB]);

    const out = applyStages<Corpus>(
      canonicalReadStages({
        evaluationInstant: T30,
        keyCardinality: { hobby: "multi" },
      }),
      corpus,
    );

    // Older phone claim must be gone (deprecated + dropped)
    expect(values(out, "phone")).toEqual(["Pixel"]);
    // Both hobbies survive because "multi" is excluded from contradiction detection
    expect(values(out, "hobby").sort()).toEqual(["paint", "run"]);
  });

  it("excludes claims with valid.from in the future", () => {
    const pastClaim = mk("past", "me", "name", "Alice", T10);
    const futureClaim = mk("future", "me", "name", "Bob", T_FUTURE);
    const corpus = corpusOf([pastClaim, futureClaim]);

    const out = applyStages<Corpus>(
      canonicalReadStages({ evaluationInstant: T30 }),
      corpus,
    );

    expect(values(out, "name")).toEqual(["Alice"]);
  });

  it("drops CONTRADICTION_FLAG_KEY artifacts after resolution", () => {
    // Two claims with same key, same valid.from → tie → flag artifact gets appended → should be dropped
    const a = mk("cl-a", "me", "color", "red", T10, Infinity, "vh-red");
    const b = mk("cl-b", "me", "color", "blue", T10, Infinity, "vh-blue");
    const corpus = corpusOf([a, b]);

    const out = applyStages<Corpus>(
      canonicalReadStages({ evaluationInstant: T30 }),
      corpus,
    );

    expect(out.claims.every((cl) => cl.key !== CONTRADICTION_FLAG_KEY)).toBe(true);
    // Tie (same valid.from) → neither claim is deprecated; both originals survive
    expect(out.claims.filter((cl) => cl.key === "color")).toHaveLength(2);
  });

  it("drops deprecated claims from the output", () => {
    const older = mk("old-phone", "me", "phone", "Galaxy", T10);
    const newer = mk("new-phone", "me", "phone", "Pixel", T20);
    const corpus = corpusOf([older, newer]);

    const out = applyStages<Corpus>(
      canonicalReadStages({ evaluationInstant: T30 }),
      corpus,
    );

    // No deprecated claims in output
    expect(out.claims.every((cl) => cl.status !== "deprecated")).toBe(true);
  });

  it("uses default conflictThreshold 0 (all claims eligible for contradiction detection)", () => {
    // Even a low-confidence claim should participate in detection when threshold=0 (default)
    const lowConf = {
      ...mk("low", "me", "x", "a", T10, Infinity, "vh-a"),
      confidence: { distribution: "beta", parameters: { alpha: 1, beta: 99 }, raw: 0.01 },
    };
    const high = mk("high", "me", "x", "b", T20, Infinity, "vh-b");
    const corpus = corpusOf([lowConf, high]);

    const out = applyStages<Corpus>(
      canonicalReadStages({ evaluationInstant: T30 }),
      corpus,
    );

    // low-conf claim was older (T10 < T20) so it should be deprecated + dropped
    expect(values(out, "x")).toEqual(["b"]);
  });

  it("merges token-overlap restatements via dedupe stage with default jaccard@0.5", () => {
    // Two claims with same subject/key/scope but very similar values (high jaccard overlap)
    // should be merged into one claim by the oplusDedupe stage.
    const base = mk("ded-a", "me", "note", "the quick brown fox", T10);
    const dupe = mk("ded-b", "me", "note", "quick brown fox jumps", T10);
    // Ensure same scopeHash so they're grouped
    base.scopeHash = "same";
    dupe.scopeHash = "same";
    const corpus = corpusOf([base, dupe]);

    const out = applyStages<Corpus>(
      canonicalReadStages({ evaluationInstant: T30 }),
      corpus,
    );

    // Two similar claims merged into one
    expect(values(out, "note")).toHaveLength(1);
  });

  it("uses conflictThreshold from opts", () => {
    // With threshold=0.8, claims with confidence ~0.33 are NOT eligible (eff <= threshold)
    // so the two claims with different values won't form a contradiction pair
    const a = {
      ...mk("thr-a", "me", "q", "a", T10, Infinity, "vh-a"),
      confidence: { distribution: "beta", parameters: { alpha: 5, beta: 10 }, raw: 5 / 15 }, // ~0.33
    };
    const b = {
      ...mk("thr-b", "me", "q", "b", T20, Infinity, "vh-b"),
      confidence: { distribution: "beta", parameters: { alpha: 5, beta: 10 }, raw: 5 / 15 }, // ~0.33
    };
    const corpus = corpusOf([a, b]);

    const out = applyStages<Corpus>(
      canonicalReadStages({ evaluationInstant: T30, conflictThreshold: 0.8 }),
      corpus,
    );

    // With threshold=0.8, neither claim has eff > 0.8, so neither enters detection
    // Both survive (no contradiction was found)
    expect(values(out, "q")).toHaveLength(2);
  });
});

// ── canonicalReadStages — keyAliases ─────────────────────────────────────────

/** Factory for a well-formed alias-of claim: key:variant → canonical */
const mkAlias = (variant: string, canonical: string, fromTs: number = T10) =>
  mk(
    `alias-${variant}->${canonical}`,
    `${KEY_SUBJECT_PREFIX}${variant}`,
    KEY_ALIAS_KEY,
    canonical,
    fromTs,
  );

describe("canonicalReadStages — keyAliases", () => {
  it("serving filter drops alias-shaped claims regardless of keyAliases opt", () => {
    // Alias claims should NEVER appear in pipeline output, even without a keyAliases map
    const regularClaim = mk("reg", "me", "editor", "vscode", T10);
    const aliasClaim = mkAlias("preferred_editor", "editor");
    const corpus = corpusOf([regularClaim, aliasClaim]);

    const out = applyStages<Corpus>(
      canonicalReadStages({ evaluationInstant: T30 }),
      corpus,
    );

    // Alias claim must be dropped even without keyAliases opt
    expect(out.claims.every((cl) => cl.key !== KEY_ALIAS_KEY)).toBe(true);
    // Regular claim survives
    expect(out.claims.map((cl) => cl.key)).toContain("editor");
  });

  it("serving filter drops alias-shaped claims when keyAliases is provided", () => {
    const regularClaim = mk("reg", "me", "editor", "vscode", T10);
    const aliasClaim = mkAlias("preferred_editor", "editor");
    const corpus = corpusOf([regularClaim, aliasClaim]);

    const out = applyStages<Corpus>(
      canonicalReadStages({
        evaluationInstant: T30,
        keyAliases: { preferred_editor: "editor" },
      }),
      corpus,
    );

    // Alias claim must be dropped
    expect(out.claims.every((cl) => cl.key !== KEY_ALIAS_KEY)).toBe(true);
    // Regular claim survives
    expect(out.claims.map((cl) => cl.key)).toContain("editor");
  });

  it("with keyAliases, aliased stale claim is deprecated and only newer survives", () => {
    // older claim under canonical key, newer under variant key — keyAliases groups them
    const oldEditorClaim = mk("editor-old", "me", "editor", "atom", T10);
    const newPreferredEditorClaim = mk("preferred-editor-new", "me", "preferred_editor", "vscode", T20);
    const aliasClaim = mkAlias("preferred_editor", "editor");
    const corpus = corpusOf([oldEditorClaim, newPreferredEditorClaim, aliasClaim]);

    const out = applyStages<Corpus>(
      canonicalReadStages({
        evaluationInstant: T30,
        keyAliases: { preferred_editor: "editor" },
      }),
      corpus,
    );

    // alias claim filtered out
    expect(out.claims.every((cl) => cl.key !== KEY_ALIAS_KEY)).toBe(true);
    // newer claim under variant key wins; older claim under canonical key deprecated + dropped
    expect(out.claims.map((cl) => cl.key)).toEqual(["preferred_editor"]);
    expect(out.claims[0].value).toBe("vscode");
  });

  it("without keyAliases, output is identical to existing pipeline behavior", () => {
    const phoneOld = mk("phone-old-alias", "me", "phone", "Galaxy", T10);
    const phoneNew = mk("phone-new-alias", "me", "phone", "Pixel", T20);
    const corpus = corpusOf([phoneOld, phoneNew]);

    const withoutAliases = applyStages<Corpus>(
      canonicalReadStages({ evaluationInstant: T30 }),
      corpus,
    );
    const withEmptyAliases = applyStages<Corpus>(
      canonicalReadStages({ evaluationInstant: T30, keyAliases: {} }),
      corpus,
    );

    // Both should produce same result: only newer phone claim survives
    expect(withoutAliases.claims.map((c) => c.id)).toEqual(withEmptyAliases.claims.map((c) => c.id));
    expect(withoutAliases.claims.map((c) => c.value)).toEqual(["Pixel"]);
  });
});

// ── rankedTailStages ──────────────────────────────────────────────────────────

describe("rankedTailStages", () => {
  // Build a small corpus for ranking
  const rankCorpus = corpusOf([
    mk("r1", "me", "info", "the quick brown fox", T10),
    mk("r2", "me", "info", "jaccard similarity measure", T10),
    mk("r3", "me", "info", "hello world", T10),
  ]);

  it("ranks by named fn (jaccard) and returns a RankedCorpus", () => {
    const out = applyStages<RankedCorpus>(
      rankedTailStages({ rankFn: "jaccard", query: "the quick brown fox" }),
      rankCorpus,
    );

    expect(out.scored).toBeDefined();
    expect(out.scored.length).toBeGreaterThan(0);
    // The first result should be the exact match
    expect(out.scored[0].claim.id).toBe("r1");
  });

  it("abstains only when top score is STRICTLY below threshold", () => {
    // With query matching r1 exactly, top score = 1.0 — NOT strictly below 1.0
    const noAbstain = applyStages<RankedCorpus>(
      rankedTailStages({ rankFn: "jaccard", query: "the quick brown fox", abstainBelowTop: 1.0 }),
      rankCorpus,
    );
    // top score equals threshold (1.0), so NOT strictly below — should NOT abstain
    expect(noAbstain.scored.length).toBeGreaterThan(0);

    // With a query that produces a top score strictly below a very high threshold
    const abstained = applyStages<RankedCorpus>(
      rankedTailStages({ rankFn: "jaccard", query: "xyzzy qqq zzz", abstainBelowTop: 0.9 }),
      rankCorpus,
    );
    // top score will be near 0, which is strictly below 0.9 → abstain
    expect(abstained.scored).toHaveLength(0);
  });

  it("applies relevanceFloor AFTER abstain decision", () => {
    // Construct a corpus where one claim matches very well and one poorly
    const corpusForFloor = corpusOf([
      mk("match", "me", "info", "the quick brown fox", T10),
      mk("mismatch", "me", "info", "xyzzy", T10),
    ]);

    // floor=0.5: low-score claim filtered out
    const floored = applyStages<RankedCorpus>(
      rankedTailStages({ rankFn: "jaccard", query: "the quick brown fox", relevanceFloor: 0.5 }),
      corpusForFloor,
    );

    // "match" claim should survive, "mismatch" should be filtered
    expect(floored.scored.length).toBeGreaterThan(0);
    expect(floored.scored.every((s) => s.score >= 0.5)).toBe(true);
  });

  it("defaults: abstainBelowTop=0 and relevanceFloor=0 keep all results", () => {
    const out = applyStages<RankedCorpus>(
      rankedTailStages({ rankFn: "jaccard", query: "any query" }),
      rankCorpus,
    );

    // With defaults off, all 3 claims should appear
    expect(out.scored).toHaveLength(3);
  });

  it("abstain is decided on the raw ranked corpus, before floor filtering", () => {
    // top claim matches well (score=1.0), bottom claim matches poorly (near 0)
    // abstainBelowTop=0.5 → top(1.0) >= 0.5 → no abstain
    // relevanceFloor=0.7 → only top (score=1.0) survives
    const corpusForOrder = corpusOf([
      mk("top", "me", "info", "the quick brown fox", T10),
      mk("bot", "me", "info", "xyzzy world", T10),
    ]);

    const result = applyStages<RankedCorpus>(
      rankedTailStages({
        rankFn: "jaccard",
        query: "the quick brown fox",
        abstainBelowTop: 0.5,
        relevanceFloor: 0.7,
      }),
      corpusForOrder,
    );

    // top score = 1.0 ≥ 0.5 → no abstain; floor=0.7 → only top survives
    expect(result.scored.length).toBe(1);
    expect(result.scored[0].claim.id).toBe("top");
  });
});

// ── Stage-equivalence test ────────────────────────────────────────────────────

describe("stage equivalence: composed vs hand-rolled", () => {
  it("canonicalReadStages + rankedTailStages over seeded corpus equals hand-rolled arm-A construction", () => {
    const T = T30;
    const threshold = 0;
    const cutoff = 0.5;
    const rankFn = "jaccard";
    const query = "what is my phone";
    const keyCardinality: Record<string, "single" | "multi"> = { hobby: "multi" };

    // Corpus to test against
    const phoneOld = mk("phone-old", "me", "phone", "Galaxy", T10);
    const phoneNew = mk("phone-new", "me", "phone", "Pixel", T20);
    const hobbyA = mk("hobby-a", "me", "hobby", "paint", T10, Infinity, "vh-paint");
    const hobbyB = mk("hobby-b", "me", "hobby", "run", T20, Infinity, "vh-run");
    const corpus = corpusOf([phoneOld, phoneNew, hobbyA, hobbyB]);

    // ── Hand-rolled reference (mirrors bench/longmemeval/answer.ts arm A) ──
    // τ_valid
    const afterTau = corpusOf(corpus.claims.filter((cl) => cl.valid.from <= T && T < (cl.valid.to ?? Infinity)));
    // ⊕_dedupe
    const afterDedupe = oplusDedupe("rule_weighted_avg", undefined, { similarity: { fn: "jaccard", cutoff } })(afterTau);
    // ⊥ / resolveDeprecateOlder
    const afterResolve = resolveDeprecateOlder(pairsOf(afterDedupe, threshold, { keyCardinality }))(afterDedupe);
    // drop deprecated + CONTRADICTION_FLAG_KEY
    const afterFilter = filterCorpus(afterResolve, (cl) => cl.status !== "deprecated" && cl.key !== CONTRADICTION_FLAG_KEY && !isKeyAliasShaped(cl));
    // rho rank
    const handRolledResult: RankedCorpus = rhoOp(rankFn, query)(afterFilter);

    // ── Composed pipeline ──
    const stages = [
      ...canonicalReadStages({
        evaluationInstant: T,
        keyCardinality,
        conflictThreshold: threshold,
        dedupe: { fn: "jaccard", cutoff },
      }),
      ...rankedTailStages({ rankFn, query }),
    ];
    const composedResult = applyStages<RankedCorpus>(stages, corpus);

    // Compare claim-for-claim (ids and scores should match)
    const toIds = (r: RankedCorpus) => r.scored.map((s) => s.claim.id);
    expect(toIds(composedResult)).toEqual(toIds(handRolledResult));

    // Values should also match
    const toValues = (r: RankedCorpus) => r.scored.map((s) => s.claim.value);
    expect(toValues(composedResult)).toEqual(toValues(handRolledResult));
  });
});
