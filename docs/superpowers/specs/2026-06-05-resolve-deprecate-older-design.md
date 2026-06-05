# resolveDeprecateOlder + honest tie semantics (design)

**Date:** 2026-06-05
**Status:** Approved design, pre-implementation
**Canonical spec:** `mneme-spec-v0.2-consolidated.md` — §4.8 (resolution operators), §4.9 (`⊕` tie-breaks — explicitly NOT touched), §D.4 (process commitment)
**Driven by:** adversarial probe findings in `bench/RESULTS.md` (LongMemEval A/B findings, 2026-06-05) — probe 5 (arbitrary tie winner) and the documented bench-local `resolveDeprecateOlder` upstreaming debt (`bench/longmemeval/answer.ts`).

## Problem

1. Latest-wins (recency) resolution exists only as a bench-local resolver; the library's
   §4.8 family has no temporal deprecation operator, even though §7's write-policy
   discussion already anticipates a `keep_newer` rule.
2. Both pairwise deprecation resolvers break exact ties by silently deprecating the
   lexicographically-higher claim id. Probe 5 showed this presents an **arbitrary
   choice as a resolution**. A tie means the ordering criterion *cannot decide*; hiding
   that violates the same honesty principle that forbade `rule_max_confidence` aliasing
   (§4.9 / E.2).

## Decisions made during brainstorming

1. **Tie behavior: keep both + flag for review.** Neither claim is deprecated; a review
   artifact records the unresolved pair (reusing the `resolveFlagForReview` artifact
   vocabulary). Rejected: silent keep-both (invisible), recorded-arbitrary-pick (still
   arbitrary), per-call `tiePolicy` parameter (knob without a puller).
2. **Scope: both read-time pairwise deprecation resolvers.** `resolveDeprecateOlder`
   (new) and `resolveDeprecateLower` (tie-semantics change) get identical tie handling.
   Write-time `accept_and_resolve` rule `deprecate_older` is deferred until pulled.
3. **Mechanism: internal partition + shared artifact helper** (signatures unchanged,
   `Corpus → Corpus`). Rejected: `withTiePolicy` combinator (premature abstraction for
   one consumer); `{corpus, unresolved}` return shape (breaks registry/replay/compile).
4. **Config posture:** tie semantics are fixed in this slice. If a per-corpus
   `tieBehavior` override is ever pulled for, it belongs in `CorpusDefaults`
   (catalog) alongside the §4.9 per-corpus tie-breaker precedent — documented in the
   spec amendment, not implemented now.
5. **Embeddings are unrelated to this slice** (they enter at the key-drift slice, as a
   `SimilarityFn` `[P]` provider, staged behind a cheap deterministic key-similarity
   first pass).

## Design

### 1. New resolver — `resolveDeprecateOlder` (src/algebra/resolution.ts) `[C]`

```
resolveDeprecateOlder : ContradictionPair[] → Corpus → Corpus
```

Per pair: the claim with the **later `valid.from`** survives; the earlier one's status
becomes `"deprecated"` (immutable mapCorpus flip, sibling style — no claim mutation,
no confidence change). Pairs with **equal `valid.from`** are ties: neither claim is
touched; one review artifact is appended per tied pair. Interaction rule when a claim
appears in both a decided and a tied pair within one pass: deprecation from the decided
pair stands, and the tied pair emits **no artifact** if either of its members was
deprecated in this pass — the conflict is already resolved, so flagging it would be
noise. (Decided pairs are computed first; artifacts are emitted only for tied pairs
whose members both survive.)

### 2. Tie-semantics change — `resolveDeprecateLower`

Tie criterion unchanged (exact `pointEstimate` equality). Tie consequence changes:
instead of deprecating the lexicographically-higher id, the pair is flagged (same
artifact path as above) and both claims stay live. This is a deliberate, documented
behavior change; tests asserting the old lexicographic tie-break are updated.

§4.9's `⊕` combination-rule tie-breaks (claim-id ordering for `rule_max_*`) are NOT
touched — they are load-bearing for idempotence and associativity of `⊕`.

### 3. Shared artifact helper

The artifact-construction block inside `resolveFlagForReview` is extracted into a
module-private helper and reused by all three call sites (`resolveFlagForReview`, both
tie paths). Artifact shape unchanged: `subject: "contradiction"`,
`key: "contradiction.flag"`, conflicting claim ids recorded, id via `newClaimId()`
(existing precedent; replay caveat for artifact ids is pre-existing and unchanged).

### 4. Registry / replay

`src/algebra/registries.ts` gains `resolveDeprecateOlder: { fn, input: "pairs" }`.
Compile/replay coverage mirrors the existing resolver entries (same test pattern as
`resolveDeprecateLower`).

### 5. Spec amendment (mneme-spec-v0.2-consolidated.md §4.8)

- Add `resolve_deprecate_older : Set<ContradictionPair> × Corpus → Corpus` `[C]` with
  recency semantics.
- Document unified tie semantics for both pairwise deprecation resolvers: exact tie ⇒
  keep both + flag artifact; rationale recorded (a tie means the ordering criterion
  cannot decide; a silent arbitrary pick masquerades as a resolution) so future
  revisions don't re-litigate (D.4).
- Note the future per-corpus `tieBehavior` override hook (CorpusDefaults), not
  implemented.

### 6. Bench follow-through

- `bench/longmemeval/answer.ts`: delete the local `resolveDeprecateOlder`; import the
  upstreamed one. The post-resolve filter excludes review artifacts from ranked
  results (`key !== "contradiction.flag"` alongside the existing
  `status !== "deprecated"`).
- `bench/longmemeval/answer.test.ts`: the tie test now expects both values returned
  and no artifact in results.
- `bench/longmemeval/manual/adversarial-probe.ts`: probe 5 expectation text updated
  (tie → both values visible + flagged, not an arbitrary winner).

## Error handling

- `valid.from` is always a number on committed claims (Interval); no new edge cases.
- Artifact claims never participate in further pair resolution within the same pass
  (they are appended after deprecation/flagging is computed).

## Testing (TDD)

- `resolveDeprecateOlder`: later-wins (pairwise); exact tie → both live + one artifact
  per tied pair; multi-pair accumulation; 3-way chain (A<B<C ⇒ only C survives);
  deprecation-beats-tie when the same claim is in a decided and a tied pair.
- `resolveDeprecateLower`: updated tie tests (tie → both live + artifact, no
  lexicographic deprecation); non-tie behavior unchanged.
- `resolveFlagForReview`: behavior unchanged after helper extraction (regression).
- Registry: `resolutionRegistry("resolveDeprecateOlder")` resolves; replay/compile
  coverage test in the existing pattern.
- Bench: answer tie test, probe 5 manual re-run, full `npm test` green.

## Explicitly out of scope (deliberately deferred)

- Write-time `accept_and_resolve` rule `deprecate_older` (`keep_newer`) — until pulled.
- Per-corpus `tieBehavior` configuration — documented hook only.
- Slices 2–4 (detection-floor split, cardinality-aware `⊥`, key-drift similarity).
