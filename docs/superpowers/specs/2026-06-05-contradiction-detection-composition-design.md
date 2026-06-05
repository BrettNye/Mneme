# ⊥-detection composition: cardinality, floor, pipeline (design)

**Date:** 2026-06-05
**Status:** Approved design, pre-implementation
**Canonical spec:** `mneme-spec-v0.2-consolidated.md` — §3 (schema), §4.8 (`⊥` detection + resolution), §4.9 (`⊕_dedupe`), §3.3 (CorpusDefaults)
**Driven by:** the real-data collision taxonomy (bench/RESULTS.md + the 2026-06-05 manual re-extraction audit) and adversarial probes 1, 3, 6. Covers the formerly-separate "slice 2" (detection-floor split) and "slice 3" (cardinality-aware `⊥`) plus the pipeline-composition completion.

## Problem — one predicate doing five jobs

Today `⊥` detection is a single predicate (same subject+key, different value) feeding a
single resolver. Across 40 real-data collisions that predicate was forced to classify
five distinct relationships, and it can only handle one of them:

| Relationship | Real example | Correct behavior | Today |
|---|---|---|---|
| Supersession (fact changed) | PB 27:12 → 25:50 | latest wins | ✅ (the 1.0-vs-0.3 win) |
| Accumulation (both true) | `cooking_interest`: jerk seasoning AND basil | keep all | ❌ deprecates a true fact |
| Restatement (same fact reworded) | power bank "from Amazon" / "…Feb 13th" | merge, keep richest | ⚠ phantom contradiction |
| Genuine dispute (conflicting signals) | fresh p=0.4 vs stale p=1.0 (probe 6) | both contest; rule decides | ❌ floor hides challenger |
| Different referent (key collision) | `car_model`: Corolla vs Civic (different people) | scope separates | ❌ would cross-deprecate |

**Design principle (ratified): composition-first.** Prefer composing the existing
operators to express new semantics; introduce a new operator/equation only when no
composition can express it — and when one genuinely better equation exists, adopt it
rather than contorting a composition. Dialing return quality = tuning the composition
(stages, declarative inputs, per-corpus dials), not stacking special cases into one
predicate.

**Diagnosis (ratified in brainstorming): no new equations are needed.** The algebra
already contains the cooperating operators (`τ`, `⊕_dedupe`, `⊥`, `resolve*`,
`⊕_synthesize`). The losses come from (i) one missing declarative INPUT to detection
(per-key cardinality), (ii) one misplaced GATE (the confidence floor folded into
detection eligibility), and (iii) an incomplete read-pipeline COMPOSITION (our arm A
skipped `⊕_dedupe`). Different-referent collisions are an ingestion discipline
(populate `scope`), recorded as a note, not built here.

## Decisions made during brainstorming

1. **Cardinality declaration:** `ClaimSchema.keyCardinality?: Record<string, "single" | "multi">`
   — per-key map, sibling to the existing `valueSchemas` precedent. **Undeclared keys
   default to `"single"`** (today's behavior exactly; backwards compatible; the
   knowledge-update win is untouched). Rejected: flag-on-undeclared (adoption tax —
   correct supersessions become review queues); corpus-level default flip (one config
   mistake silently disables supersession wholesale).
2. **Floor split:** detection's confidence `threshold` becomes a documented
   **eligibility dial defaulting to 0** (everything contests).
   `CorpusDefaults.confidenceThreshold` (already declared in the catalog, currently
   unwired on the read path) becomes its source in the compile path. When recency and
   confidence point opposite ways, **the caller's resolution rule IS the policy**
   (`resolveDeprecateOlder` ⇒ fresh wins; `resolveDeprecateLower` ⇒ confident wins) —
   stated honestly rather than hidden by an eligibility gate. Rejected for now:
   conflicting-signal flagging and confidence-gated recency (new resolvers/dials —
   noted as future candidates).
3. **Cardinality transport — detection options parameter** (Approach A): `clustersOf` /
   `pairsOf` accept an optional options argument; detection stays pure, the caller
   supplies the map. Rejected: stamping cardinality on claims (denormalization, drift);
   post-detection filtering (wasted work; every consumer must remember to filter).
4. **`⊕_dedupe` composition included** (bench pipeline + spec note; no new src
   machinery — the operator exists and is compile-covered). Merge quality under
   jaccard is a measured dial, revisited in the similarity slice.
5. **Config surface exercised:** `keyCardinality` (schema), `confidenceThreshold`
   (CorpusDefaults) — both per-corpus dials, per the user's standing config-awareness
   note.

## Design

### 1. Schema — `keyCardinality` (src/catalog/schema.ts)

```ts
export interface ClaimSchema {
  // … existing fields …
  /** Per-key cardinality; undeclared keys are "single" (⊥ eligible). */
  keyCardinality?: Record<string, "single" | "multi">;
}
```

Plus a small exported helper `cardinalityOf(key: string, schema: ClaimSchema): "single" | "multi"`
(returns `"single"` when undeclared) so consumers never reimplement the default rule.

### 2. Detection — cardinality-aware, floor relocated (src/algebra/contradiction.ts)

