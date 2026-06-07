# Bio efficacy instrument v1 — pre-registered protocol + arm-P harness

**Date:** 2026-06-07
**Status:** Approved (founder-ratified arms, gates, and shape)
**Scope:** One protocol document + one deterministic bench harness. NO bio mechanism
code, NO substrate changes, NO production dial changes, dogfood corpus untouched.
**Depends on:** PR #26 (C7 fix) — `betaFromRaw` over surface-created corpora with
declared pseudocounts. Branch from `fix/c7-scalar-pseudocount` or start after merge.

## Problem

The bio layer's next mechanisms (scalar→Beta promotion at the substrate boundary,
batch-ratifier dream) have three measured justifications but no pre-registered
success criteria. Building first and measuring after invites post-hoc rationalization
— the dogfood protocol (docs/dogfood/2026-06-06-dogfood-protocol.md) established the
discipline: register the metrics, thresholds, and falsification framing BEFORE the
mechanism exists. C7 is fixed (PR #26), so the pooling measurement is now possible
with substrate-only machinery: `betaFromRaw` promotes at write time,
`RULE.EVIDENCE_POOLED` pools at read time. Nothing about the instrument requires bio
to exist — that is the point.

## Ratified decisions

1. **Arms in v1:** pooling/promotion (arm P) + dream-ratification (arm D).
   Decay/ICEWS14 and longitudinal arm-C are instrument v2 — named in the protocol's
   out-of-scope section with their testbeds, not specced.
2. **Arm-P ship-gate:** three tiers — hard property (P0), primary separation metric
   (P1), headline guardrail (P2). All three pre-registered with thresholds.
3. **Shape:** protocol doc + arm-P harness. Arm D is doc-pinned (baseline numbers +
   reproduction gate); no new dream code, no arm-D harness motion.

## Deliverable 1 — protocol document

`docs/bio/2026-06-07-bio-efficacy-protocol.md`, structured like the dogfood protocol
(pre-registration header, scope, falsifiable questions with named evidence sources,
out-of-scope). Content requirements:

### Arm P — pooling/promotion gate

Falsifiable question: *"Does Beta-promoted, evidence-pooled confidence carry usable
information that scalar/MAX_MEAN confidence does not?"*

- **P0 (hard property, binary):** for two same-value claims under drifted keys with
  a ratified alias and scalar raw 0.8 promoted via `betaFromRaw` — the
  `EVIDENCE_POOLED` fold yields (a) pooled mean **strictly greater** than either
  input's mean, (b) pooled concentration (α+β) **strictly greater** than either
  input's, and (c) **deterministic** parameters: byte-identical across repeated
  evaluation and across session re-open. Stated for agreeing above-prior inputs;
  the protocol notes the below-prior direction (pooling moves mean toward the
  shared raw value — corroborating weak evidence correctly does NOT inflate it).
- **P1 (primary, graded):** on the oracle question set (N=229, citable config:
  validated aliases ≥0.94 + hybrid ranking), the pooled-Beta confidence of the
  top-ranked claim, used as a refusal signal on the **residual abstention class**
  (abstention questions where entityCoverage does NOT flag — entities present,
  attribute missing), must achieve **flag precision ≥ 62.5%** (the entityCoverage
  bar) at **false-abstention rate ≤ 5%** on holdout, using the deep-dive's exact
  train/holdout methodology (19/11 abstention split, threshold chosen on train,
  one-shot holdout evaluation, small-n caveat verbatim: evidence of SIGNAL QUALITY,
  not a production dial — knobs stay off).
  **Baseline row measured first:** the same signal computed from scalar/MAX_MEAN
  confidence — pre-registered expectation: near-uninformative (scalar confidences
  are degenerate ~1.0 from extraction; this is the "before" the promotion slice
  must beat).
- **P2 (guardrail):** the citable headline is unchanged under EVIDENCE_POOLED
  serving: KU updateCorrect 0.556, recall@3 0.931, recall@10 0.979. Any regression
  fails the gate regardless of P1.
- **Dial sweep (calibration question, not a gate):** pseudocount magnitude
  ∈ {2, 5, 10} for the corpus's source mix. NOTE (measured at design time): oracle
  claims are single-source (`llm`), so "flat-2 vs A.1 tiers" collapses (A.1 llm = 2)
  — the sweep varies magnitude via the `CorpusSpec.scalarPseudocount` override
  (three imports, three configs). Pre-registered question: does the P1 separation
  move with pseudocount, and in which direction?

### Arm D — dream-ratification baseline pin

Falsifiable question: *"When the bio batch-ratifier dream attaches, does it
reproduce the measured ratification value through the auditable write path?"*

- **Pinned baseline table** (from bench/RESULTS.md + the 2026-06-07 journal,
  numbers copied verbatim with provenance): citable 0.556 updateCorrect (+15.3pp,
  1.67× naive; ratified ≥0.94 human-validated + hybrid), recall@3 0.931 / recall@10
  0.979 (both above baseline), full-band 0.528 (cite only with judge caveat), band
  precision 95%→17% across 0.98→0.92, judge human-validation status per band
  (validated ≥0.94; FAILED 0.92–0.94 at 36% agreement).
- **Reproduction gate:** a capstone-style run through bio's gateway/ledger (dream →
  ratifications as ledger writes → recall through product surfaces) must reproduce
  the citable numbers **exactly**, as the in-process capstone did (0.556, all
  recall@k identical). Judge port follows the EmbeddingAdapter precedent: define
  the seam when bio attaches, ship one adapter.
