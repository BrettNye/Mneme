# Confidence-aware serving — efficacy instrument design (2026-06-22)

**Status:** Approved design (brainstorming complete; pending plan).
**Type:** Bench-only efficacy instrument. No `src/` change in this project.
**Related:** bio-efficacy P0–P2 (`docs/bio/2026-06-07-bio-efficacy-protocol.md`), recency-ranking arc (`bench/longmemeval/manual/rank-blend.ts`, `bench/RESULTS.md` "Recency-aware ranking gate" / "Real-answer confirmation"), P2 resolution addendum (`bench/RESULTS.md`).

---

## 1. Motivation

The P2 investigation (2026-06-22) generalized into a load-bearing determination: **the read path is confidence-blind in ranking.** Serving ranks by similarity (ρ), recency, and temporal validity (τ); confidence enters only as an eligibility gate (`conflictThreshold`, default off) and a resolution tie-breaker. `ranking.ts` never reads confidence, and `contradiction.ts:74` discards combined confidences before serving.

Consequence: everything the bio layer produces is **serving-inert at the surface** — promotion (proven, P2), pooling (decision-4), and the keystone **outcome-reweighting** (would adjust confidence the read path ignores). Before building §5.6 pooling-safety or attaching the learning loop to a real outcome source (RaState/dogfood), the prerequisite question is:

> **Does anything bio produces actually reach the served answer?**

Under the current architecture the honest answer is "no — confidence doesn't enter ranking." The missing wire is **confidence-aware serving**, the direct analog of the recency blend that already shipped. This instrument measures whether that wire is worth building, before any of it is built.

## 2. Falsifiable question

*Does confidence-aware ranking improve served accuracy on the resolved survivor set, and how good would a confidence signal need to be to capture a useful fraction of that lift?*

Decomposed (B-first):

- **Ceiling (G0):** with a *perfect* (oracle) confidence signal, what is the maximum served-accuracy lift confidence-aware ranking can buy, and at what recall cost? If flat → bio-via-serving is futile regardless of how good the learning loop gets.
- **Degradation (G1):** how fast does that lift decay as confidence quality drops? → the minimum confidence quality the learning loop must achieve to matter.

## 3. Deliverable

A written **go/no-go**, backed by dated `bench/RESULTS.md` anchors:

- **FAIL:** "ceiling is flat → park confidence-aware serving and the bio-via-serving path."
- **PASS:** "ceiling = +X pp at recall cost Y; confidence quality ≥ p\* captures ≥ half the ceiling → a src confidence-ranking dial and the RaState attach are justified as separate next decisions."

A PASS does **not** ship a `src/` dial and does **not** greenlight the attach. It produces the number that would justify those.

## 4. Decision rule (pre-registered, P0–P2 convention)

Bars are pre-registered here and frozen before the run. Placeholder magnitudes below are the intended starting points; the running protocol doc fixes the final numbers before execution.

- **G0 — ceiling cell (hard kill-switch, run first).** Perfect oracle confidence (`p = 1.0`), best `w_conf`. **PASS** iff it lifts KU `updateCorrect` by **≥ 5 pp** over the recency-only baseline (the shipped `rankBlend` at α=0.5 / half-life 90d) **with recall@10 within 2 pp** of that baseline **and TR `temporalCorrect` not degraded beyond 2 pp**. Otherwise **FAIL → STOP** (no sweep, no LLM spend).
- **G1 — degradation curve (only if G0 passes).** At the winning `w_conf`, sweep confidence quality `p`. Report the lift-vs-`p` slope and the `p\*` where lift ≥ ½ the ceiling. Non-gating, informative.
- **Confirmation (only on the G0 winning cell).** The answer-correctness judge must confirm the proxy lift is real on actual answers (`answerInContext` lift > 0, TR not cratered). A proxy number is never cited without judge confirmation (the Trap-1 / `finding-proxy-overstates-ranking` lesson).
- **Sanity gates (rig-soundness, must hold or the run is void):** (a) `w_conf = 0` byte-identical to the shipped recency `rankBlend`; (b) `p = 0.5` (uninformative confidence) reproduces the recency-only baseline within noise — garbage confidence must not help.

## 5. Mechanism — confidence-aware ranking operator

