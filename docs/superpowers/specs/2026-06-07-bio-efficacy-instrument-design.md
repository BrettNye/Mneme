# Bio efficacy instrument v1 — pre-registered protocol + arm-P harness

**Date:** 2026-06-07
**Status:** Approved; amended per dual audit (fact audit + principles audit, both 2026-06-07)
**Scope:** One protocol document + one deterministic bench harness. NO bio mechanism
code, NO substrate changes, NO production dial changes, dogfood corpus untouched.
**Depends on:** PR #26 (C7 fix) — `betaFromRaw` over surface-created corpora with
declared pseudocounts. Branch `bench/bio-efficacy-instrument` (carries the C7 commits).

## Problem

The bio layer's next mechanisms (scalar→Beta promotion at the substrate boundary,
batch-ratifier dream) have three measured justifications but no pre-registered
success criteria. Building first and measuring after invites post-hoc rationalization
— the dogfood protocol established the discipline: register metrics, thresholds, AND
consequences before the mechanism exists. C7 is fixed, so the pooling measurement is
now possible with substrate-only machinery: the harness promotes at import time by
writing `Confidence` objects computed via `betaFromRaw` into the
`WriteRecord.confidence` slot (surface-supported, unused by the existing bench
mapper), and folds via the exported beta binding. Nothing requires bio to exist —
that is the point.

## Ratified decisions

1. **Arms in v1:** pooling/promotion (arm P) + dream-ratification (arm D).
   Decay/ICEWS14 and longitudinal arm-C are instrument v2.
2. **Arm-P ship-gate:** three tiers — hard property (P0), primary separation metric
   (P1), headline guardrail (P2) — plus a pre-registered decision rule.
3. **Shape:** protocol doc + arm-P harness. Arm D is doc-pinned; no new dream code.
4. **Audit-amended measurement path (CRITICAL fact-audit finding):** the read
   pipeline does NOT surface pooled confidence — `combinedConfidences` is internal
   to `clustersOf` and discarded by `pairsOf`/`resolveDeprecateOlder`, and consensus
   (same-value) groups never form clusters at all (`contradiction.ts:74`,
   by design per the v1 read-time-contradiction spec). Therefore the instrument
   computes pooling **harness-side** via the exported operators
   (`bindingFor("beta").combine(RULE.EVIDENCE_POOLED, …)`) — zero new equations,
   composition-first. `evidencePoolingRule` on the read path is inert for serving
   under Beta corpora and is passed only for config fidelity.

## Deliverable 1 — protocol document

`docs/bio/2026-06-07-bio-efficacy-protocol.md`, dogfood-protocol style. Content:

### Arm P — pooling/promotion gate

Falsifiable question: *"Does Beta-promoted, evidence-pooled confidence carry usable
information that scalar/MAX_MEAN confidence does not?"*

- **P0 (hard property, binary, exact):** for two same-value claims with scalar raw
  0.8 promoted at pseudocount 2 under the default prior:
  - inputs are Beta(2.6, 1.4) each (mean 0.65, concentration 4.0);
  - the `EVIDENCE_POOLED` fold yields **the exact float64 values of the substrate's
    own fold expressions**: α = 4.2 exactly; β = `1.4 + 1.4 − 1` =
    1.7999999999999998 (1 ulp below the rational target 9/5). "Exact" is
    registered as exact float64 determinism of the pinned expressions — the
    rational targets (21/5, 9/5; below-prior 11/5, 19/5) are the analytic
    derivation, the float64 pins are the executable property (plan-audit
    finding: asserting rational 1.8 ships a red test);
  - below-prior case raw 0.3: inputs Beta(1.6, 2.4) (mean 0.40) pool to **exactly
    Beta(2.2, 3.8)** (mean ≈0.3667) with the **bracketing invariant**
    `raw < pooledMean < inputMean` (strict both ends) — pooling moves the mean
    monotonically from the single-input mean toward the shared raw value, never
    past it; corroborating weak evidence does not inflate it;
  - concentration strictly increases in both cases.
  Assertion path: **binding-level fold** (not the recall result), plus one
  `clustersOf` assertion with a contrived *contested* cluster (third claim,
  different value) verifying the in-substrate fold matches the binding-level fold.
