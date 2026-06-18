# Drift arm refinement: resolution-layer vs served-layer recovery — design

**Date:** 2026-06-17
**Status:** Design (pre-plan)
**Builds on:** `2026-06-17-drift-injection-bench-arm-design.md` (the drift-injection arm) and its near-null result (`bench/RESULTS.md`; memory `drift-injection-null-result`).

---

## 1. Purpose

The drift-injection arm returned a near-null wedge (≈1 KU question; 0 for morph). Diagnosis: `updateCorrect` passes through **two** layers — resolution (⊥ deprecates the stale claim) **then** ranking (jaccard over claim text, which includes the key). Key-aliasing only affects the first layer, so a key-text-sensitive ranker masks the resolution benefit.

This refinement adds a **resolution-layer measurement** that bypasses ranking, run alongside the existing served-layer `updateCorrect`. The deliverable is the **ranking tax**: how much resolution benefit aliasing produces that the ranked served answer fails to surface.

**Falsifiable expectation:** the resolution-collapse recovery (aliasing on−off) is substantially larger than the served recovery; their gap is the ranking tax. If resolution-collapse recovery is *also* near-zero, the limitation is not ranking and the diagnosis is wrong (a real, informative outcome).

---

## 2. Scope

- Extends the existing drift-injection sweep; same oracle 229q slice, jaccard ranker, knobs off, `evidencePoolingRule: RULE.MAX_MEAN`, oracle alias map.
- Adds: one runner (`resolveOnly`) and two KU-only metrics (`staleDeprecationCorrect`, `recencyTop1Correct`), reported per cell next to `updateCorrect`.
- Does NOT change the injector, the existing `updateCorrect`/recall scoring, or `score.ts`.
- Out of scope: earned alias map; hybrid ranker; non-KU categories; any production/`src` change; persistent storage (throwaway tmp DB per cell, unchanged).

---

## 3. Architecture and components

| File | Change | Responsibility |
|---|---|---|
| `bench/longmemeval/manual/drift-resolution-metrics.ts` | Create | `resolveOnly` runner + `staleDeprecationCorrect` + `recencyTop1Correct` + a local `latestAnswerSessionId` helper. Pure/bench-only. |
| `bench/longmemeval/manual/drift-resolution-metrics.test.ts` | Create | Unit tests for the runner and both scorers on hand-built corpora. |
| `bench/longmemeval/manual/drift-injection-sweep.ts` | Modify | Per cell, compute the two new metrics over `resolveOnly` survivors (aliased off/on); add table columns + a resolution dose-response block + the ranking-tax line. |
| `bench/longmemeval/manual/drift-injection-sweep.test.ts` | Modify | Assert the new columns render and the baseline gate still holds on the fixture. |

`score.ts`, `answer.ts`, `ingest.ts`, `types.ts`, `drift-injector.ts`, and all `src/` are unchanged.

---

## 4. The resolution-layer runner (`resolveOnly`)

```ts
import { leaf, pipe } from "../../../src/index.js";
import type { Corpus } from "../../../src/algebra/types.js";
import type { Claim } from "../../../src/core/claim.js";
import { canonicalReadStages } from "../../../src/retrieval/read-pipeline.js";
import type { Session } from "../../../src/surface/index.js";
import type { LmeQuestionT } from "../types.js";
import { evaluationInstant } from "../answer.js";

export interface ResolveOnlyOpts {
  keyCardinality?: Record<string, "single" | "multi">;
  keyAliases?: Record<string, string>;
  evidencePoolingRule?: string;
}

/**
 * Run the canonical read core ONLY (τ_valid → ⊕_dedupe → ⊥/resolve → drop
 * deprecated) with NO ranking tail. Returns the surviving claims. This is
 * answerArmA minus rankedTailStages — the resolution view, ranking-free.
 */
export function resolveOnly(
  session: Session,
  corpusId: string,
  q: LmeQuestionT,
  opts: ResolveOnlyOpts,
): readonly Claim[] {        // corpus.claims is readonly Claim[]; callers spread if they need a mutable copy
  const t = evaluationInstant(q);
  const stages = pipe(
    leaf(corpusId),
    ...canonicalReadStages({
      evaluationInstant: t,
      keyCardinality: opts.keyCardinality,
      keyAliases: opts.keyAliases,
      evidencePoolingRule: opts.evidencePoolingRule,
    }),
  );
  const corpus = session.mneme.query<Corpus>(corpusId, stages, { evaluationClock: t });
  return corpus.claims;
}
```

