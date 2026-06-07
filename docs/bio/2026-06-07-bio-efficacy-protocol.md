# Bio efficacy protocol — pre-registered 2026-06-07

**Status:** Pre-registered (pending oracle run)
**Date:** 2026-06-07
**Derived from:** `docs/superpowers/specs/2026-06-07-bio-efficacy-instrument-design.md` (approved; amended per dual audit 2026-06-07)

---

## Scope

This document pre-registers the success gates, thresholds, decision rule, and consequences for the bio-layer pooling/promotion arm (arm P) and the dream-ratification baseline arm (arm D). Gates and verdicts are fixed before the oracle run. Measured numbers live exclusively in `bench/RESULTS.md` (append-only run log); this protocol records verdicts and anchor links — never copied tables.

**Split definition:** the deterministic sha256 question-id split is implemented in `bench/longmemeval/manual/holdout.ts` (`isTrain`). Every abstention question is evaluated held-out exactly once across the two cross-fit folds.

**Verdict fill format:** each `PENDING` slot is replaced with the single token
**PASS**, **FAIL**, or **UNDERPOWERED** (P1 only), followed by one sentence naming
the decision-rule branch applied. **Evidence anchor format (binding):** each
evidence link resolves to a RESULTS.md heading of exactly the form
`### bio-efficacy: <slot> (YYYY-MM-DD)` where `<slot>` ∈
{`P1 cross-fit`, `P2 headline`, `dial sweep`, `arm D`} — the runner MUST use these
heading strings so the links compile the day the anchors are created.

---

## Arm P — pooling/promotion gate

**Falsifiable question:** "Does Beta-promoted, evidence-pooled confidence carry usable information that scalar/MAX_MEAN confidence does not?"

### P0 — hard property (binary, exact)

For two same-value claims with scalar raw 0.8 promoted at pseudocount 2 under the default prior:

- Inputs are Beta(2.6, 1.4) each (mean 0.65, concentration 4.0).
- The `EVIDENCE_POOLED` fold yields the exact float64 values of the substrate's own fold expressions: α = 4.2 exactly; β = 1.7999999999999998 (1 ulp below the rational target 9/5).

> **Registered float64 footnote:** "Exact" means exact float64 determinism of the pinned expressions. The rational targets (21/5, 9/5 for the above-prior case; 11/5, 19/5 for the below-prior case) are the analytic derivation. The float64 pins are the executable property — asserting rational 1.8 ships a red test.

- Below-prior case, raw 0.3: inputs Beta(1.6, 2.4) (mean 0.40) pool to exactly Beta(2.2, 3.8) (mean ≈0.3667).
- **Bracketing invariant:** `raw < pooledMean < inputMean` (strict both ends) — pooling moves the mean monotonically from the single-input mean toward the shared raw value, never past it; corroborating weak evidence does not inflate it.
- Concentration strictly increases in both cases.

**Assertion path:** binding-level fold (not the recall result), plus one `clustersOf` assertion with a contrived contested cluster (third claim, different value) verifying the in-substrate fold matches the binding-level fold.

**Verdict:** PENDING — filled by the oracle run

---

### P1 — primary signal gate (graded, cross-fit)

**Signal:** harness-side `EVIDENCE_POOLED` fold over the top-ranked claim's group of post-pipeline surviving claims keyed by `(subject, canonical(key) via the ratified alias map, valueHash)`.

**Registered corollary:** extraction emits no confidence, so every oracle claim carries scalar exactly 1.0 (surface default). Within a config all promoted Betas are identical. P1 separation can therefore come only from corroboration counts. The scalar/MAX_MEAN baseline row is a constant — perfectly uninformative — and is measured first as the registered "before."

**Methodology — cross-fit:** keep the deterministic sha256 question-id split (`bench/longmemeval/manual/holdout.ts` `isTrain`), run both folds (choose threshold on A, evaluate on B; swap; pool held-out predictions). Every abstention question is evaluated held-out exactly once — 30 positives (~12–16 residual-class), ~199 answerable negatives.

**Attribution argument:** the harness runs a single process for the whole sweep sharing one `EmbeddingCache` and one `warmEmbeddings` pass, so rankings are bit-identical across configs. P1 deltas are therefore attributable to confidence alone, not re-ranking.

**Gates (in counts):**

- Pooled signal flags **≥4 residual-class abstentions** across pooled held-out folds.
- Precision ≥ 62.5% (FP ≤ ⌊0.6·TP⌋).
- Total false abstentions ≤ 9/199 (≤5%; denominator = ALL answerable held-out questions, matching the deep-dive convention).
- **Primary comparison is paired:** pooled must strictly dominate the scalar/MAX_MEAN baseline on the same held-out questions (TP_pooled > TP_scalar at FP_pooled ≤ FP_scalar); the absolute bars above are the secondary condition.
- **Evaluability floor:** if the pooled signal flags fewer than 4 questions total, the outcome is **UNDERPOWERED** — treated as P1-fail for the promotion decision, recorded as distinct from a measured negative.

Small-n caveat: evidence of signal quality, not a production dial — knobs stay off.

