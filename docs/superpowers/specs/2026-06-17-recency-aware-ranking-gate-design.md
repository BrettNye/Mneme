# Recency-aware ranking — gate experiment design

**Date:** 2026-06-17
**Status:** Design (pre-plan)
**Motivated by:** the resolution-vs-served result (`bench/RESULTS.md`; memory `drift-injection-null-result`): on KU, the resolved survivor set holds the latest-session claim ~0.97 of the time, but jaccard ranking surfaces it as top-1 only ~0.45. The bottleneck is the read's **ranking method**, not resolution. This experiment is the cheap, deterministic **gate** that decides whether a recency-aware read is the lever — and whether intent-routing is even needed.

---

## 1. Purpose and the decision it gates

Hold the resolved survivor set **fixed** (identical to arm A's) and vary only the **ranking of those survivors**, across all benchmark categories. Measure whether blending recency into ranking lifts knowledge-update (KU) accuracy **without** regressing temporal-reasoning (TR) or abstention.

This is a **gate**, not a product change. Three outcomes, each selecting a documented fork (§7):
- **A — deterministic win:** some (α, half-life) lifts KU `updateCorrect` with `ΔTR ≥ 0` → recency-aware ranking pays off with NO intent inference. Proceed to the real-answer confirmation, then a `src` promotion cycle. (Abstention is not part of the verdict — §2.)
- **B — tradeoff:** KU gains force TR losses across all cells → a single static blend can't serve both; the **intent-routing fork** (or explicit-as-of-from-caller) is justified.
- **C — null:** no blend beats α=1 on KU → recency ranking is not the lever; the proxy result was misleading and the next probe is real-answer correctness directly.

---

## 2. Scope

- **Bench-only.** New harness `bench/longmemeval/manual/ranking-variant-sweep.ts` + a pure `rankBlend` helper. NO `src/` change, NO change to `answer.ts`/`score.ts`/`run.ts`. No drift, no alias maps, no LLM — fully deterministic, $0.
- **Dataset:** oracle 229q (`longmemeval_oracle_target.json` + claims), all `TARGET_CATEGORIES` (knowledge-update, temporal-reasoning, abstention). Full haystack deferred.
- **Knobs off** (`abstainBelowTop`/`relevanceFloor` = 0) so ranking order is the only variable.
- **Metric basis is the SESSION PROXY** (`updateCorrect`/`temporalCorrect`), inheriting its known circularity (Trap 1): recency trivially maximizes a latest-session metric. So a proxy win is a **hypothesis**, confirmed only by the separate real-answer-correctness step before any `src` promotion (§7).
- **Abstention is NON-DISCRIMINATING on oracle and is NOT a gate (audit C-2).** The oracle `_abs` questions carry 2 answer-sessions each (~23 survivors), so the result is never empty and structural abstention never fires with knobs off → `abstentionCorrect` is a constant 0.0 across all cells (documented in `bench/RESULTS.md`: "abstention needs a relevance/confidence threshold"). It is logged for completeness but provides no signal and is excluded from the WIN/TRADEOFF verdict. (Note: the *fixture's* `fx-abs-1_abs` has 0 answer-sessions so it DOES abstain — fixture abstention behavior must not be read as representative of the oracle run.)
- **Detectability is empirically confirmed (audit E-2/3):** measured oracle survivor counts are median ~23 per question (>94% exceed k=10), so ranking order genuinely changes top-k membership — `updateCorrect` (top-1), `recall@k`, and `temporalCorrect` (computed over the top-k set) all move. The cross-category KU↔TR tradeoff is detectable at k=10. Caveat: TR has low dynamic range on the oracle slice, so a TR regression may be small even when real.

---

## 3. Architecture and components

| File | Change | Responsibility |
|---|---|---|
| `bench/longmemeval/manual/rank-blend.ts` | Create | Pure `rankBlend` — orders a survivor set by the α/λ weighted-sum score. |
| `bench/longmemeval/manual/rank-blend.test.ts` | Create | Unit tests for `rankBlend`. |
| `bench/longmemeval/manual/ranking-variant-sweep.ts` | Create | Grid driver: per question `resolveOnly → rankBlend → scoreQuestion`, across the α×half-life grid and all categories; baseline gate; output. |
| `bench/longmemeval/manual/ranking-variant-sweep.test.ts` | Create | CLI/gate test on the fixture. |

**Per-question data flow:**
```
records = claimsFor(q, allClaims, { oracle: true })
ingestQuestion(session, q, records)                       // throwaway tmp DB
survivors = resolveOnly(session, lme-<id>, q, {           // reused from drift-resolution-metrics.ts
  keyCardinality: MANUAL_KEY_CARDINALITY,
  evidencePoolingRule: RULE.MAX_MEAN,                      // scalar oracle claims
})                                                        // resolved set == arm A's, ranking stripped
ordered = rankBlend(survivors, q.question, { alpha, halfLifeMs, t: evaluationInstant(q) })
result  = { arm: "A", claims: ordered.slice(0, MAX_K), abstained: ordered.length === 0 }
scoreQuestion(q, result, KS)                              // existing scorer, all categories
```
`resolveOnly` is reused verbatim; only the ranking tail differs from arm A, isolating ranking as the single variable.

---

## 4. The blend ranking (`rank-blend.ts`)

```ts
import type { Claim } from "../../../src/core/claim.js";
import type { Value } from "../../../src/core/value.js";
import { simJaccard } from "../../../src/algebra/similarity.js";

export interface BlendOpts { alpha: number; halfLifeMs: number; t: number }

/** Weighted sum of jaccard relevance and exponential age-decay recency.
 *  alpha=1 → pure jaccard (== arm A over the resolved set); alpha=0 → pure recency.
 *  Pure, deterministic; sort ties broken by valid.from desc, then recordedSeq desc,
 *  then stable input order. */
export function rankBlend(survivors: readonly Claim[], query: Value, opts: BlendOpts): Claim[] {
  const lambda = Math.LN2 / opts.halfLifeMs;
  const scored = survivors.map((claim, i) => {
    const rel = simJaccard.scoreOne(claim.value, query);            // [0,1]
    const age = Math.max(0, opts.t - claim.valid.from);            // ≥0 (tauValid guarantees)
    const recency = Math.exp(-lambda * age);                       // (0,1], newest≈1
    const score = opts.alpha * rel + (1 - opts.alpha) * recency;
    return { claim, score, i };
  });
  // Tie-break = STABLE INPUT ORDER ONLY (a.i - b.i). This makes alpha=1
  // byte-identical to arm A's rho (which is a stable score-only sort over the
  // SAME post-canonicalReadStages claim order resolveOnly returns) — so the
  // baseline gate is a true identity, not an approximation (audit E-4). No
  // valid.from/recordedSeq tiebreak is needed: at alpha=0 the score IS
  // monotonic in valid.from, so recency order is already carried by the score.
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.claim);
}
```

Notes: `simJaccard.scoreOne` already returns [0,1]; `recency` is [0,1]; so `score` is a convex combination in [0,1] — the two terms are commensurable. **At `alpha = 1` the recency term is fully zeroed and the tie-break is stable input order, so `rankBlend` reproduces arm A's jaccard ranking EXACTLY** (resolveOnly returns the same claim order arm A's `rho` ranks). `RULE` (used by the driver, not `rankBlend`) is imported from `../../../src/distribution/rules.js`.

---

## 5. Grid, metrics, baseline gate

- **Grid:** `alpha ∈ {1.0, 0.75, 0.5, 0.25, 0.0} × halfLifeDays ∈ {30, 90, 365}`. At `alpha = 1` the half-life is irrelevant, so the three collapse to ONE baseline cell (run once). `halfLifeMs = halfLifeDays × 86_400_000`.
- **Metrics**, per (alpha, halfLife) × category, all from the existing `scoreQuestion`/`aggregate`: KU `updateCorrect`, TR `temporalCorrect`, `recall@{1,3,10}`, with `n`. `abstentionCorrect` is logged but non-discriminating (§2) — not in the verdict. `KS = [1, 3, 10]` (k=1 included for the sharpest recency dose-response and to be safe on the small survivor-count tail).
- **Baseline gate (hard abort):** the `alpha = 1` cell's KU `updateCorrect` must equal `--expect-update-correct` (default **0.403**, the recorded oracle), or the run aborts. Because `rankBlend(alpha=1)` is an EXACT identity with arm A's `rho` (§4 — stable input-order tie-break over the same claim order), this is a true identity check, not an approximation; any divergence is a real rig break, not a tie-ordering artifact. The gate additionally asserts the per-question top-1 session-id set under `alpha=1` matches arm A's (a stricter identity than the 3-dp aggregate). TR baseline logged (not gated).
- **Output:** a table (`alpha, halfLifeDays, category, updateCorrect/temporalCorrect, recall@1, recall@3, recall@10, n`); per-category dose-response over alpha (per half-life); and a **gate-verdict block** computing per cell `ΔKU = KU_updateCorrect − baselineKU` and `ΔTR = TR_temporalCorrect − baselineTR`, labeling each cell WIN (`ΔKU > 0 ∧ ΔTR ≥ 0`), TRADEOFF (`ΔKU > 0 ∧ ΔTR < 0`), or NEUTRAL/LOSS. The verdict block selects outcome A/B/C.

---

## 6. Testing

**Unit (`rank-blend.test.ts`):**
- `alpha = 1` orders identically to a stable sort by `simJaccard.scoreOne` desc over the input order — the EXACT arm-A/`rho` identity the baseline gate relies on (construct a case with an equal-score pair and assert input order is preserved, matching `rho`'s stable sort).
- `alpha = 0` orders by recency: given claims with distinct `valid.from`, newest first; `age = 0` → recency = 1.
- **Dial works:** a *relevant-but-old* claim and an *irrelevant-but-new* claim swap order as alpha goes 1 → 0 (proves the blend actually trades relevance for recency).
- Half-life effect: a larger half-life flattens recency differences (closer scores) — assert ordering/score monotonicity for a constructed pair.
- Tie-break determinism: equal blended score → stable input order (`a.i − b.i`); empty input → empty.

**Harness (`ranking-variant-sweep.test.ts`, fixture):** one end-to-end cell on the 3-question fixture proving `resolveOnly → rankBlend → scoreQuestion` round-trips, the new columns render, and the `alpha = 1` baseline gate passes on the fixture's known KU `updateCorrect`. Note the fixture's `fx-abs-1_abs` (0 answer-sessions) DOES abstain — so the fixture is not a valid check of oracle abstention behavior (§2); the harness test asserts only KU/TR/round-trip, not an abstention number.

**On-demand oracle sweep** stays out of CI (gitignored dataset).

---

## 7. Forks (recorded, selected by the result)

- **Real-answer confirmation (precedes any promotion).** A proxy win (§1-A) is confirmed only by measuring real answer correctness (exact-match / LLM-judge against `q.answer`) on at least a stratified sample — defeats the proxy circularity (Trap 1). Apply smoke-before-bulk-spend. Only a blend that survives this earns `src`.
- **`src` promotion (on a twice-validated win).** Separate spec/plan cycle. Because `rho` ranks on value-similarity only (`SimilarityFn` sees value+query, never metadata), the blend becomes a NEW claim-metadata-aware ranking operator in `src/algebra` + a dial in `rankedTailStages` (`src/retrieval/read-pipeline.ts`), surfaced through arm A's `rankFn`, the MCP `recall` tool (τ/recency-aware option), and the bio read layer. Winning (alpha, half-life) becomes the default config.
- **Intent-routing / explicit-as-of (only on outcome B).** If a static blend can't serve KU and TR together, prefer pushing temporal scope to the CALLER (explicit as-of `t` / recency preference on the query — substrate-native via `tauValid`) over an inferred LLM classifier. The classifier is the last resort, off-wedge.

---

## 8. Out of scope (YAGNI)

- Any `src` change (gate is bench-only).
- Real-answer judging / LLM cost (deferred to the confirmation fork).
- Hybrid embedding ranker (orthogonal; jaccard is the baseline the recorded number uses).
- Full haystack dataset (oracle slice is the gate).
- Intent classification (only if outcome B; and explicit-as-of preferred over a classifier).