`canonicalReadStages` already drops deprecated, contradiction-flag, and alias-shaped claims (read-pipeline.ts:84-88), so `corpus.claims` is exactly the surviving served-eligible set minus ranking.

**Equivalence caveat:** `ResolveOnlyOpts` omits `conflictThreshold` and `dedupe` (which `answerArmA` accepts). The sweep passes neither dial, so canonicalReadStages uses identical defaults (threshold 0, dedupe jaccard@0.5) in both — "arm A minus ranking" holds *for this sweep*. If a future caller sets those dials on arm A, mirror them here.

**Attribution caveat:** `canonicalReadStages` runs `⊕_dedupe` *before* ⊥. Dedupe groups by `(subject, key, scopeHash)` first (combination.ts:42), so it can NEVER merge claims across *different* (drifted) keys — the cross-key confound does not exist. But it DOES collapse same-key same-value duplicates to one winner pre-⊥ (combination.ts:213-220), discarding the others' tags. So `staleDeprecationCorrect` measures (dedupe ∪ ⊥) collapse, not ⊥ alone — acceptable because arm A has the identical dedupe stage, but named here so the metric isn't over-attributed to ⊥.

---

## 5. The two metrics (KU-only)

Both return `boolean | undefined` (undefined for non-scorable questions), aggregated by the existing `updateCorrect` convention. Lineage is proxied by `answer_session_ids` membership on each claim's `session:` tag.

```ts
// Latest answer session by date; ties → last occurrence in answer_session_ids.
// MUST iterate answer_session_ids (NOT q.sessions) in order, keeping the
// candidate with ms >= latestMs, keying dates via q.sessions[].sessionId →
// parseLmeInstant(date). This matches score.ts:53-75 (latestEvidenceSessionId,
// not exported) exactly; iterating q.sessions or using > would diverge on ties.
function latestAnswerSessionId(q: LmeQuestionT): string | null { ... }

function sessionTagOf(c: Claim): string | null { /* first tag starting "session:" → the id, else null */ }
```

**Denominator (E5 fix): both metrics return `undefined` unless the question is KU AND `answer_session_ids.length >= 2`.** A single-answer-session KU has no lineage to fragment or collapse — `staleDeprec` would be trivially true at both off and on, diluting every delta toward zero (the exact trap the prior arm fell into). The sweep reports the resolution metrics over the `>=2` subset and reports that `n` separately from the `updateCorrect` n.

- **`staleDeprecationCorrect(q, survivors): boolean`** — true ⇔ **no** surviving claim traces to a *non-latest* answer session:
  `survivors.filter(c => { const s = sessionTagOf(c); return s !== null && answerIds.has(s) && s !== latest; }).length === 0`.
  Measures whether the pipeline **completely** collapsed the lineage to the newest answer-session claim. Note `resolveDeprecateOlder` is *pairwise*; a 3+-session lineage may not fully chain to a single survivor in one pass, in which case a middle-aged non-latest survivor lingers and the metric is (correctly) false. Full collapse to latest is the bar. (At aliasing off with split keys the stale claim survives → false; at on it is deprecated → true.)

- **`recencyTop1Correct(q, survivors): boolean`** — true ⇔ the survivor with max `valid.from` carries `session:` == latest answer session. The rank-free served analog (recency replaces jaccard). Ties on `valid.from` broken by larger `recordedSeq` then last in array (deterministic). **This is a NEGATIVE CONTROL, not a signal:** the newest claim survives whether or not the stale one was contested, so `recencyTop1_on ≈ recencyTop1_off` is expected. A non-zero on−off delta here means the harness is wrong — that is its only diagnostic use.

Edge cases: empty `survivors` → both false (nothing served). Non-KU or `answer_session_ids.length < 2` → both undefined.

---

## 6. Sweep wiring + output

