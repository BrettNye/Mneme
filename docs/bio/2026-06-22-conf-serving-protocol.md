# Confidence-aware serving — efficacy protocol (pre-registered 2026-06-22)

**Status:** RUN 2026-06-22 — **G0 FAIL** (see Verdict below). Gates frozen here; measured numbers
live only in `bench/RESULTS.md` under `### conf-serving: <slot> (YYYY-MM-DD)`
anchors (slots: `ceiling`, `degradation`, `judge confirm`).
**Spec:** docs/superpowers/specs/2026-06-22-confidence-aware-serving-design.md

## Verdict (run 2026-06-22)

**G0 — FAIL** (per the registered rule). Oracle confidence (p=1, best wConf=0.2) lifts KU updateCorrect 0.778 → 0.972 (+0.194) but recall@10 falls 0.792 → 0.625 (−0.167), blowing the ±0.02 guardrail. Numbers: `bench/RESULTS.md#conf-serving-ceiling-2026-06-22`. Identity gate OK; baseline reproduces the recency α=0.5/90d number (0.778). G1 ran (informational): KU is nearly flat across confidence quality (p=1→0.5: 0.972→0.931), confirming recency already carries the lift. Judge NOT run (G0-gated).

**Decision (per protocol):** confidence-aware serving is PARKED. The KU lift is real but not Pareto-safe (evicts top-k evidence, like pure recency) AND redundant with the shipped deterministic recency blend (oracle confidence ≈ latest valid.from on this corpus). Bio-via-confidence-serving is not justified by this measurement. Scope caveat: only the LME knowledge-update regime (newest = right answer) was tested; a regime where recency is the wrong proxy (source-trust / corroboration / recency-wrong contradictions) plus a real outcome source is where bio's serving value would have to be re-measured — RaState-gated, not on this bench.

## Fixed parameters

- HI = 0.95, LO = 0.05 (injected confidence values).
- Recency baseline: bench `rankBlend`, alpha = 0.5, half-life = 90 days.
- wConf grid = {0, 0.1, 0.2, 0.3, 0.5}.
- p (confidence-quality) grid = {1.0, 0.9, 0.75, 0.5}.
- Dataset: longmemeval_oracle_target.json (oracle attribution), --raw.
- Ranking similarity: jaccard (matches the recency real-answer baseline).

## Sanity gates (must hold or the run is void)

- **Identity:** wConf = 0 ranking is byte-identical to the bench `rankBlend`
  baseline on all 229 questions (top-k per question), regardless of injected p.
- **Garbage-confidence:** at p = 0.5 (uninformative confidence), no wConf cell
  beats the wConf = 0 baseline KU updateCorrect by more than noise (≤ 0.01).

## G0 — ceiling (hard kill-switch, run first)

Perfect oracle confidence (p = 1.0), best wConf cell. **PASS** iff it lifts KU
updateCorrect by ≥ 0.05 over the wConf = 0 baseline, with recall@10 within 0.02
of baseline AND TR temporalCorrect not down by more than 0.02. Otherwise
**FAIL → STOP**: confidence-aware serving declared low-value; bio-via-serving
parked. No degradation sweep, no LLM spend.

## G1 — degradation (only if G0 passes)

At the winning wConf, sweep p ∈ {0.9, 0.75, 0.5}. Report the lift-vs-p curve and
the p* where lift ≥ ½ the ceiling. Non-gating, informative (sets the confidence
quality the learning loop must reach).

## Confirmation (only on the G0 winning cell)

Run the answer-correctness judge (claude-sonnet-4-6) over the winning cell's
served top-5 context vs gold answers (KU + TR). PASS iff KU answerInContext lift
> 0 over baseline AND TR answerInContext not down by more than 0.02. A proxy
(updateCorrect) number is never cited without judge confirmation.

## Decision

- G0 FAIL → park confidence-aware serving; record the flat ceiling.
- G0 PASS + judge-confirmed → the ceiling lift and the G1 p* justify, as
  separate later decisions, a src confidence-ranking dial and the RaState attach.
- Ceiling height is NOT a citable product number (it leaks the label by
  construction); only the existence of lift and the degradation slope are cited.