- **P1 (primary, graded, cross-fit):** signal = the harness-side `EVIDENCE_POOLED`
  fold over the top-ranked claim's group of post-pipeline surviving claims keyed by
  `(subject, canonical(key) via the ratified alias map, valueHash)`. Registered
  corollary (fact-audited): extraction emits no confidence, so every oracle claim
  carries scalar **exactly 1.0** (surface default) → within a config all promoted
  Betas are identical → **P1 separation can come only from corroboration counts.**
  The scalar/MAX_MEAN baseline row is a constant — perfectly uninformative — and is
  measured first as the registered "before."
  Methodology (reframed per principles audit — the single-fold holdout had ~6
  residual-class positives and was decidable by one observation):
  - **Cross-fit:** keep the deterministic sha256 question-id split, run both folds
    (choose threshold on A, evaluate on B; swap; pool held-out predictions). Every
    abstention question is evaluated held-out exactly once → 30 positives
    (~12–16 residual-class), ~199 answerable negatives.
  - **Gates in counts:** pooled signal flags **≥4 residual-class abstentions** across
    pooled held-out folds; precision ≥ 62.5% (FP ≤ ⌊0.6·TP⌋); total false
    abstentions ≤ 9/199 (≤5%; denominator = ALL answerable held-out questions,
    matching the deep-dive convention).
  - **Primary comparison is paired:** pooled must strictly dominate the
    scalar/MAX_MEAN baseline on the same held-out questions
    (TP_pooled > TP_scalar at FP_pooled ≤ FP_scalar); the absolute bars above are
    the secondary condition.
  - **Evaluability floor:** if the pooled signal flags <4 questions total, the
    outcome is **UNDERPOWERED** — treated as P1-fail for the promotion decision,
    recorded as distinct from a measured negative.
  - Small-n caveat verbatim from the deep-dive: evidence of SIGNAL QUALITY, not a
    production dial — knobs stay off.
- **P2 (guardrail, exact):** citable headline at **exact equality, 3-decimal
  precision** (the recorded table precision): KU updateCorrect 0.556, recall@3
  0.931, recall@10 0.979, enforced via the `--expect-*` abort convention. Any
  deviation in either direction is a P2 finding; an improvement is reported but
  does not pass the gate as registered (it means promoted serving changed the
  answer set — investigate before promotion) and never rescues a P1 failure.
  Registered expectation: P2 passes trivially w.r.t. pooling itself (pooled
  confidence never affects serving — decision 4); it guards promotion's side
  effects through ⊕_dedupe and confidence thresholds, which is worth one run.
- **Dial sweep (calibration question, not a gate):** pseudocount magnitude
  ∈ {2, 5, 10}. Fact-audited source note: oracle claims are written single-source
  — the template session uses `source: "imported"` (NOT llm; A.1 imported = llm
  = 2, so the flat-2/A.1 collapse holds either way). The harness MUST pin one
  source-string constant used in **three places**: the session/write source, the
  `scalarPseudocount` override key, and the `betaFromRaw` source argument — a
  mismatch is a silent no-op. Registered question: does P1 separation move with
  pseudocount, and in which direction? (pc→0 collapses to prior-only,
  analytically known.)

### Arm D — dream-ratification baseline pin

Falsifiable question: *"When the bio batch-ratifier dream attaches, does it
reproduce the measured ratification value through the auditable write path?"*

- **Inline pins (gate numbers ONLY — these define the reproduction gate):** citable
  KU updateCorrect **0.556**, recall@3 **0.931**, recall@10 **0.979**; full-band
  **0.528** (citable only with the judge caveat).