A 3-term generalization of the shipped `rankBlend`:

```
score(claim) = w_sim · sim(claim.value, query)
             + w_rec · recency(t − claim.valid.from)     // exp half-life, as shipped
             + w_conf · conf(claim)                        // NEW
```

- **Convex weights:** `w_sim + w_rec + w_conf = 1`. Every term ∈ [0,1] ⇒ `score ∈ [0,1]`, preserving `rankBlend`'s invariant.
- **`conf(claim)`** = the *effective*-confidence point estimate, via `pointEstimate(claim.confidence)` (`src/core/confidence.ts` — scalar `p`, or beta `α/(α+β)` = `bindingFor(dist).mean(params)`). This is exactly the value the read path currently discards before ranking.
- **Sort:** score desc, tie-break = stable input order — identical to `src/algebra/ranking.ts`, so the identity gate holds.
- **Operates over the resolved survivor set only** (ranking-only scope): it reorders, never changes which claim survives. recall@k moves only through top-k reordering, never through set changes.

**Location: bench-only — new operator `bench/longmemeval/manual/rank-blend-conf.ts`.** Its recency term MUST mirror the **shipped** `rankBlend` in `src/algebra/ranking.ts` (`halfLifeDays`, evaluation instant `t` passed separately, anchored on `ctx.evaluationClock` exactly as `rho.blend` does), then add the `w_conf` term. **Do NOT extend the vestigial bench prototype `bench/longmemeval/manual/rank-blend.ts`** — it has an incompatible signature (`halfLifeMs`, `t` embedded in opts) and is not the function the serving path uses; matching it would make the identity gate meaningless. **No `src/` edit in this project.**

**Weight handling for the sweep.** The shipped recency blend fixes the sim:recency proportion (α=0.5 / half-life 90d). The sweep keeps that proportion constant and carves the confidence term out of the total: `w_sim = (1 − w_conf)·α`, `w_rec = (1 − w_conf)·(1 − α)`, `w_conf` swept over e.g. `{0, 0.1, 0.2, 0.3, 0.5}`. At `w_conf = 0` the weights reduce exactly to the shipped recency blend (the identity gate); as `w_conf` grows, sim and recency shrink proportionally so the convex sum stays 1.

## 6. Oracle confidence injection & degradation

The instrument overwrites each claim's confidence with a synthetic value a *perfect* bio layer would have learned.

- **Authoritative = high.** For KU, the authoritative claim is the one tracing to the **latest evidence session**. The scorer computes this internally as `latestEvidenceSessionId(q)` but **does not export it** (`bench/longmemeval/score.ts`) — so this slice must either re-export that helper or recompute the latest session at harness time from `q.answer_session_ids` × session dates (same logic). For TR, the right-period evidence session. `conf = HI` for authoritative-session claims, `conf = LO` otherwise. (HI/LO are fixed constants, e.g. 0.95 / 0.05; exact values fixed in the protocol.)
- **By-construction upper bound.** G0 deliberately uses the label — it is a ceiling, the same character as the recency arc's near-oracle `recencyTop1 ≈ 0.972`. Its *height* is not a realistic number; the informative outputs are (a) whether it is non-flat and (b) the G1 slope.

**Degradation model (G1).** Corrupt the oracle assignment with probability `1 − p`: with prob `p` a claim keeps its true HI/LO; with prob `1 − p` it draws HI/LO at random. Sweep `p ∈ {1.0, 0.9, 0.75, 0.5}`. `p = 1.0` is the ceiling; `p = 0.5` is uninformative (sanity gate b).

**Determinism.** The corruption draw is seeded by `(question_id, claim id)` via a deterministic hash — no `Math.random` in the data/scoring path. Every run and every `w_conf` cell sees the identical confidence assignment. The `w_conf`-grid and `p`-grid are orthogonal. (Clock reads for RESULTS.md header timestamps are permitted, matching the existing `ranking-variant-sweep.ts` precedent; the rule is "no randomness/clock in the computed sweep results," not "no clock at all.")

## 7. Harness & flow

A new bench script `bench/longmemeval/manual/conf-serving-sweep.ts`, structured like `ranking-variant-sweep.ts`:

1. **Shared setup:** one `EmbeddingCache` + one warm pass using a **standardized warm order** (a single shared warm helper) so the P2 embedding-batch artifact cannot reappear. Adapter/warm helpers are imported the same way the existing harnesses do (`createLocalEmbeddingAdapter`, `warmForQuestion`, `warmEmbeddings` via `../embeddings-local.js` and `src/algebra/embedding.js`, as in `ranking-variant-sweep.ts` / `pooling-efficacy.ts`). Ingest the LME oracle corpus once; arms are read-only.
2. **G0:** inject oracle confidence at `p = 1.0`; sweep `w_conf`; compute metrics; check the G0 bar. **Stop if FAIL.**
3. **G1:** at the winning `w_conf`, sweep `p ∈ {0.9, 0.75, 0.5}`; emit the degradation curve.
4. **Confirm:** run the answer-correctness judge (`answer-correctness-judge.ts`) on the G0 winning cell only.

**Inputs:** `--file longmemeval_oracle_target.json`, `--claims longmemeval-oracle-claims.jsonl`, `--ratified key-ratify-judgments-min094.jsonl` (the validated-band aliases, matching the 0.556 citable config), `--raw`.

## 8. Metrics

- **Primary proxy gate:** KU `updateCorrect` (cheap, no LLM).
- **Guardrails:** recall@3, recall@10, TR `temporalCorrect` and TR recall@3 — to catch confidence-boosting evicting time-scoped evidence (the failure mode pure recency hit on TR).
- **Confirmation:** judge `answerInContext` on the winning cell.
- All measured numbers land in `bench/RESULTS.md` under dated anchors `### conf-serving: <slot> (YYYY-MM-DD)` with slots {`ceiling`, `degradation`, `judge confirm`}. Pre-registered gates live in a protocol doc (`docs/bio/2026-06-22-conf-serving-protocol.md`, P0–P2 convention); RESULTS.md owns numbers, the protocol owns verdicts.

## 9. Identity & sanity gates (tests)

- **Identity:** at `w_conf = 0` the new operator produces ranking byte-identical to the **serving baseline** — `answerArmA` with the recency dial (i.e. `rho.blend` → `src/algebra/ranking.ts` `rankBlend` at α=0.5 / half-life 90d) — over all 229 questions (top-k matched per question). At `w_conf = 0, w_rec = 0`, identical to plain `rho.by`. (The baseline is the shipped src path, NOT the vestigial bench `rank-blend.ts`.)
- **Sanity b:** `p = 0.5` reproduces the recency-only baseline within noise.
- **Determinism:** two runs of the full sweep produce identical tables (seeded corruption, standardized warm).
- **Non-vacuity:** at least one question's top-1 actually changes between `w_conf = 0` and the ceiling cell (else the term is inert and the rig is suspect) — mirrors the `rho.blend` non-vacuous clock test.

## 10. Cost

- Sweeps are local embeddings + deterministic arithmetic = ~$0.
- Only the single judge-confirmation cell costs LLM \$ (sonnet, one cell, ~recency-confirmation scale — small), and runs **only after G0/G1 pass** (smoke-before-bulk discipline). A `--smoke` fixture-scale path runs network-free first.

## 11. Out of scope

- Any `src/` change (src promotion of a confidence-ranking dial is a separate, later decision gated on this number).
- The real outcome-reweighting loop (G1 only *bounds* what it must achieve; it does not exercise it).
- Resolution/selection effects of confidence (ranking-only scope — confidence does not change which claim survives a contradiction here).
- The RaState attach and dogfood-corpus measurement.
- §5.6 observation-level dedup before pooling (orthogonal substrate item; relevant only once a real pooling consumer exists).

## 12. Risks & notes

- **G0-flat is a real and acceptable outcome.** A flat ceiling is a decision-grade finding (parks a whole branch cheaply), not a failure of the instrument.
- **Ceiling height is not citable** as a product number — it leaks the label by construction. Only the *existence* of lift and the degradation slope are cited.
- **TR guardrail matters:** confidence that favors the latest-session claim could evict time-scoped TR evidence, exactly as pure recency did. The TR guardrail in the G0 bar guards against declaring a KU win that silently taxes TR.
- **Warm-order standardization** is a required side fix here (one shared warm helper) so the comparison is not re-contaminated by the P2 batch artifact.