- **Methodology note (standing):** judge → human-validate → compile-to-rules →
  shrink-judgment-surface is the dream development loop. Rule-layer measurement is
  explicitly DEFERRED — the normalization slices are held until the dogfood window
  review (~2026-06-20) and the protocol must not contaminate that hold.

### Protocol hygiene

- Pre-registration statement: thresholds and signals fixed before the promotion
  mechanism exists; any post-hoc metric addition must be labeled exploratory.
- Out-of-scope: decay/ICEWS14 arm (v2 — testbed imported, no QA loop), longitudinal
  arm-C (v2), the promotion mechanism itself (next slice, gated on these numbers),
  production dial changes, dogfood-corpus measurements.

## Deliverable 2 — arm-P harness

`bench/longmemeval/manual/pooling-efficacy.ts` (+ `pooling-efficacy.test.ts`),
modeled directly on `abstention-signals.ts` (same CLI shape, ingest path, citable
config, train/holdout discipline):

```
npx tsx bench/longmemeval/manual/pooling-efficacy.ts \
  --file <oracle_target.json> --claims <oracle-claims.jsonl> \
  --ratified <judgments-min094.jsonl> [--pseudocounts 2,5,10]
```

- **Import-time promotion:** claims are written with Beta confidence computed via
  `betaFromRaw(raw, source, schema)` from the per-config corpus schema
  (`CorpusSpec.scalarPseudocount` override per sweep point). Zero new operators;
  the read path passes `evidencePoolingRule: RULE.EVIDENCE_POOLED` (valid because
  all confidences are Beta post-promotion). The scalar/MAX_MEAN baseline row runs
  the existing path unchanged.
- **Signals computed per question:** pooled top-1 confidence mean (primary);
  scalar/MAX_MEAN top-1 confidence (baseline row). Residual-class membership from
  `coverageOf` (entityCoverage does not flag AND question is abstention-labeled).
- **Output:** markdown table (per-sweep-point: P1 precision/false-abstention on
  train and holdout; P2 headline row; P0 property status) appended to the run log
  and summarized into `bench/RESULTS.md` per bench conventions.
- **Property test (`pooling-efficacy.test.ts`):** CI-safe, fixture-scale,
  deterministic, no network/LLM, no oracle data dependency — builds a tmp corpus,
  writes two same-value drifted-key claims (raw 0.8, promoted), ratifies the alias,
  asserts P0 (a)(b)(c). Also one below-prior case (raw 0.3: pooled mean moves DOWN
  toward 0.3 — documents the direction honestly).
- **Determinism:** the harness is fully deterministic given the cached embedding
  store (same discipline as abstention-signals.ts); no LLM calls anywhere.

## Constraints honored

- Substrate LLM-free; harness deterministic; judge artifacts are committed data
  (`bench/longmemeval/manual/data/key-ratify-judgments*.jsonl`).
- Composition-first: existing `betaFromRaw` + `RULE.EVIDENCE_POOLED` +
  `DetectionOptions.evidencePoolingRule` + `CorpusSpec.scalarPseudocount` — zero
  new equations, zero substrate edits.
- Dogfood window: untouched (oracle corpora are bench tmp stores; no dial changes).
- Held normalization slices: not exercised, not measured.

## Testing

1. P0 property test green (CI, fixture-scale, all assertions above).
2. Harness smoke: runs end-to-end on the committed fixture dataset (or a minimal
   synthetic oracle subset) without network; exits nonzero on any integrity-check
   failure (bench convention).
3. Full suite + tsc green (baseline 1,672).
4. Oracle-scale run executed once before PR; results table lands in
   `bench/RESULTS.md` AND the protocol doc's evidence section links to it.

## Out of scope

| Item | Disposition |
|---|---|
| Scalar→Beta promotion mechanism (production write path / bio attach) | Next slice, gated on this instrument's numbers. |
| Decay/ICEWS14 arm, longitudinal arm-C | Instrument v2; named in protocol out-of-scope. |
| Arm-D harness motion (re-runnable entrypoint wrapper) | Deferred until bio attaches (ratified: ceremony until then). |
| Production `evidencePoolingRule`/pseudocount defaults | Unchanged; knobs-off until calibrated. |
| Rule-layer shrink measurement | Held with the normalization slices until window review. |

**Carried-forward obligation (promotion slice):** the pseudocount map consumed at
promotion time must be stamped into derivation provenance for replay determinism
(carried from the C7 spec; verify, never assume).