Per (fraction, mode, aliased) cell, after the existing arm-A pass, call `resolveOnly` once with the same opts (including `evidencePoolingRule: RULE.MAX_MEAN` and `keyAliases` when aliased). Compute the two metrics over the `>=2`-answer-session KU subset and average. Crucially, `staleDeprec`, `recencyTop1`, AND `updateCorrect` must be computed **per question on the same corpus/opts**, so they can be combined per-question (E4).

- **Table** gains columns: `staleDeprec`, `recencyTop1` (3-decimal), and `nRes` (the `>=2`-session denominator), beside `updateCorrect`/`n`.
- **Fragmentation instrument (E1):** per cell, also report `fragLineages` = count of `>=2`-session KU lineages where drift produced `>=2` distinct keys among the answer-session claims. This is the denominator the deltas actually live in — without it a near-zero delta is uninterpretable (saturation vs. no-fragmentation vs. genuine null). Expect `fragLineages = 0` at fraction 0 (no injected drift).
- **Ranking-tax = a per-question conjunction (E4), NOT a difference of aggregate deltas.** Define, per question on a fixed (corpus, opts): `dropped(q) = staleDeprec(q) === true AND updateCorrect(q) === false` — resolution succeeded but the ranked top-1 failed to surface it. The headline tax per (mode, fraction) is `rate(dropped) at aliased=on − rate(dropped) at aliased=off`: the resolution wins aliasing produced that the ranker dropped. Report the two raw aggregate deltas (`staleDeprec on−off`, `updateCorrect on−off`) alongside for transparency, but the conjunction rate is the headline — it is monotone and avoids subtracting two non-commensurable (set-property vs. top-1) rates.
- **Dose-response** gains, per mode, a resolution block printing per fraction `staleDeprec` off→on and the `dropped`-rate tax.

The baseline gate (zero-drift, no-alias, KU `updateCorrect` == `--expect-update-correct`) is unchanged.

---

## 7. Testing

**Unit (`drift-resolution-metrics.test.ts`):**
- `resolveOnly` returns post-⊥ survivors and applies no ranking (order is corpus order, not score order); deprecated/alias/flag claims absent.
- `latestAnswerSessionId`: matches `score.ts` tie-break — iterate `answer_session_ids`, `>=`, keyed on `sessionId`; a date tie returns the LAST id in `answer_session_ids`.
- `staleDeprecationCorrect`: 2-session stale + latest both surviving (aliasing-off shape) → false; only latest surviving → true; **3-session lineage** where only the oldest is deprecated (middle-aged non-latest survives) → false (confirms the complete-collapse bar against pairwise resolve); single-answer-session KU → undefined (denominator excluded); non-KU → undefined; latest-only with extra latest-session claims → true.
- `recencyTop1Correct`: newest survivor on latest session → true; newest survivor on a stale session → false; `valid.from` tie resolved by `recordedSeq` → deterministic; empty survivors → false; single-answer-session KU → undefined.
- `dropped` conjunction: `staleDeprec=true ∧ updateCorrect=false` → true; all other combos → false.

**Sweep (`drift-injection-sweep.test.ts`):** extend the fixture end-to-end test to assert the new columns (`staleDeprec`, `recencyTop1`, `nRes`, `fragLineages`) appear, that `fragLineages=0` at fraction 0, and that the baseline gate still passes (`--expect-update-correct` for the fixture). On-demand oracle sweep stays out of CI.

---

## 8. Expected output shape (hypothesis, not asserted)

Read deltas **only where drift fragmented lineages** (`fragLineages > 0`); the f=0 cells are a control where `staleDeprec on−off ≈ 0` by construction. On the fragmented subset at f>0 we expect the `dropped`-rate tax (`staleDeprec=true ∧ updateCorrect=false`, on−off) to be clearly positive — especially for morph, where served recovery was 0 — confirming resolution recovers the stale-collapse but the jaccard ranker drops it. `recencyTop1 on−off` should stay ≈0 (negative control). Three failure modes are now distinguishable: (a) tax positive → ranking masks a real resolution win (diagnosis confirmed); (b) tax ≈0 AND `fragLineages` healthy AND `staleDeprec on−off ≈0` → resolution itself isn't recovering, limitation is elsewhere (diagnosis refuted); (c) `fragLineages ≈0` → the injector never created the condition, the experiment is inconclusive (re-run targeting newest-claim fragmentation). All three outcomes are recorded in `bench/RESULTS.md`.
