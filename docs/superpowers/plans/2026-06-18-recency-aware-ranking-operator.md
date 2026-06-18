# Recency-Aware Ranking Operator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the twice-validated bench `rankBlend` prototype into a real, principled `src` operator that blends value-similarity with `valid.from` recency, exposed as an opt-in library dial and a recency-on-by-default MCP `recall` option.

**Architecture:** A pure, clock-free operator `rankBlend` in `src/algebra/ranking.ts` (composed from an existing registered `SimilarityFn` + the existing `decay.multiplier` exponential kernel) → a `rho.blend` Stage builder in `src/mneme.ts` that supplies the evaluation instant from `ctx.evaluationClock` and records provenance versions → an opt-in `recency?` option on `rankedTailStages` → MCP `recall` params (`recencyAlpha`, `recencyHalfLifeDays`, `asOf`) defaulting to α=0.5/90d. The clock enters only at the Stage boundary, exactly as `delta`/`tau.now` do, keeping the operator deterministic.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest (`vitest run`), existing Mneme algebra (`Corpus`/`RankedCorpus`/`Stage`/`EvalContext`).

**Spec:** `docs/superpowers/specs/2026-06-18-recency-aware-ranking-operator-design.md`

## Global Constraints

- ESM imports use `.js` specifiers even for `.ts` files (e.g. `import { multiplier } from "./decay.js"`).
- Test runner: `npx vitest run <path>` (single file) or `npx vitest run <path> -t "<name>"` (single test). Full suite: `npm test`. Typecheck: `npm run typecheck`.
- Vitest globals (`describe`/`it`/`expect`) are available without import in algebra tests; `src/mcp/*` and `src/retrieval/*` tests import them from `vitest`.
- Algebra layer NEVER imports from `retrieval` or `mcp`. `src/algebra/ranking.ts` may import only from `./similarity.js`, `./decay.js`, `./types.js`, and `../core/*`.
- Default blend: **α=0.5, half-life=90 days**. `α=1` MUST be byte-identical to current `rho` behavior (the regression-guard identity).
- Determinism: the operator takes the evaluation instant `t` as a parameter — NO `Date.now()` inside `rankBlend`. The clock is supplied only by the Stage wrapper via `ctx.evaluationClock ?? Date.now()`.
- Recency kernel is exponential-only for v1 (dial = `halfLifeDays`). Do NOT add linear/step kernels.
- `Instant` is `number` (epoch ms), from `../core/time.js`.

---

### Task 1: Pure `rankBlend` operator

**Files:**
- Create: `src/algebra/ranking.ts`
- Test: `src/algebra/ranking.test.ts`

**Interfaces:**
- Consumes: `similarityFn(name)` from `./similarity.js`; `multiplier(policy, ageMs)` from `./decay.js`; `Corpus`/`RankedCorpus` from `./types.js`; `Value` from `../core/value.js`; `Instant` from `../core/time.js`.
- Produces:
  - `export interface BlendOpts { alpha: number; halfLifeDays: number }`
  - `export const rankBlend: (simName: string, query: Value, opts: BlendOpts, t: Instant) => (c: Corpus) => RankedCorpus`

- [ ] **Step 1: Write the failing tests**

Create `src/algebra/ranking.test.ts`:

