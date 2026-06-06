# Key-matching oracle experiment: auto-ratification threshold sweep (design)

**Date:** 2026-06-06
**Status:** Approved design (user-ratified; bench-only)
**Driven by:** first oracle-scale LME run (229 questions, sonnet-4-6 extraction, 474 sessions / 5,891 claims): KU updateCorrect collapsed from 1.0 (curated 10-sample) to **0.403** (arm A) vs 0.333 (arm B). Prime suspect: real key drift in un-curated extraction — Q2's thesis at benchmark scale. The key-matching slice (PR #23) is the remedy; this experiment measures its lift on REAL drift, and doubles as the deferred auto-merge threshold calibration study.
**Standing decisions honored:** [bench-only — auto-ratification is an experiment policy; the product keeps human/agent ratification; the sweep curve is calibration evidence for a FUTURE auto-suggest dial] · [honest reporting — full grid, no cherry-picked θ; merge stats published so degenerate merges are self-evident] · [determinism — fixed grid, deterministic canonical rule, local q8 embeddings, no wall-clock dependence].

## User-ratified decisions

1. **Scorers: both, side-by-side.** `jaccard` and `hybrid` (jaccard + bge cosine via `bench/longmemeval/embeddings-local.ts`) each get a full sweep curve — quantifies word-overlap drift vs synonym drift separately. Hybrid is what production census uses; jaccard is the zero-model floor.
2. **Bench-only scope.** No product surface changes beyond `AnswerOpts.keyAliases` (a bench file). No auto-suggest dial ships this slice regardless of curve shape.

## Design

### 1. Auto-ratifier (pure, unit-tested)

`bench/longmemeval/manual/key-alias-auto.ts`:

```ts
export interface AutoRatifyStats { aliases: number; components: number; largestComponent: number }
/**
 * Per-question auto-ratification: distinct keys of the question's claims →
 * score all pairs with scorerFn → edges where score >= theta → connected
 * components → canonical per component = key with MOST CLAIMS in this corpus,
 * tie broken by lexicographically smallest. Returns flat variant→canonical map
 * (KeyAliasMap — the same input shape ⊥ consumes; no alias claims written).
 * Deterministic: stable iteration (sorted keys), no randomness, no clock.
 */
export function autoRatify(
  keyCounts: Map<string, number>,
  scoreOne: (a: string, b: string) => number,
  theta: number,
): { map: KeyAliasMap; stats: AutoRatifyStats };
```

- θ above all scores ⇒ empty map ⇒ identity (the baseline equivalence lever).
- Components, not just pairs: `a~b, b~c` merge transitively even if `a~c < θ` (single-link, mirrors ⊕_dedupe's clustering convention).

### 2. Arm A plumb (`bench/longmemeval/answer.ts` — one field, one line)

`AnswerOpts` gains `keyAliases?: KeyAliasMap`; `answerArmA` threads it into `canonicalReadStages({ ..., keyAliases: opts.keyAliases })`. Arm B untouched (no resolution → constant comparator).

### 3. Sweep harness (`bench/longmemeval/manual/key-matching-sweep.ts`)

- CLI: `--file <oracle_target.json> --claims <oracle-claims.jsonl>` (same loaders as run.ts).
- Grid: scorer ∈ {jaccard, hybrid} × θ ∈ {0.50, 0.60, 0.70, 0.80, 0.90}, plus ONE no-alias baseline pass. 11 passes × 229 questions, all local/deterministic/free.
- Per pass, per question: ingest (same path run.ts uses) → distinct-key counts → `autoRatify` → `answerArmA(..., { keyAliases: map })`; arm B computed once (baseline pass) since it never changes.
- Hybrid: embed each scorer's key strings ONCE, cache across θ passes (same keys every pass).
- **Sanity gate:** the baseline pass must reproduce the recorded oracle numbers exactly (KU updateCorrect 0.403, n=72) or the harness ABORTS — no report from a broken rig.

### 4. Reporting (honest-by-construction)

Per (scorer, θ) row: KU updateCorrect + recall@1/3/10 (the lift); temporal-reasoning + abstention metrics (the no-harm check); merge stats (total aliases, questions affected, mean/largest component size). Full grid to stdout as markdown + an addendum section appended to `bench/RESULTS.md` with provenance (extraction model/promptVersion from the claims header, dataset, date). No best-θ headline without its full row context.

### 5. Error handling

- Embedding model load failure: hybrid rows reported `skipped (model unavailable)`; jaccard sweep completes; loud stderr.
- Claims-header mismatch (model/promptVersion) → existing validateCacheHeader behavior (abort).

### 6. Testing

- `key-alias-auto.test.ts` — components (chain a~b~c), canonical rule (most-claims, tie→lex), determinism (shuffled input ⇒ identical map), θ-above-all ⇒ empty map, single key ⇒ empty.
- Smoke: sweep over the committed 3-question fixtures reproduces fixture baseline at θ=high (identity), runs end-to-end.

## Out of scope

Product auto-suggest dial (trigger: this curve + ratify/ignore decisions accumulating); committing the oracle claims file (separate provenance decision); arm B aliasing (meaningless without resolution).
