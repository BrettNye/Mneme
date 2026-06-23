# Confidence-aware serving — efficacy protocol (pre-registered 2026-06-22)

**Status:** Pre-registered before the run. Gates frozen here; measured numbers
live only in `bench/RESULTS.md` under `### conf-serving: <slot> (YYYY-MM-DD)`
anchors (slots: `ceiling`, `degradation`, `judge confirm`).
**Spec:** docs/superpowers/specs/2026-06-22-confidence-aware-serving-design.md

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