```ts
import { rankBlend } from "./ranking.js";
import { corpusOf } from "./types.js";

const DAY = 86_400_000;
const T = 1_700_000_000_000; // evaluation instant

// Minimal claim-like objects: rankBlend only reads `value` and `valid.from`.
const mk = (value: string, fromTs: number) =>
  ({ value, valid: { from: fromTs, to: Infinity } } as any);

// ── alpha = 1: pure similarity, identical ordering to a stable jaccard sort ──

it("alpha=1 ranks purely by similarity (recency term zeroed)", () => {
  const corpus = corpusOf([
    mk("the quick brown fox", T - 100 * DAY), // old but exact match
    mk("hello world", T),                     // new but irrelevant
  ]);
  const out = rankBlend("jaccard", "the quick brown fox", { alpha: 1, halfLifeDays: 90 }, T)(corpus);
  expect(out.scored[0].claim.value).toBe("the quick brown fox");
  expect(out.scored[0].score).toBeCloseTo(1); // pure jaccard exact match
});

it("alpha=1 preserves stable input order on an equal-score tie (rho identity)", () => {
  // Two claims with identical value → identical jaccard score → tie.
  const corpus = corpusOf([
    mk("same value", T - 50 * DAY), // newer would win if recency leaked in
    mk("same value", T - 10 * DAY),
  ]);
  const out = rankBlend("jaccard", "same value", { alpha: 1, halfLifeDays: 90 }, T)(corpus);
  // Stable input order: first input stays first despite being older.
  expect(out.scored[0].claim.valid.from).toBe(T - 50 * DAY);
  expect(out.scored[1].claim.valid.from).toBe(T - 10 * DAY);
});

// ── alpha = 0: pure recency ──

it("alpha=0 orders by recency (newest valid.from first)", () => {
  const corpus = corpusOf([
    mk("a", T - 100 * DAY),
    mk("b", T - 10 * DAY),
    mk("c", T - 200 * DAY),
  ]);
  const out = rankBlend("jaccard", "irrelevant", { alpha: 0, halfLifeDays: 90 }, T)(corpus);
  expect(out.scored.map((s) => s.claim.value)).toEqual(["b", "a", "c"]);
});

it("alpha=0: a claim at the evaluation instant gets recency score 1", () => {
  const corpus = corpusOf([mk("x", T)]);
  const out = rankBlend("jaccard", "anything", { alpha: 0, halfLifeDays: 90 }, T)(corpus);
  expect(out.scored[0].score).toBeCloseTo(1);
});

// ── the dial actually trades relevance for recency ──

it("dial swaps a relevant-old and irrelevant-new claim as alpha goes 1 -> 0", () => {
  const corpus = corpusOf([
    mk("the quick brown fox", T - 200 * DAY), // relevant, old
    mk("zzz qqq", T),                         // irrelevant, brand new
  ]);
  const atOne = rankBlend("jaccard", "the quick brown fox", { alpha: 1, halfLifeDays: 90 }, T)(corpus);
  const atZero = rankBlend("jaccard", "the quick brown fox", { alpha: 0, halfLifeDays: 90 }, T)(corpus);
  expect(atOne.scored[0].claim.value).toBe("the quick brown fox"); // relevance wins
  expect(atZero.scored[0].claim.value).toBe("zzz qqq");            // recency wins
});

// ── half-life flattens recency differences ──

it("larger half-life flattens the recency gap between two ages", () => {
  const corpus = corpusOf([mk("p", T - 90 * DAY)]);
  const shortHl = rankBlend("jaccard", "p", { alpha: 0, halfLifeDays: 90 }, T)(corpus);
  const longHl = rankBlend("jaccard", "p", { alpha: 0, halfLifeDays: 3650 }, T)(corpus);
  // At 90d age: hl=90 → recency=0.5; hl=3650 → recency≈0.983. Longer hl ⇒ closer to 1.
  expect(shortHl.scored[0].score).toBeCloseTo(0.5);
  expect(longHl.scored[0].score).toBeGreaterThan(shortHl.scored[0].score);
});

// ── future-dated claim clamps to recency 1 ──

it("a future-dated claim (valid.from > t) clamps to recency 1, no negative age", () => {
  const corpus = corpusOf([mk("future", T + 30 * DAY)]);
  const out = rankBlend("jaccard", "nope", { alpha: 0, halfLifeDays: 90 }, T)(corpus);
  expect(out.scored[0].score).toBeCloseTo(1);
});

// ── validation + edges ──

it("throws when alpha is outside [0,1]", () => {
  const corpus = corpusOf([mk("x", T)]);
  expect(() => rankBlend("jaccard", "q", { alpha: 1.5, halfLifeDays: 90 }, T)(corpus)).toThrow(/alpha/);
  expect(() => rankBlend("jaccard", "q", { alpha: -0.1, halfLifeDays: 90 }, T)(corpus)).toThrow(/alpha/);
});

it("throws when halfLifeDays is not > 0", () => {
  const corpus = corpusOf([mk("x", T)]);
  expect(() => rankBlend("jaccard", "q", { alpha: 0.5, halfLifeDays: 0 }, T)(corpus)).toThrow(/halfLifeDays/);
});

it("throws for an unknown similarity fn name", () => {
  const corpus = corpusOf([mk("x", T)]);
  expect(() => rankBlend("nope-fn", "q", { alpha: 0.5, halfLifeDays: 90 }, T)(corpus)).toThrow(/no similarity fn/);
});

it("returns empty scored for an empty corpus", () => {
  const out = rankBlend("jaccard", "q", { alpha: 0.5, halfLifeDays: 90 }, T)(corpusOf([]));
  expect(out.scored).toHaveLength(0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/algebra/ranking.test.ts`