**Verdict:** PENDING — filled by the oracle run

Evidence link: see `bench/RESULTS.md` [#bio-p1-cross-fit dated anchor — filled after oracle run]

---

### P2 — headline guardrail (exact, 3-decimal)

**Citable headline at exact equality, 3-decimal precision** (the recorded table precision) enforced via the `--expect-*` abort convention:

- KU updateCorrect: **0.556**
- recall@3: **0.931**
- recall@10: **0.979**

Any deviation in either direction is a P2 finding. An improvement is reported but does not pass the gate as registered — it means promoted serving changed the answer set and must be investigated before promotion. An improvement never rescues a P1 failure.

**Registered expectation:** P2 passes trivially with respect to pooling itself (pooled confidence never affects serving — decision 4). It guards promotion's side effects through ⊕_dedupe and confidence thresholds, which is worth one run.

**Verdict:** PENDING — filled by the oracle run

Evidence link: see `bench/RESULTS.md` [#bio-p2-headline dated anchor — filled after oracle run]

---

### Dial sweep — calibration question (not a gate)

**Pseudocount magnitude ∈ {2, 5, 10}.**

**Source note:** oracle claims are written single-source — the template session uses `source: "imported"` (not `"llm"`; A.1 imported = llm = 2, so the flat-2/A.1 collapse holds either way). The harness pins one source-string constant used in three places: the session/write source, the `scalarPseudocount` override key, and the `betaFromRaw` source argument. A mismatch is a silent no-op.

**Registered question:** does P1 separation move with pseudocount, and in which direction? (pc→0 collapses to prior-only, analytically known.)

Sweep results never gate. Any metric added after the first oracle run is labeled exploratory.

**Result:** PENDING — filled by the oracle run

Evidence link: see `bench/RESULTS.md` [#bio-dial-sweep dated anchor — filled after oracle run]

---

## Arm D — dream-ratification baseline pin

**Falsifiable question:** "When the bio batch-ratifier dream attaches, does it reproduce the measured ratification value through the auditable write path?"

**Inline gate pins (reproduction gate):**

- KU updateCorrect: **0.556**
- recall@3: **0.931**
- recall@10: **0.979**
- Full-band: **0.528** (citable only with the judge caveat)

**Anchor-referenced, never copied:** lift decomposition, alias counts, and the per-band judge agreement table are referenced by the dated heading anchor in `bench/RESULTS.md`. The earlier "95%→17% band precision" figure has no committed provenance and is dropped from registration.

**Reproduction gate:** a capstone-style run through bio's gateway/ledger must reproduce the citable numbers exactly, as the in-process capstone did. **Binary:** any deviation in any pinned metric (exact, 3-decimal — the P2 convention) is a gate fail. Judge port follows the EmbeddingAdapter precedent (seam when bio attaches, one adapter).

**Methodology note (standing):** judge → human-validate → compile-to-rules → shrink. Rule-layer measurement is DEFERRED (normalization holds until window review ~2026-06-20; this protocol must not contaminate that hold).

**Verdict:** PENDING — filled by the oracle run

Evidence link: see `bench/RESULTS.md` [#bio-arm-d dated anchor — filled after oracle run]

---

## Decision rule (pre-registered)

- **P0 fail** — instrument invalid (substrate bug); no P1/P2 reading counts; fix before re-run.
- **P0 ∧ P1 ∧ P2 pass** — promotion slice may proceed (knobs stay off; these numbers are its justification).
- **P1 fail (including UNDERPOWERED)** — promotion slice does NOT proceed; the residual abstention class remains coverage-annotation-only; the negative result is recorded in RESULTS.md and the measured justification for substrate-boundary promotion is withdrawn pending new evidence (e.g. a larger abstention set) — not a reworked metric.
- **P2 fail** — EVIDENCE_POOLED-adjacent serving changes are blocked regardless of P1; pooling remains read-time-experimental.
- Sweep results never gate; any metric added after the first oracle run is labeled exploratory.

---

## Ownership

**bench/RESULTS.md is the sole home of measured numbers** (append-only run log). The protocol owns gates, thresholds, the decision rule, and PASS/FAIL verdicts; its evidence sections record verdicts plus links to RESULTS.md dated anchors, never re-stated tables. The spec (`docs/superpowers/specs/2026-06-07-bio-efficacy-instrument-design.md`) is frozen at approval and is not updated with results.

---

## Out of scope

- Decay/ICEWS14 arm (instrument v2 — imported, no QA loop)
- Longitudinal arm-C (instrument v2)
- The promotion mechanism itself (scalar→Beta production write path / bio attach) — next slice, gated via the pre-registered decision rule
- Production dial changes (`evidencePoolingRule`/pseudocount defaults)
- Dogfood-corpus measurements
- Rule-layer shrink (held until window review ~2026-06-20)
- The MCP-recall scalar-rule follow-up (open on the deficiency board)
- Band-widening ≥0.85 (~$14, GTM-gated)
- Arm-D harness motion (deferred until bio attaches)
- Migrating the four existing `loadRatifiedPairs` call sites (optional follow-up)