- **Anchor-linked, never copied:** lift decomposition, alias counts, and the
  per-band judge **agreement** table (75% at 0.98+, 100% at 0.96–0.98, 86% at
  0.94–0.96, 36% at 0.92–0.94 — RESULTS.md's verbatim figures; the earlier
  "95%→17% band precision" figure has NO committed provenance and is dropped from
  registration) — referenced by RESULTS.md dated-heading anchor.
- **Reproduction gate:** a capstone-style run through bio's gateway/ledger must
  reproduce the citable numbers exactly, as the in-process capstone did. Judge port
  follows the EmbeddingAdapter precedent (seam when bio attaches, one adapter).
- **Methodology note (standing):** judge → human-validate → compile-to-rules →
  shrink. Rule-layer measurement DEFERRED (normalization holds until window review
  ~2026-06-20; this protocol must not contaminate that hold).

### Decision rule (pre-registered)

- **P0 fail** → instrument invalid (substrate bug); no P1/P2 reading counts; fix
  before re-run.
- **P0 ∧ P1 ∧ P2 pass** → promotion slice may proceed (knobs stay off; these
  numbers are its justification).
- **P1 fail (including UNDERPOWERED)** → promotion slice does NOT proceed; the
  residual abstention class remains coverage-annotation-only; the negative result
  is recorded in RESULTS.md and the measured justification for substrate-boundary
  promotion is withdrawn pending new evidence (e.g. a larger abstention set) — not
  a reworked metric.
- **P2 fail** → EVIDENCE_POOLED-adjacent serving changes are blocked regardless of
  P1; pooling remains read-time-experimental.
- Sweep results never gate; any metric added after the first oracle run is labeled
  exploratory.

### Ownership (protocol hygiene section)

**bench/RESULTS.md is the sole home of measured numbers** (append-only run log).
The protocol owns gates, thresholds, the decision rule, and PASS/FAIL verdicts; its
evidence sections record verdicts plus links to RESULTS.md dated anchors, never
re-stated tables. This spec is frozen at approval and is not updated with results.

### Protocol out-of-scope

Decay/ICEWS14 arm (v2 — imported, no QA loop), longitudinal arm-C (v2), the
promotion mechanism itself, production dial changes, dogfood-corpus measurements,
rule-layer shrink (held), **the MCP-recall scalar-rule follow-up** (open on the
board), **band-widening ≥0.85** (~$14, GTM-gated).

## Deliverable 2 — arm-P harness

`bench/longmemeval/manual/pooling-efficacy.ts` (+ `pooling-efficacy.test.ts`).
Modeled on **two** templates: `abstention-signals.ts` for the P1 signal machinery
(CLI shape, citable config, coverage/residual classification) and
`key-matching-sweep.ts` for the P2 scoring path (`answerArmA` — which already
accepts `evidencePoolingRule` — plus `scoreQuestion`/`aggregate` and the
`--expect-*` abort convention).

```
npx tsx bench/longmemeval/manual/pooling-efficacy.ts \
  --file <oracle_target.json> --claims <oracle-claims.jsonl> \
  --ratified <judgments-min094.jsonl> [--pseudocounts 2,5,10]
```

- **Ingest (fact-audited divergence from the template, named):** reuses
  `claimsFor`/`corpusIdFor` and the conservation discipline, but
  `ingestQuestion` gains an optional hook — `{ mapRecord?, scalarPseudocount? }` —
  so the harness can (a) create corpora with the sweep's pseudocount override and
  (b) promote each record via `betaFromRaw(rec.confidence ?? 1, SOURCE, schema)`
  into the `WriteRecord.confidence: Confidence` slot. Extension, not fork: the
  `AlreadyIngestedError`/`IngestConservationError` guards stay load-bearing.
- **Sweep mechanics:** one tmp DB (`mkdtempSync` + finally-`rmSync`) **per sweep
  point** (satisfies the `AlreadyIngestedError` contract); a single process for the
  whole sweep sharing one `EmbeddingCache` + one `warmEmbeddings` pass, so rankings
  are bit-identical across configs and **P1 deltas are attributable to confidence
  alone** — this attribution argument is stated in the protocol.
