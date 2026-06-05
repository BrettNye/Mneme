# ⊥-detection composition: cardinality, floor, dedupe, pipeline (design)

**Date:** 2026-06-05 (audited + amended same day — see "Audit amendments")
**Status:** Approved design, post-audit, pre-implementation
**Canonical spec:** `mneme-spec-v0.2-consolidated.md` (repo root) — §3 (schema), §4.8 (`⊥` detection + resolution), §4.9 (`⊕_dedupe`), §3.3 (CorpusDefaults)
**Driven by:** the real-data collision taxonomy (bench/RESULTS.md + the 2026-06-05 manual re-extraction audit) and adversarial probes 1, 3, 6. Covers the formerly-separate "slice 2" (detection-floor split) and "slice 3" (cardinality-aware `⊥`) plus the pipeline-composition completion and (post-audit) the similarity-partitioned `⊕_dedupe` merge mode.

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

**Diagnosis (ratified in brainstorming, refined by audit).** The algebra already
contains the cooperating operators (`τ`, `⊕_dedupe`, `⊥`, `resolve*`,
`⊕_synthesize`). The losses come from (i) one missing declarative INPUT to detection
(per-key cardinality), (ii) one misplaced GATE (the confidence floor folded into
detection eligibility), (iii) an incomplete read-pipeline COMPOSITION, and — found at
audit — (iv) one missing declarative DIAL on `⊕_dedupe` (value-similarity
sub-partitioning), without which the operator cannot sit before `⊥` at all (see
Audit amendment A1). No new operators are needed; (iv) is a new opt-in dial on an
existing operator, which the composition-first principle permits because no
composition of existing operators expresses "partition a triple-group by value
similarity". Different-referent collisions are an ingestion discipline (populate
`scope`), recorded as a note, not built here.

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
   noted as future candidates). *Audit note (finding #6): the surface layer already
   agrees — `session.createCorpus` defaults `confidenceThreshold: 0`
   (src/surface/session.ts:78), so no migration is needed for session-created corpora.*
3. **Cardinality transport — detection options parameter** (Approach A): `clustersOf` /
   `pairsOf` accept an optional options argument; detection stays pure, the caller
   supplies the map. Rejected: stamping cardinality on claims (denormalization, drift);
   post-detection filtering (wasted work; every consumer must remember to filter).
4. **`⊕_dedupe` composition included — REVISED AT AUDIT (amendment A1).** The
   brainstorm assumed the existing operator could sit before `⊥` ("no new src
   machinery"). The audit falsified that: `oplusDedupe` is value-blind — it merges
   every claim sharing `(subject, key, scopeHash)` into one claim regardless of value
   (src/algebra/combination.ts:20-26, conforming to canonical §4.9), so placed before
   `⊥` it would merge genuine contradictions (iPhone-vs-Pixel) into one claim and
   silently destroy the knowledge-update win. **Decision (user-ratified): build the
   similarity-partitioned merge mode now** — an opt-in dial on `⊕_dedupe`, not a new
   operator. See Design §3. Merge quality under jaccard is a measured dial; the
   embedding `SimilarityFn` stays deferred to the similarity slice.
5. **Config surface exercised:** `keyCardinality` (schema), `confidenceThreshold`
   (CorpusDefaults), dedupe similarity cutoff (pipeline dial) — per-corpus/per-query
   dials, per the user's standing config-awareness note.

## Audit amendments (2026-06-05, post-scan, user-approved)

The interconnectivity audit (5 parallel scanners + direct verification) produced
these binding refinements. Each is folded into the Design sections below; this list
is the changelog.

- **A1 (critical): `⊕_dedupe` as spec'd did not exist.** The operator has no
  similarity parameter and merges across different values (keeps `sorted[0]`'s value
  under `rule_weighted_avg`). Resolution: build similarity-partitioned merge mode
  (Design §3). Honest expectation reset: `simJaccard` tokenizes on word boundaries,
  so `"NYC"` vs `"New York City"` have **disjoint token sets → jaccard = 0** — probe
  3's exact case will NOT merge under jaccard and stays an expected-fail until the
  embedding slice; token-overlap restatements (the power-bank taxonomy row) DO merge.
- **A2 (critical): compile-path transport resolved — build-time stamping, not
  eval-time catalog reads.** `EvalContext` does carry `catalog`, but the resolve
  stage is `(c: Corpus) => Corpus` and `Corpus` carries no corpusId; more decisively,
  replay (src/write/replay.ts:147) re-evaluates the serialized expression, so
  eval-time catalog reads would make replay depend on *current* corpus defaults —
  breaking replay determinism. The house pattern bakes values into the AST
  (sigma/tau/kappa; ast.ts already stamps a builder default). Decision: the
  `mneme.derive` build path stamps defaults before compile+serialize (Design §4).
- **A3 (high): no zod validation of ClaimSchema exists.** `ClaimSchema` is a plain
  TS interface; schema discipline is manual helpers that throw (`validateScope`,
  src/catalog/schema.ts:21-29). `keyCardinality` value validation is a manual check
  in the same style, not zod.
- **A4 (high): `cardinalityOf` takes the map, not the schema.** Detection receives a
  raw `Record` via `DetectionOptions`; a schema-taking helper would force the algebra
  layer to reimplement the undeclared-default rule inline. Signature:
  `cardinalityOf(key: string, map?: Record<string, "single" | "multi">): "single" | "multi"`.
- **A5 (medium): `DEFAULT_RESOLVE_THRESHOLD = 0.5` (ast.ts:60) is removed.** The
  builder no longer silently stamps 0.5; `resolve()` leaves threshold undefined when
  not passed; the derive layer stamps the corpus default; `compile()` of a resolve
  node still lacking a threshold throws (explicitness). Existing tests pass explicit
  thresholds.
- **A6 (medium): surface default already 0** — see Decision 2 note.
- **A7 (medium, plan-check): serialization of new optional node fields.** Confirm at
  plan time whether `parseExpr` rejects unknown fields (whether serialize.ts needs an
  allowed-fields update for the new optional fields on `resolve`/`combine` nodes),
  and add replay round-trip tests for them. Because stamping happens before
  serialization, **the serialized resolve node always carries `threshold`** —
  `REQUIRED_FIELDS["resolve"]` stays unchanged and previously stored expressions
  replay byte-identically (no backward-compat hazard).
- **Conformance verdict:** every canonical-spec amendment in §6 is an ADDITION (or a
  clarification of ambiguous text), none is a behavioral CHANGE — except the §4.9
  dedupe amendment, which is an opt-in generalization (omitted ⇒ today's exact
  behavior). §3.3 already documents `confidenceThreshold` as "default confidence
  floor for queries", so read-path wiring fulfills its documented intent. The
  canonical spec lives at the repo root, not docs/.
- **Seams confirmed:** the resolution registry needs no changes; `clustersOf`/
  `pairsOf` are not exported from `src/index.ts` (no public-API commitment); the
  write path (src/write/contradiction.ts) does not call the detection functions —
  "write path untouched" holds.

## Design

### 1. Schema — `keyCardinality` (src/catalog/schema.ts)

```ts
export interface ClaimSchema {
  // … existing fields …
  /** Per-key cardinality; undeclared keys are "single" (⊥ eligible). */
  keyCardinality?: Record<string, "single" | "multi">;
}
```

Plus a small exported helper — **map-taking, per audit A4** — so every consumer
(detection, compile, bench, future write-side checks) applies the one default rule:

```ts
/** Undeclared keys are "single". Throws on values outside "single"|"multi". */
export function cardinalityOf(
  key: string,
  map?: Record<string, "single" | "multi">,
): "single" | "multi";
```

Invalid cardinality values are rejected by a manual check in the strict-scope style
of `validateScope` (throws; no zod — per audit A3).

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
  grouping time, not as a post-filter, via `cardinalityOf` (§1).
- `threshold` semantics re-documented: an **eligibility floor** — claims at or below
  it cannot contest (matches the existing `eff(claim) > threshold` check,
  contradiction.ts:25). The recommended default is `0` (all contest); the parameter
  remains required at this layer (explicitness), with defaulting handled by callers.
- Backwards compatibility: `opts` omitted ⇒ identical behavior to today.

### 3. `⊕_dedupe` — similarity-partitioned merge mode (src/algebra/combination.ts) **[new at audit]**

`oplusDedupe` gains an opt-in similarity mode:

```ts
export interface DedupeOptions {
  /** Sub-partition each (subject, key, scopeHash) group by value similarity before merging. */
  similarity?: { fn: string; cutoff: number }; // fn resolved via the existing similarity registry
}

export const oplusDedupe: (ruleId: string, params?: unknown, opts?: DedupeOptions) => (c: Corpus) => Corpus;
```

- **Omitted `opts` ⇒ byte-identical behavior to today** (whole-group merge, the
  coherent-corpus §4.10 use case is unaffected).
- With similarity configured: within each triple group, claims are clustered
  **single-link** (transitive closure over pairwise `score ≥ cutoff`); each
  sub-partition merges via the existing `combineGroup`; dissimilar values survive
  separately so `⊥` still sees genuine conflicts. This is what makes the operator
  safe *before* `⊥`.
- **Determinism:** claims are processed in lexicographic-id order before clustering,
  so sub-partitions are stable across runs.
- **Representative value (the "keep richest" rule, pinned — user-ratified):** the
  merged claim carries the value/identity of the member with the **latest
  `valid.from`** (lexicographic id tie-break, per house precedent); confidence is
  combined across the sub-partition by the configured rule (`rule_weighted_avg`).
- **Compile/replay parity:** the `combine` AST node gains the same optional
  similarity config as a serialized field, passed through by compile (exact node
  shape confirmed at plan time — audit A7). Optional + absent in old expressions ⇒
  no backward-compat impact.

### 4. Compile path — corpus defaults wired via build-time stamping (src/algebra/ast.ts + src/mneme.ts derive path) **[transport resolved at audit — A2]**

- The `resolve` AST node's `threshold` becomes **optional at the type/builder
  layer**: `ast.resolve()` no longer stamps `DEFAULT_RESOLVE_THRESHOLD = 0.5`
  (constant removed — audit A5) and leaves `threshold` undefined when not passed.
- **The derive build path does the defaulting:** before compile+serialize,
  `mneme.derive` walks the expression; for each resolve node lacking a threshold it
  resolves the leaf corpus beneath it and stamps `defaults.confidenceThreshold`, and
  stamps `schema.keyCardinality` onto the node (new optional field) so detection
  receives it as `DetectionOptions`. The stamped expression is what gets serialized
  into provenance — **replay re-evaluates exactly the values that influenced the
  original evaluation. Determinism preserved by construction.**
- `compile()` of a resolve node still lacking a threshold **throws** — direct
  builder users stay explicit; only the derive path auto-defaults.
- Serialized form: `threshold` always present (REQUIRED_FIELDS unchanged, old stored
  expressions unaffected); `keyCardinality` optional. Serializer allowed-fields check
  + replay round-trip tests per audit A7.

### 5. Canonical read pipeline (bench arm A + spec note)

```
leaf → τ_valid(eval instant) → ⊕_dedupe(rule_weighted_avg, similarity: jaccard@cutoff) →
⊥(keyCardinality, floor) → resolveDeprecateOlder → drop deprecated + flag artifacts →
rank → top-k
```

- Bench `answerArmA` adopts this composition. `⊕_dedupe` runs in similarity mode
  (jaccard, starting cutoff **0.5** — a measured dial) with `rule_weighted_avg` (the
  safe idempotent rule per the bio-layer precedent — `evidence_pooled` stays unsafe
  until §5.6 observation dedup). The dedupe stage merges token-overlap restatements
  only; abbreviation-class paraphrases (NYC) wait for the embedding slice (A1).
- Arm A drops its hardcoded `conflictThreshold = 0.5` (answer.ts:84) in favor of the
  corpus default (0 via session.createCorpus — A6), exercising the floor-relocation
  end-to-end.
- The bench supplies a small `keyCardinality` map for the manual-sample corpus
  (declaring the known additive keys: `cooking_interest`, `work_tasks`, `activity`,
  `sculpture_materials_interest`, `next_trip_plan`, `occupation_activity`) —
  exercising the config surface end-to-end.
- The composition is documented in the canonical spec as the recommended read-side
  ordering so consumers don't repeat the subset mistake.

### 6. Spec amendments (mneme-spec-v0.2-consolidated.md, repo root)

- §3 schema: `keyCardinality` field + undeclared-default rule + rationale
  (accumulation ≠ conflict; cardinality is domain knowledge, declared not inferred).
  Validation is manual strict-style, not zod (A3). **ADDITION.**
- §4.8: detection eligibility semantics (floor = eligibility dial, default-all-contest;
  policy lives in resolution rules), multi-valued exemption, and the canonical
  pipeline composition note (similarity-mode `⊕_dedupe` before `⊥`). **ADDITION /
  clarification of the ambiguous "above the threshold" sentence** (≡ `eff > threshold`).
- §4.9: `⊕_dedupe` similarity-partitioned merge mode — opt-in generalization;
  omitted ⇒ the existing whole-group semantics verbatim, so existing normative text
  stands as the default case. Representative-value rule + single-link determinism
  pinned. **Opt-in generalization (ADD-flavored).**
- §3.3: note that `confidenceThreshold` is wired as the resolve node's build-time
  default on the derive path — fulfilling its existing "default confidence floor for
  queries" comment. **ADDITION.**
- Surgical inserts matching surrounding style, same discipline as the
  resolve_deprecate_older amendment (commit 3561e48 precedent).

### 7. Explicitly untouched

- Write path (`src/write/contradiction.ts:enforce()`) — independent policy logic
  (confirmed at audit: it does not call `clustersOf`/`pairsOf`); future write-side
  cardinality/floor support is its own slice (coupling noted).
- Cluster resolvers, scope machinery, the resolution registry.
- Ingest-side scope population for different-referent protection — recorded as a
  requirement note for the MCP/dogfooding ingest path, not built here.

## Error handling

- `keyCardinality` with values outside "single"/"multi" is rejected by a manual
  strict check (`cardinalityOf` throws), mirroring `validateScope` discipline (A3).
- `DedupeOptions.similarity.fn` naming an unregistered similarity fn throws via the
  existing registry error path; `cutoff` outside [0, 1] throws.
- `compile()` of a resolve node with no threshold throws (A5).
- `DetectionOptions` / `DedupeOptions` omitted everywhere ⇒ byte-identical behavior
  to current.

## Measurement (acceptance evidence)

- Probe 1 (additive hobbies): with `hobby: "multi"` declared, arm A keeps both — fixed.
- Probe 6 (confidence floor): with floor 0, the Pixel contests; `resolveDeprecateOlder`
  resolves to the fresh claim — the rule's stated policy, no longer hidden.
- Probe 3 (paraphrase): **expected-fail under jaccard as written** — "NYC" vs
  "New York City" have disjoint token sets (A1); documented as the embedding slice's
  acceptance case. A new token-overlap paraphrase probe (power-bank shape) goes
  green via the similarity-mode dedupe stage.
- Manual benchmark re-run with the bench cardinality map: KU `updateCorrect` stays
  high (≥0.9); arm A recall@3 recovers from 0.7 toward ≥0.9 (additive keys no longer
  suppressed). Fixture e2e + full suite green.

## Testing (TDD)

- schema: `cardinalityOf` default/declared/invalid-value cases (map-taking signature).
- contradiction: multi key never clusters/pairs (incl. mixed corpora where a multi key
  coexists with single keys); threshold 0 admits low-confidence claims (probe-6 shape);
  `opts` omitted ⇒ existing tests pass unchanged.
- combination (dedupe similarity mode): opts omitted ⇒ existing tests pass unchanged;
  similar values merge (single-link, incl. a transitive A~B~C chain where A≁C);
  dissimilar values survive for `⊥`; representative = latest `valid.from` with id
  tie-break; deterministic under input reordering; unregistered fn / bad cutoff throw.
- compile: resolve node without threshold throws at compile; derive path stamps
  `CorpusDefaults.confidenceThreshold` + `keyCardinality` (stamped values visible in
  serialized provenance); explicit threshold wins over default; combine node
  similarity config round-trips; replay round-trip remains deterministic, incl.
  old-format expressions (threshold present, no keyCardinality).
- bench: arm A pipeline with similarity-mode dedupe stage + cardinality map + corpus
  default floor; probe re-runs (1, 3 expected-fail documented, 6, new token-overlap
  probe); manual benchmark regression; `eval:lme:fixture` exit 0.

## Explicitly out of scope (deliberately deferred)

- Similarity-tolerant key matching + embedding `SimilarityFn` (the key-drift slice).
  The dedupe *mechanism* lands here; the embedding fn that fixes NYC-class
  abbreviations lands there (probe 3 is its acceptance case).
- Conflicting-signal flag-for-review resolver; confidence-gated recency variants.
- Write-time cardinality/floor enforcement.
- §5.6 observation-level dedup (unchanged status; `evidence_pooled` stays opt-in).
