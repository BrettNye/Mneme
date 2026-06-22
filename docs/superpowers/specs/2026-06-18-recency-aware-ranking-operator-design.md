# Recency-aware ranking — `src` operator promotion design

**Date:** 2026-06-18
**Status:** Design (pre-plan)
**Branch:** `docs/adv-payroll-kb-design` (design only; implementation gets its own branch)
**Motivated by:** the twice-validated bench result (PRs #30, #31; bench spec `2026-06-17-recency-aware-ranking-gate-design.md`; memory `drift-injection-null-result`). On knowledge-update (KU) queries Mneme's resolution substrate already retains the latest-session claim ~0.97 of the time, but the served read ranks survivors by jaccard text-similarity only — surfacing the right claim as top-1 only ~0.45 of the time. The bottleneck is the **ranking method of the served read**, not resolution.

---

## 0. The bounded claim (what this does and does not improve)

This promotes the bench `rankBlend` prototype into a real, principled `src` operator. It improves **recall quality on knowledge-update queries specifically**, and is temporal-reasoning (TR) safe at the validated default.

- **Validated twice** (not a benchmark artifact): the proxy ranking gate (`updateCorrect` 0.403→0.972) *and* a separate real-answer LLM-judge pass (`answerInContext` KU 0.472→0.528, **+5.6pp**) with TR **flat** at α=0.5 / half-life=90d. The second check defeats the circularity that recency trivially maximizes a latest-session proxy.
- **Scope of the improvement:** the *served read*, not the substrate. Durability, auditability, replay, and resolution semantics are unchanged. This makes the read surface what resolution already knows.
- **Carried caveats (non-blocking for the operator):**
  1. Validated on one slice (LongMemEval oracle). The user's own dogfood corpus has a different distribution; the on-by-default MCP path is where this is watched in practice.
  2. The ~50-pair human judge-error spot-check on the real-answer confirmation is still pending.
  3. Reversible by construction: `α = 1` is exact current behavior; the library dial is opt-in, so no existing pipeline silently shifts.

---

## 1. Purpose

Give the served read a ranking operator that can see claim metadata (`valid.from`) and an evaluation instant, so it can blend text-relevance with recency. Expose it as a tunable dial (default α=0.5 / half-life=90d) and surface it through the MCP `recall` tool, while preserving determinism and the composition-first principle.

---

## 2. The gap this closes

The existing ranker `rho` is built on `SimilarityFn.scoreOne(value, query)` — it sees a claim's **value** and the **query**, and nothing else. It can never see `valid.from`, so it cannot express recency. That is the structural gap. The blend
```
score = α · sim(value, query) + (1−α) · recency(valid.from, t)
```
is an **additive** convex combination over `valid.from`-age. It is **not** expressible by composing existing operators: `delta` decays `confidence.effective` **multiplicatively** over `recorded`-age, not additively over `valid.from`-age, and there is no operator that takes a weighted sum of two score sources and re-sorts. A new ranking operator is therefore genuinely warranted under the composition-first principle — and it is still built **by composing** an existing `SimilarityFn` with the existing exponential decay kernel.

---

## 3. Architecture & layering

Four additive pieces. No existing operator semantics change.

| Layer | File | Change | Responsibility |
|---|---|---|---|
| Algebra | `src/algebra/ranking.ts` | **Create** | Pure `rankBlend` operator: `Corpus → RankedCorpus`, clock-free, takes the evaluation instant `t` explicitly. |
| Algebra | `src/algebra/ranking.test.ts` | **Create** | Unit tests for `rankBlend`. |
| Stage builder | `src/mneme.ts` | Edit | Add `rho.blend(simName, query, { alpha, halfLifeDays })` — a `Stage<Corpus, RankedCorpus>` that supplies `t` from `ctx.evaluationClock` and records provenance versions (mirrors `_rhoBy`). |
| Retrieval recipe | `src/retrieval/read-pipeline.ts` | Edit | `rankedTailStages` gains an **opt-in** `recency?` option. |
| Retrieval recipe | `src/retrieval/read-pipeline.test.ts` (or sibling) | Edit/Create | Cover recency-absent identity + recency-present blend. |
| MCP surface | `src/mcp/server.ts`, `src/mcp/tools.ts` | Edit | `recall` gains `recencyAlpha`, `recencyHalfLifeDays`, `asOf`; recency **on by default** (0.5 / 90d). |
| MCP tests | `src/mcp/tools.test.ts` | Edit/Create | Defaults, `asOf` anchoring, α=1 reproduces current output. |

**Layering contract preserved:** algebra never imports from retrieval. `ranking.ts` imports only from `./similarity.js` (`similarityFn`), `./decay.js` (`multiplier`), `./types.js`, and `../core/*`.

### Placement decision (approaches weighed)
- **(A) Generalize `SimilarityFn` → a richer `ScoringFn`** that sees the claim + instant. *Rejected:* `SimilarityFn.scoreOne(value, query)` purity and `version` are load-bearing across audits (B2) and every registered fn; the blend is not "a similarity fn." High blast radius, violates YAGNI.
- **(B) Put the op in `similarity.ts`** alongside `rho`. *Not chosen:* `similarity.ts` is value↔query scoring; a metadata-aware ranker muddies that boundary.
- **(C) New `src/algebra/ranking.ts`** importing `similarityFn` + `multiplier`. **Chosen:** keeps `similarity.ts` untouched, gives metadata-aware ranking its own home, and frames the operator as a composition of two existing pieces.

---

## 4. The operator (`src/algebra/ranking.ts`)

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
 * Both terms ∈ [0,1], so score ∈ [0,1] (commensurable). Pure / clock-free: the
 * evaluation instant `t` is a parameter (the Stage wrapper supplies it from ctx).
 *
 * Sort: score desc, tie-break = STABLE INPUT ORDER. At α = 1 the recency term is
 * fully zeroed and the tie-break is stable input order, so rankBlend reproduces
 * `rho`'s ordering EXACTLY over the same survivor set (the regression-guard identity).
 *
 * `valid.from > t` (future-dated) → age clamps to 0 → recency = 1 (treated as newest).
 */
export const rankBlend =
  (simName: string, query: Value, opts: BlendOpts, t: Instant) =>
  (c: Corpus): RankedCorpus => {
    if (opts.alpha < 0 || opts.alpha > 1)
      throw new Error(`rankBlend: alpha must be in [0,1], got ${opts.alpha}`);
    if (!(opts.halfLifeDays > 0))
      throw new Error(`rankBlend: halfLifeDays must be > 0, got ${opts.halfLifeDays}`);
    const fn = similarityFn(simName); // throws /no similarity fn/ for unknown names
    const scored = c.claims.map((claim, i) => {
      const rel = fn.scoreOne(claim.value, query);                 // [0,1]
      const age = Math.max(0, t - claim.valid.from);               // ≥ 0
      const recency = multiplier({ kind: "exponential", halfLifeDays: opts.halfLifeDays }, age); // (0,1]
      const score = opts.alpha * rel + (1 - opts.alpha) * recency;
      return { claim, score, i };
    });
    scored.sort((a, b) => b.score - a.score || a.i - b.i);
    return { scored: scored.map(({ claim, score }) => ({ claim, score })) };
  };
```

**Notes**
- **Recency kernel is `decay.multiplier`** — the same exponential family `delta` uses. Anchored on `valid.from`-age rather than `recorded`-age. This is the composition-first reuse.
- **Relevance term is a registered `SimilarityFn` by name** — `jaccard`, `hybrid`, and embedding-backed fns all work unchanged, and their `version`/`embeddingVersions` are available for provenance recording at the Stage boundary.
- **Exponential-only for v1** (the dial is `halfLifeDays`). `multiplier` already supports `linear`/`step`; generalizing the recency kernel is a trivial future extension, deliberately deferred (YAGNI). The bench validated exponential.

---

## 5. The Stage builder (`src/mneme.ts`)

Mirrors `_rhoBy` (which records provenance versions and reads `ctx`). The clock enters only here, exactly as `delta.*` and `tau.now` do — keeping the underlying operator pure.

```ts
export const rho = {
  jaccard: (query: Value): Stage<Corpus, RankedCorpus> => _rhoBy("jaccard", query),
  exact:   (query: Value): Stage<Corpus, RankedCorpus> => _rhoBy("exact", query),
  by: _rhoBy,
  blend: (simName: string, query: Value, opts: BlendOpts): Stage<Corpus, RankedCorpus> =>
    (c, ctx) => {
      const fn = similarityFn(simName);
      if (ctx.usedSimilarityVersions) ctx.usedSimilarityVersions[simName] = fn.version;
      if (fn.embeddingVersions && ctx.usedEmbeddingModelVersions) {
        Object.assign(ctx.usedEmbeddingModelVersions, fn.embeddingVersions);
      }
      const t = ctx.evaluationClock ?? Date.now();
      return rankBlend(simName, query, opts, t)(c);
    },
};
```
- Provenance: records the underlying similarity `version` (and embedding versions) identically to `_rhoBy`. The recency kernel is a fixed exponential; if an audit later wants a recorded marker for the blend itself, a `"blend@1"` version string can be added — out of scope for v1.
- Instant: `ctx.evaluationClock ?? Date.now()` — the same instant the upstream `canonicalReadStages` used for `tauValid` (callers pass one instant; see §7).

---

## 6. The dial (`src/retrieval/read-pipeline.ts`)

`RankedTailOpts` gains an optional `recency`:

```ts
export interface RankedTailOpts {
  rankFn: string;
  query: Value;
  abstainBelowTop?: number;
  relevanceFloor?: number;
  /** Recency blend. ABSENT → pure rho.by (backward-compatible, no behavior change).
   *  PRESENT → rho.blend; omitted fields default to alpha=0.5, halfLifeDays=90. */
  recency?: { alpha?: number; halfLifeDays?: number };
}
```

- **Absent** → stage 1 is `rho.by(opts.rankFn, opts.query)` exactly as today. **Zero behavior change** for every current consumer (bio read layer, LME bench arm A).
- **Present** → stage 1 is `rho.blend(opts.rankFn, opts.query, { alpha: recency.alpha ?? 0.5, halfLifeDays: recency.halfLifeDays ?? 90 })`. The blend stage reads the instant from `ctx.evaluationClock` at execution. **Anchor-both is the caller's contract:** the recency anchor equals `ctx.evaluationClock`, and `tauValid` uses `canonicalReadStages`'s explicit `evaluationInstant` opt — so the caller must pass the *same* instant to both (exactly as `tools.ts` does with one `now`). This is a documented precondition of `rankedTailStages`'s recency option, not an automatic guarantee.
- `abstainBelowTop` / `relevanceFloor` stages are unchanged and run on the blended scores.

---

## 7. The MCP surface (`src/mcp/server.ts` + `tools.ts`)

`tools.ts recall` currently inlines `rho.by(rankFn, about)` then applies the in-memory knobs (it does not call `rankedTailStages`). It already uses a **single** `now = Date.now()` for both `canonicalReadStages({ evaluationInstant: now })` and the query `{ evaluationClock: now }`. So:

```ts
const now = args.asOf ?? Date.now();   // anchors BOTH tauValid and the recency term
// ...canonicalReadStages({ evaluationInstant: now, ... }),
const ranker =
  args.recencyAlpha === 1
    ? rho.by(embeddings.rankFn, args.about)                         // exact current behavior
    : rho.blend(embeddings.rankFn, args.about, {
        alpha: args.recencyAlpha ?? 0.5,
        halfLifeDays: args.recencyHalfLifeDays ?? 90,
      });
// ...pipe(leaf, ...sigmas, ...canonicalReadStages({...}), ranker), { evaluationClock: now }
```

New `recall` input params (recency **on by default**):

| Param | Type | Default | Meaning |
|---|---|---|---|
| `recencyAlpha` | number 0..1 | **0.5** | `1` = pure relevance (recency off — no separate toggle); `0` = pure recency. |
| `recencyHalfLifeDays` | number > 0 | **90** | Exponential recency half-life. |
| `asOf` | ISO-8601 string or epoch ms | now | Temporal scope. Sets `now`, anchoring **both** `tauValid` (which claims are valid) and the recency term (age measured from this instant). |

**`asOf` parsing:** accept epoch ms (number) or ISO-8601 (string → `Date.parse`); reject unparseable with a clear error. Default = `Date.now()`.

**Output:** the `score` field now carries the **blended** score (not raw similarity). The output schema description is updated to say so. `topScore`, `rankFn`, `abstained`, and `coverage` semantics are otherwise unchanged (coverage is still computed over the pre-knob survivor set). The MCP server instructions / tool description note that recall is recency-aware by default and how to get pure relevance (`recencyAlpha: 1`) or a time-scoped read (`asOf`).

---

## 8. Determinism & the TR/KU boundary

- **Determinism** is preserved exactly as `delta`/`tau.now` do it: the operator is pure and clock-free; the clock enters only at the Stage boundary via `ctx`. Same `(survivors, query, α, halfLife, t)` ⇒ same ranking, always. No `Date.now()` inside the operator.
- **The boundary:** a static moderate blend (α=0.5 / 90d) is the TR-safe default that captures the KU win; an **explicit `asOf` re-anchors both filtering and recency**, so "what was X in 2021" is served by the substrate (filter to claims valid in 2021 *and* measure recency relative to 2021) with **no LLM intent classifier**. The static α=0.5 is the safety net for when the caller supplies no scope and the query happens to be time-scoped. Heavier recency (α ≤ 0.25) craters TR and is never the default.

---

## 9. Testing (TDD — this is the first `src` change of the arc)

**Unit — `src/algebra/ranking.test.ts`:**
- **α=1 identity:** orders identically to `rho` over the same corpus, including stable input-order tie-break on an equal-score pair (the exact identity the bench baseline gate and the LME regression guard rely on).
- **α=0 pure recency:** claims with distinct `valid.from` order newest-first; `age = 0 → recency = 1`.
- **Dial works:** a relevant-but-old claim and an irrelevant-but-new claim **swap order** as α goes 1 → 0 (proves the blend actually trades relevance for recency).
- **Half-life:** larger half-life flattens recency differences — assert score/ordering monotonicity on a constructed pair.
- **Future-dated clamp:** `valid.from > t` → recency = 1, no negative age.
- **Validation:** `alpha` outside [0,1] throws; `halfLifeDays ≤ 0` throws; unknown `simName` throws `/no similarity fn/`.
- **Empty corpus** → empty `scored`.

**Recipe — `read-pipeline` tests:**
- `recency` absent ⇒ output identical to current `rho.by` path (regression).
- `recency` present ⇒ blended order; defaults 0.5/90d applied when fields omitted.
- Instant sourced from `ctx.evaluationClock`.

**MCP — `src/mcp/tools.test.ts`:**
- Defaults: no recency params ⇒ α=0.5/90d applied.
- `recencyAlpha: 1` ⇒ output byte-identical to the pre-change `rho.by` path.
- `asOf` ⇒ both `tauValid` survivor set and recency anchor move to that instant (one test asserting both effects from a single `asOf`).
- `asOf` parsing: ISO string and epoch ms both accepted; unparseable rejected.

**Regression guard:** the existing LME bench arms must still pass. The α=1 identity is what makes "bench arm A unchanged" a true guard rather than an approximation.

---

## 10. Out of scope (v1)

- Non-exponential recency kernels (linear/step) — `multiplier` supports them; deferred until a use case appears.
- Any LLM/heuristic intent classifier — explicitly rejected; temporal scope is caller-supplied via `asOf`.
- Per-corpus or learned default α/half-life — the default is the single validated (0.5, 90d); per-corpus tuning is a later concern once the dogfood corpus gives signal.
- Changing resolution, dedupe, abstention, or coverage semantics.
- The pending ~50-pair human judge-error spot-check (tracked separately; does not gate the operator).

---

## 11. Implementation order (for the plan)

1. `rankBlend` operator + unit tests (pure, no wiring) — TDD red→green.
2. `rho.blend` Stage builder + provenance recording.
3. `rankedTailStages` opt-in `recency` dial + recipe tests.
4. MCP `recall` params (`recencyAlpha`, `recencyHalfLifeDays`, `asOf`) + `tools.ts` wiring + MCP tests; update tool/output descriptions.
5. Run the LME bench arms as the regression guard; confirm α=1 identity end-to-end.