- **Hoisted shared helpers (DRY, principles audit):**
  - `loadRatifiedPairs(path): Set<string>` + `pairKey` hoisted into
    `manual/key-alias-auto.ts` (it owns `autoRatify`; the parser block is at copy
    #5 and is judgment-bearing). Migrating the four existing call sites is optional
    follow-up, NOT this slice.
  - The deterministic split `isTrain(questionId)` + cross-fit iteration hoisted
    into a new `manual/holdout.ts`, imported by `pooling-efficacy.ts`; the protocol
    cites the helper as the split definition. Existing scripts keep their inline
    copies (snapshot convention).
- **Signals per question:** harness-side pooled top-1 confidence (decision 4
  grouping); scalar/MAX_MEAN top-1 confidence (baseline row). Residual-class
  membership from `coverageOf` (entityCoverage does not flag AND question is
  abstention-labeled).
- **Property test (`pooling-efficacy.test.ts`):** CI-safe, fixture-scale,
  deterministic. MUST NOT import `embeddings-local.ts` statically or transitively —
  alias maps supplied as literals (makes no-model-download structural). Asserts P0
  exactly: binding-level fold params (4.2/1.8; 2.2/3.8), bracketing invariant,
  concentration increase, plus the contrived contested-cluster `clustersOf`
  assertion.
- **Smoke (committed, mandatory — the fixture cannot exercise the residual class):**
  the committed fixture's abstention question has zero oracle claims and its entity
  is absent (entityCoverage flags it → not residual). The harness smoke therefore
  includes a synthetic residual-class case: an abstention-labeled question whose
  entity tokens appear in claims but whose attribute is missing. Exits nonzero on
  any integrity failure (bench convention).
- **Output:** per-sweep-point markdown table (P1 cross-fit counts
  TP/FP/precision/false-abstention for pooled and baseline; P2 headline row; P0
  status) appended to `bench/RESULTS.md`; protocol evidence section links the
  dated anchor.

## Constraints honored

- Substrate LLM-free; harness deterministic; judge artifacts are committed data.
- Composition-first: `betaFromRaw` + `bindingFor("beta").combine(RULE.EVIDENCE_POOLED)`
  + `DetectionOptions.keyAliases` + `CorpusSpec.scalarPseudocount` — zero new
  equations; one shared-module extension (`ingestQuestion` optional hook).
- Dogfood window untouched; held normalization slices not exercised.

## Testing

1. P0 property test green (CI, all assertions above, no embeddings import).
2. Harness smoke: fixture + synthetic residual-class case, network-free, exits
   nonzero on integrity failure.
3. Full suite + tsc green (baseline 1,672 — audit-verified on this branch).
4. Oracle-scale run executed once before PR; results in `bench/RESULTS.md`;
   protocol evidence section links the anchor; protocol verdicts filled
   (PASS/FAIL/UNDERPOWERED per gate).

## Out of scope

| Item | Disposition |
|---|---|
| Scalar→Beta promotion mechanism (production write path / bio attach) | Next slice, gated via the pre-registered decision rule. |
| Decay/ICEWS14 arm, longitudinal arm-C | Instrument v2. |
| Arm-D harness motion | Deferred until bio attaches. |
| Production `evidencePoolingRule`/pseudocount defaults; MCP-recall scalar-rule follow-up; band-widening ≥0.85 | Unchanged/held; knobs-off until calibrated. |
| Rule-layer shrink measurement | Held with normalization until window review. |
| Migrating the 4 existing `loadRatifiedPairs` call sites | Optional follow-up. |

**Carried-forward obligation (promotion slice):** the pseudocount map consumed at
promotion time must be stamped into derivation provenance for replay determinism
(from the C7 spec; verify, never assume).