```ts
export interface DetectionOptions {
  /** Keys mapped "multi" are excluded from cluster formation entirely. */
  keyCardinality?: Record<string, "single" | "multi">;
}

export function clustersOf(corpus: Corpus, threshold: number, opts?: DetectionOptions): ContradictionCluster[];
export const pairsOf = (corpus: Corpus, threshold: number, opts?: DetectionOptions): ContradictionPair[];
```

- Multi-valued keys never form clusters (accumulation is not conflict). Implemented at
  grouping time, not as a post-filter.
- `threshold` semantics re-documented: an **eligibility floor** — claims at or below
  it cannot contest. The recommended default is `0` (all contest); the parameter
  remains required at this layer (explicitness), with defaulting handled by callers.
- Backwards compatibility: `opts` omitted ⇒ identical behavior to today.

### 3. Compile path — corpus defaults wired (src/algebra/compile.ts + ast as needed)

The `resolve` AST node's threshold becomes optional-with-default: when the node
carries no explicit threshold, evaluation uses the corpus's
`defaults.confidenceThreshold`; the corpus schema's `keyCardinality` is passed as
`DetectionOptions` automatically. (How the evaluator accesses the corpus
definition — via EvalContext/catalog — is confirmed at plan time; if the context
lacks catalog access, the node carries the resolved values from the query builder
instead, preserving replay determinism either way. Serialized expressions must
remain replayable: whichever transport is chosen, the values that influenced
evaluation are recoverable at replay.)

### 4. Canonical read pipeline (bench arm A + spec note)

```
leaf → τ_valid(eval instant) → ⊕_dedupe(similarity, safe rule) →
⊥(keyCardinality, floor) → resolveDeprecateOlder → drop deprecated + flag artifacts →
rank → top-k
```

- Bench `answerArmA` adopts this composition. `⊕_dedupe` uses jaccard similarity and a
  safe idempotent combination rule (`rule_weighted_avg` per the bio-layer precedent —
  `evidence_pooled` stays unsafe until §5.6 observation dedup).
- The bench supplies a small `keyCardinality` map for the manual-sample corpus
  (declaring the known additive keys: `cooking_interest`, `work_tasks`, `activity`,
  `sculpture_materials_interest`, `next_trip_plan`, `occupation_activity`) —
  exercising the config surface end-to-end.
- The composition is documented in the canonical spec as the recommended read-side
  ordering so consumers don't repeat the subset mistake.

### 5. Spec amendments (mneme-spec-v0.2-consolidated.md)

- §3 schema: `keyCardinality` field + undeclared-default rule + rationale
  (accumulation ≠ conflict; cardinality is domain knowledge, declared not inferred).
- §4.8: detection eligibility semantics (floor = eligibility dial, default-all-contest;
  policy lives in resolution rules), multi-valued exemption, and the canonical
  pipeline composition note (`⊕_dedupe` before `⊥`).
- Surgical inserts matching surrounding style, same discipline as the
  resolve_deprecate_older amendment.

### 6. Explicitly untouched

- Write path (`src/write/contradiction.ts:enforce()`) — independent policy logic;
  future write-side cardinality/floor support is its own slice (coupling noted).
- `⊕`/§4.9 semantics, cluster resolvers, scope machinery.
- Ingest-side scope population for different-referent protection — recorded as a
  requirement note for the MCP/dogfooding ingest path, not built here.

## Error handling

- `keyCardinality` with values outside "single"/"multi" is rejected at schema
  validation (zod), mirroring strict-scope discipline.
- `DetectionOptions` omitted everywhere ⇒ byte-identical behavior to current.

## Measurement (acceptance evidence)

- Probe 1 (additive hobbies): with `hobby: "multi"` declared, arm A keeps both — fixed.
- Probe 6 (confidence floor): with floor 0, the Pixel contests; `resolveDeprecateOlder`
  resolves to the fresh claim — the rule's stated policy, no longer hidden.
- Probe 3 (paraphrase): `⊕_dedupe` merges NYC/“New York City”-class restatements
  before `⊥` (quality measured, perfection not required — similarity slice follows).
- Manual benchmark re-run with the bench cardinality map: KU `updateCorrect` stays
  high (≥0.9); arm A recall@3 recovers from 0.7 toward ≥0.9 (additive keys no longer
  suppressed). Fixture e2e + full suite green.

## Testing (TDD)

- schema: `cardinalityOf` default/declared/invalid-value cases.
- contradiction: multi key never clusters/pairs (incl. mixed corpora where a multi key
  coexists with single keys); threshold 0 admits low-confidence claims (probe-6 shape);
  `opts` omitted ⇒ existing tests pass unchanged.
- compile: resolve node without threshold uses `CorpusDefaults.confidenceThreshold`;
  with explicit threshold, explicit wins; keyCardinality flows through; replay
  round-trip remains deterministic.
- bench: arm A pipeline with dedupe stage + cardinality map; probe re-runs (1, 3, 6);
  manual benchmark regression; `eval:lme:fixture` exit 0.

## Explicitly out of scope (deliberately deferred)

- Similarity-tolerant key matching + embedding `SimilarityFn` (the key-drift slice).
- Conflicting-signal flag-for-review resolver; confidence-gated recency variants.
- Write-time cardinality/floor enforcement.
- §5.6 observation-level dedup (unchanged status; `evidence_pooled` stays opt-in).