Expected: FAIL — `Failed to resolve import "./ranking.js"` (module does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `src/algebra/ranking.ts`:

```ts
import type { Corpus, RankedCorpus } from "./types.js";
import type { Value } from "../core/value.js";
import type { Instant } from "../core/time.js";
import { similarityFn } from "./similarity.js";
import { multiplier } from "./decay.js";

export interface BlendOpts {
  /** Relevance↔recency weight in [0,1]. 1 = pure similarity (== rho); 0 = pure recency. */
  alpha: number;
  /** Exponential recency half-life in days (> 0). */
  halfLifeDays: number;
}

/**
 * Metadata-aware ranking: a convex blend of value-similarity and valid.from recency.
 *
 *   score(claim) = α · sim(claim.value, query)
 *                + (1−α) · multiplier({kind:"exponential", halfLifeDays}, max(0, t − claim.valid.from))
 *
 * Both terms ∈ [0,1], so score ∈ [0,1]. Pure / clock-free: `t` is a parameter (the
 * Stage wrapper supplies it from ctx). Sort: score desc, tie-break = STABLE INPUT
 * ORDER, so at α = 1 the recency term is zeroed and ordering reproduces `rho`
 * exactly over the same survivor set. A future-dated claim (valid.from > t) clamps
 * to age 0 → recency 1.
 */
export const rankBlend =
  (simName: string, query: Value, opts: BlendOpts, t: Instant) =>
  (c: Corpus): RankedCorpus => {
    if (opts.alpha < 0 || opts.alpha > 1) {
      throw new Error(`rankBlend: alpha must be in [0,1], got ${opts.alpha}`);
    }
    if (!(opts.halfLifeDays > 0)) {
      throw new Error(`rankBlend: halfLifeDays must be > 0, got ${opts.halfLifeDays}`);
    }
    const fn = similarityFn(simName); // throws /no similarity fn/ for unknown names
    const scored = c.claims.map((claim, i) => {
      const rel = fn.scoreOne(claim.value, query); // [0,1]
      const age = Math.max(0, t - claim.valid.from); // ≥ 0
      const recency = multiplier({ kind: "exponential", halfLifeDays: opts.halfLifeDays }, age); // (0,1]
      const score = opts.alpha * rel + (1 - opts.alpha) * recency;
      return { claim, score, i };
    });
    scored.sort((a, b) => b.score - a.score || a.i - b.i);
    return { scored: scored.map(({ claim, score }) => ({ claim, score })) };
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/algebra/ranking.test.ts`
Expected: PASS (all 12 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/algebra/ranking.ts src/algebra/ranking.test.ts
git commit -m "feat(algebra): rankBlend — pure recency-aware ranking operator"
```

---

### Task 2: `rho.blend` Stage builder

**Files:**
- Modify: `src/mneme.ts` (imports near line 35; `rho` object at lines 115-119)
- Test: `src/mneme.test.ts` (append a `describe("rho.blend", ...)` block near the existing `describe("rho.by", ...)` at line 1421)

**Interfaces:**
- Consumes: `rankBlend`, `BlendOpts` from `./algebra/ranking.js`; existing `similarityFn` (already imported in `mneme.ts` at line 35); `ctx.evaluationClock`, `ctx.usedSimilarityVersions`, `ctx.usedEmbeddingModelVersions` from `EvalContext`.
- Produces: `rho.blend(simName: string, query: Value, opts: BlendOpts): Stage<Corpus, RankedCorpus>` — added as a property on the existing exported `rho` object (auto-exported via `src/index.ts` → `src/surface/index.ts`).

- [ ] **Step 1: Write the failing tests**

Append to `src/mneme.test.ts` (the file already imports `pipe, leaf, rho` from `./mneme.js`, `EvalContext`, `createSqliteAdapter`, `createMneme`, and defines `corpusDef`; reuse them). Add after the `rho.by` describe block:

```ts
// ── rho.blend — recency-aware ranking stage builder ───────────────────────────

describe("rho.blend", () => {
  const DAY = 86_400_000;
  const mkClaimAt = (value: string, fromTs: number) => ({
    profile: "profile-1" as any,
    workspace: corpusDef.id as any,
    subject: "rho-blend-subject",
    key: "fact",
    scope: {},
    value,
    confidence: { distribution: "beta" as const, parameters: { alpha: 9, beta: 1 }, raw: 0.9 },
    valid: { from: fromTs, to: Infinity },
    source: "manual" as const,
    provenance: {},
    evidence: [],
    tags: [],
    schema: `${corpusDef.id}@1`,
  });

  it("alpha=1 ranks identically to rho.by over the same corpus (the regression identity)", () => {
    const adapter = createSqliteAdapter();
    const m = createMneme({ adapter, availableTiers: [{ kind: "core" }] });
    m.createCorpus(corpusDef);
    m.commit("workspace:canopy", mkClaimAt("hello world test", 0), { writer: "w" });
    m.commit("workspace:canopy", mkClaimAt("foo bar baz", 0), { writer: "w" });

    const clock = 1_700_000_000_000;
    const blendResult = m.query<any>(
      "workspace:canopy",
      pipe(leaf("workspace:canopy"), rho.blend("jaccard", "hello world", { alpha: 1, halfLifeDays: 90 })),
      { evaluationClock: clock }
    );
    const byResult = m.query<any>(
      "workspace:canopy",
      pipe(leaf("workspace:canopy"), rho.by("jaccard", "hello world")),
      { evaluationClock: clock }
    );

    expect(blendResult.scored.map((s: any) => s.claim.value)).toEqual(
      byResult.scored.map((s: any) => s.claim.value)
    );
  });

  it("uses ctx.evaluationClock as the recency anchor (alpha=0 → newest valid.from first)", () => {
    const adapter = createSqliteAdapter();
    const m = createMneme({ adapter, availableTiers: [{ kind: "core" }] });
    m.createCorpus(corpusDef);
    const clock = 1_700_000_000_000;
    m.commit("workspace:canopy", mkClaimAt("old", clock - 100 * DAY), { writer: "w" });
    m.commit("workspace:canopy", mkClaimAt("new", clock - 1 * DAY), { writer: "w" });

    const result = m.query<any>(
      "workspace:canopy",
      pipe(leaf("workspace:canopy"), rho.blend("jaccard", "irrelevant", { alpha: 0, halfLifeDays: 90 })),
      { evaluationClock: clock }
    );
    expect(result.scored[0].claim.value).toBe("new");
  });

  it("records usedSimilarityVersions[name] = fn.version (jaccard@1 via ctx capture)", () => {
    const adapter = createSqliteAdapter();
    const m = createMneme({ adapter, availableTiers: [{ kind: "core" }] });
    m.createCorpus(corpusDef);
    m.commit("workspace:canopy", mkClaimAt("hello world", 0), { writer: "w" });

    let capturedVersions: Record<string, string> | undefined;
    const captureCtx = (input: any, ctx: EvalContext) => {
      capturedVersions = { ...ctx.usedSimilarityVersions };
      return input;
    };

    m.query<any>(
      "workspace:canopy",
      pipe(leaf("workspace:canopy"), rho.blend("jaccard", "hello", { alpha: 0.5, halfLifeDays: 90 }), captureCtx),
      { evaluationClock: 1_700_000_000_000 }
    );
    expect(capturedVersions).toEqual({ jaccard: "jaccard@1" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/mneme.test.ts -t "rho.blend"`
Expected: FAIL — `rho.blend is not a function` (property does not exist yet).

- [ ] **Step 3: Add the import**

In `src/mneme.ts`, immediately after the existing line `import { rho as rhoOp, similarityFn } from "./algebra/similarity.js";` (line 35), add:

```ts
import { rankBlend, type BlendOpts } from "./algebra/ranking.js";
```

- [ ] **Step 4: Add the `blend` builder to the `rho` object**

In `src/mneme.ts`, replace the `rho` object (currently lines 115-119):

```ts
export const rho = {
  jaccard: (query: Value): Stage<Corpus, RankedCorpus> => _rhoBy("jaccard", query),
  exact:   (query: Value): Stage<Corpus, RankedCorpus> => _rhoBy("exact", query),
  by: _rhoBy,
};
```

with:

```ts
export const rho = {
  jaccard: (query: Value): Stage<Corpus, RankedCorpus> => _rhoBy("jaccard", query),
  exact:   (query: Value): Stage<Corpus, RankedCorpus> => _rhoBy("exact", query),
  by: _rhoBy,
  /** Recency-aware ranking: blends value-similarity with valid.from recency.
   *  The evaluation instant is taken from ctx.evaluationClock (same instant the
   *  upstream tauValid used); the underlying rankBlend stays pure. Records the
   *  similarity fn's provenance version exactly like rho.by. */
  blend: (simName: string, query: Value, opts: BlendOpts): Stage<Corpus, RankedCorpus> =>
    (c, ctx) => {
      const fn = similarityFn(simName); // throws /no similarity fn/ for unknown names
      if (ctx.usedSimilarityVersions) ctx.usedSimilarityVersions[simName] = fn.version;
      if (fn.embeddingVersions && ctx.usedEmbeddingModelVersions) {
        Object.assign(ctx.usedEmbeddingModelVersions, fn.embeddingVersions);
      }
      const t = ctx.evaluationClock ?? Date.now();
      return rankBlend(simName, query, opts, t)(c);
    },
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/mneme.test.ts -t "rho.blend"`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/mneme.ts src/mneme.test.ts
git commit -m "feat(surface): rho.blend stage builder — clock from ctx, provenance recorded"
```

---

### Task 3: `rankedTailStages` recency dial

**Files:**
- Modify: `src/retrieval/read-pipeline.ts` (`RankedTailOpts` at lines 94-105; `rankedTailStages` body at lines 114-130)
- Test: `src/retrieval/read-pipeline.test.ts` (append to the existing `describe("rankedTailStages", ...)` block at line 311; add a clock-bearing apply helper)

**Interfaces:**
- Consumes: `rho` from `../mneme.js` (already imported at line 17), now including `rho.blend`.
- Produces: `RankedTailOpts.recency?: { alpha?: number; halfLifeDays?: number }`. When present, stage 1 becomes `rho.blend(rankFn, query, { alpha: recency.alpha ?? 0.5, halfLifeDays: recency.halfLifeDays ?? 90 })`; when absent, stage 1 stays `rho.by(rankFn, query)` (unchanged).

- [ ] **Step 1: Write the failing tests**

In `src/retrieval/read-pipeline.test.ts`, add a clock-bearing apply helper just after the existing `applyStages` function (after line 80):

```ts
function applyStagesWithClock<O>(
  stages: Array<(input: any, ctx: EvalContext) => any>,
  input: any,
  evaluationClock: number,
): O {
  const ctx: EvalContext = { adapter: null as any, catalog: null as any, evaluationClock };
  return stages.reduce<any>((acc, stage) => stage(acc, ctx), input) as O;
}
```

Then append these tests inside the `describe("rankedTailStages", ...)` block (after the existing tests, before its closing `});`):

```ts
it("recency absent: behaves identically to pure rho.by ordering", () => {
  // Same as the existing 'ranks by named fn' test — recency option omitted ⇒ no change.
  const out = applyStages<RankedCorpus>(
    rankedTailStages({ rankFn: "jaccard", query: "the quick brown fox" }),
    rankCorpus,
  );
  expect(out.scored[0].claim.id).toBe("r1"); // exact match top, unchanged
});

it("recency present (alpha=0): orders by valid.from recency", () => {
  const T = 1_800_000_000_000;
  const DAY_ = 86_400_000;
  const recencyCorpus = corpusOf([
    mk("rc-old", "me", "info", "alpha", T - 100 * DAY_),
    mk("rc-new", "me", "info", "beta", T - 1 * DAY_),
  ]);
  const out = applyStagesWithClock<RankedCorpus>(
    rankedTailStages({ rankFn: "jaccard", query: "irrelevant", recency: { alpha: 0, halfLifeDays: 90 } }),
    recencyCorpus,
    T,
  );
  expect(out.scored[0].claim.id).toBe("rc-new");
});

it("recency present with defaulted fields uses alpha=0.5 / halfLifeDays=90", () => {
  const T = 1_800_000_000_000;
  // With alpha=0.5 a relevant claim still beats an irrelevant newer one at moderate ages;
  // assert the stage runs and returns a full ranking (no throw, defaults applied).
  const out = applyStagesWithClock<RankedCorpus>(
    rankedTailStages({ rankFn: "jaccard", query: "the quick brown fox", recency: {} }),
    rankCorpus,
    T,
  );
  expect(out.scored).toHaveLength(3);
  expect(out.scored[0].claim.id).toBe("r1"); // exact match still wins at alpha=0.5
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/retrieval/read-pipeline.test.ts -t "recency"`
Expected: FAIL — `recency` is not a recognized option (TS error on the option object) / the alpha=0 ordering test fails because the current pipeline ignores recency.

- [ ] **Step 3: Add the `recency` field to `RankedTailOpts`**

In `src/retrieval/read-pipeline.ts`, inside `RankedTailOpts` (after the `relevanceFloor?` field, before the closing `}` at line 105), add:

```ts
  /** Recency blend dial. ABSENT → pure rho.by (backward-compatible, no behavior
   *  change). PRESENT → rho.blend; omitted fields default to alpha=0.5,
   *  halfLifeDays=90. PRECONDITION: the recency anchor is ctx.evaluationClock,
   *  while tauValid uses canonicalReadStages' evaluationInstant opt — the caller
   *  must pass the SAME instant to both (as the MCP recall path does). */
  recency?: { alpha?: number; halfLifeDays?: number };
```

- [ ] **Step 4: Branch stage 1 on the recency option**

In `src/retrieval/read-pipeline.ts`, in `rankedTailStages`, replace the return block (lines 120-129) so stage 1 is chosen by the `recency` option:

```ts
  const rankStage =
    opts.recency === undefined
      ? rho.by(opts.rankFn, opts.query)
      : rho.blend(opts.rankFn, opts.query, {
          alpha: opts.recency.alpha ?? 0.5,
          halfLifeDays: opts.recency.halfLifeDays ?? 90,
        });

  return [
    // 1. ρ: rank by similarity (rho.by) OR recency-blended similarity (rho.blend)
    rankStage,

    // 2. abstainBelowTop: if top score strictly < threshold, return empty corpus
    (r: RankedCorpus) => abstainBelowTop(abstainThreshold)(r),

    // 3. relevanceFloor: drop per-entry scores below floor
    (r: RankedCorpus) => relevanceFloor(floorThreshold)(r),
  ];
```

(Leave the `abstainThreshold` / `floorThreshold` locals above this block unchanged.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/retrieval/read-pipeline.test.ts`
Expected: PASS (existing tests + 3 new recency tests).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/retrieval/read-pipeline.ts src/retrieval/read-pipeline.test.ts
git commit -m "feat(retrieval): opt-in recency dial on rankedTailStages (default 0.5/90d)"
```

---

### Task 4: MCP `recall` recency params + wiring

**Files:**
- Modify: `src/mcp/tools.ts` (`RecallArgs` at lines 162-175; `recall` body — `now` at line 247, ranker at line 319)
- Modify: `src/mcp/server.ts` (recall `inputSchema` lines 110-129; `score` output description line 141; the `recall(session, {...})` pass-through lines 162-171)
- Test: `src/mcp/tools.test.ts` (append recency tests; reuse the existing `recall` + `jaccardDeps` harness)

**Interfaces:**
- Consumes: `rho` from `../surface/index.js` (add to the existing `import { pipe, leaf, sigma, rho } from "../surface/index.js"` — `rho.blend` is already a property after Task 2).
- Produces: `RecallArgs` gains `recencyAlpha?: number`, `recencyHalfLifeDays?: number`, `asOf?: string | number`. New local `parseAsOf(asOf?: string | number): number | undefined`. The `recall` ranker is `rho.by` when `recencyAlpha === 1`, else `rho.blend(..., { alpha: recencyAlpha ?? 0.5, halfLifeDays: recencyHalfLifeDays ?? 90 })`; `now = parseAsOf(args.asOf) ?? Date.now()` anchors both `canonicalReadStages.evaluationInstant` and the query `evaluationClock`.

- [ ] **Step 1: Write the failing tests**

Append to `src/mcp/tools.test.ts`. The file already imports `{ remember, recall, listCorpora, ensureCorpus, keyCensus }` from `./tools.js` and `{ freshSession, jaccardDeps, makeFakeHybridDeps }` from `./test-support.js`. **Reuse `freshSession()` (NOT `newSession`).** Note: `remember` is **synchronous** (no `await`); `validFrom` is an **ISO-8601 string only** (a number throws), so build it with `new Date(ms).toISOString()`. Add:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/mcp/tools.test.ts -t "recall recency"`
Expected: FAIL — `recencyAlpha`/`asOf` are not on `RecallArgs` (TS error) and the asOf-rejection test has no validation to throw.

- [ ] **Step 3: Add the new fields to `RecallArgs` and import `rho`**

In `src/mcp/tools.ts`, change the import at line 13 to include `rho`:

```ts
import { pipe, leaf, sigma, rho } from "../surface/index.js";
```

Then in `RecallArgs` (after the `relevanceFloor?` field, before the closing `}` at line 175), add:

```ts
  /** Relevance↔recency blend weight in [0,1]. Default 0.5. `1` = pure similarity
   *  (recency off, exact current behavior); `0` = pure recency. */
  recencyAlpha?: number;
  /** Exponential recency half-life in days (> 0). Default 90. */
  recencyHalfLifeDays?: number;
  /** Temporal scope: ISO-8601 string or epoch ms. Anchors BOTH tauValid (which
   *  claims are valid) and the recency term (age measured from this instant).
   *  Default = now. */
  asOf?: string | number;
```

- [ ] **Step 4: Add the `parseAsOf` helper**

In `src/mcp/tools.ts`, add this helper just above the `recall` function (e.g. right after the `ensureCorpus` function near line 105):

```ts
/** Parse an asOf temporal scope (epoch ms number or ISO-8601 string) to epoch ms.
 *  Returns undefined when not supplied; throws on an unparseable string/number. */
export function parseAsOf(asOf?: string | number): number | undefined {
  if (asOf === undefined) return undefined;
  const ms = typeof asOf === "number" ? asOf : Date.parse(asOf);
  if (!Number.isFinite(ms)) {
    throw new Error(`recall: asOf is not a valid date (epoch ms or ISO-8601): ${String(asOf)}`);
  }
  return ms;
}
```

- [ ] **Step 5: Anchor `now` on asOf and branch the ranker**

In `src/mcp/tools.ts`, in the `recall` function, change the `now` assignment (line 247) from:

```ts
  const now = Date.now();
```

to:

```ts
  const now = parseAsOf(args.asOf) ?? Date.now();
```

Then replace the ranker stage in the `session.mneme.query` pipeline (line 319, currently `rho.by(embeddings.rankFn, args.about),`) with a precomputed `ranker`. Immediately before the `const ranked = session.mneme.query<RankedCorpus>(` call (line 308), add:

```ts
  // Recency-aware ranking (on by default at alpha=0.5/90d). alpha=1 ⇒ pure rho.by,
  // byte-identical to prior behavior. `now` (asOf or Date.now) anchors both tauValid
  // (canonicalReadStages.evaluationInstant) and the recency term (ctx.evaluationClock).
  const ranker =
    args.recencyAlpha === 1
      ? rho.by(embeddings.rankFn, args.about)
      : rho.blend(embeddings.rankFn, args.about, {
          alpha: args.recencyAlpha ?? 0.5,
          halfLifeDays: args.recencyHalfLifeDays ?? 90,
        });
```

and change the pipeline's last stage from `rho.by(embeddings.rankFn, args.about),` to `ranker,`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/mcp/tools.test.ts -t "recall recency"`
Expected: PASS (4 tests).

- [ ] **Step 7: Surface the params on the MCP server tool**

In `src/mcp/server.ts`, in the `recall` tool `inputSchema` (after the `relevanceFloor` field, before the closing `}` at line 129), add:

```ts
        recencyAlpha: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("relevance↔recency blend 0..1 (default 0.5). 1 = pure similarity (recency off, exact prior behavior); 0 = pure recency"),
        recencyHalfLifeDays: z
          .number()
          .positive()
          .optional()
          .describe("exponential recency half-life in days (default 90)"),
        asOf: z
          .union([z.string(), z.number()])
          .optional()
          .describe("temporal scope: ISO-8601 string or epoch ms. Anchors BOTH which claims are valid and the recency term; default now"),
```

Then update the `score` output field description (line 141) from its current text to:

```ts
            score: z.number().describe("blended ranking score against the query (similarity·alpha + recency·(1-alpha); pure similarity when recencyAlpha=1)"),
```

Then in the `recall(session, {...})` call (lines 162-171), pass the three new args through — add after `relevanceFloor: a.relevanceFloor,`:

```ts
        recencyAlpha: a.recencyAlpha,
        recencyHalfLifeDays: a.recencyHalfLifeDays,
        asOf: a.asOf,
```

- [ ] **Step 8: Typecheck and run the MCP suite**

Run: `npm run typecheck`
Expected: no errors.

Run: `npx vitest run src/mcp/tools.test.ts src/mcp/server.test.ts`
Expected: PASS (existing tests unchanged + new recency tests).

- [ ] **Step 9: Commit**

```bash
git add src/mcp/tools.ts src/mcp/server.ts src/mcp/tools.test.ts
git commit -m "feat(mcp): recall recency params (recencyAlpha/halfLifeDays/asOf), on by default 0.5/90d"
```

---

### Task 5: Full-suite + bench regression guard

**Files:** none created — this is the verification gate that the α=1 identity holds end-to-end and nothing regressed.

**Interfaces:**
- Consumes: the complete implementation from Tasks 1-4.
- Produces: a green full suite + green LME fixture bench, confirming the bench arms still pass (the regression guard the spec §9 requires).

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: PASS — all existing tests plus the new `ranking`, `rho.blend`, `rankedTailStages` recency, and `recall recency` tests. No regressions in `mneme.test.ts`, `read-pipeline.test.ts`, `tools.test.ts`, `server.test.ts`.

- [ ] **Step 2: Typecheck the whole project**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Run the LongMemEval fixture bench (deterministic, no dataset/credits needed)**

Run: `npm run eval:lme:fixture`
Expected: completes without error and prints the fixture scoring table. This exercises the `recall`/ranking path end-to-end on the committed fixture; since the default behavior of the existing bench arms is unchanged at the ranking identity, the fixture run must still complete and score as before.

- [ ] **Step 4: Confirm the α=1 identity claim in writing**

Verify (from Task 2's passing identity test and Task 4's `recencyAlpha=1` test) that α=1 reproduces pure `rho` ordering. No code change; this step is the explicit checkpoint that the regression-guard identity is demonstrated by green tests, not assumed.

- [ ] **Step 5: Final commit (if any docs/notes changed; otherwise skip)**

```bash
git status   # if clean, nothing to commit — the guard is the green suite above
```

---

## Notes for the executor

- **Carried caveat (non-blocking):** the ~50-pair human judge-error spot-check on the real-answer confirmation is still pending (spec §0/§10). It does NOT gate this operator work — do not block on it.
- **Out of scope (do NOT add):** linear/step recency kernels, any LLM/heuristic intent classifier, per-corpus learned defaults, changes to resolution/dedupe/abstention/coverage semantics. (Spec §10.)
- **Layering:** never import from `retrieval`/`mcp` inside `src/algebra`. If a typecheck error tempts you to, the design is wrong — re-read spec §3.
- `src/mcp/tools.test.ts` helpers (verified): `freshSession()` + `jaccardDeps` from `./test-support.js`; `remember`/`recall`/`ensureCorpus` from `./tools.js`. `remember` is synchronous; `validFrom` is ISO-8601 string only. The assertions are the contract — if a detail drifts, mirror the existing tests in that file.
