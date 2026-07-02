# Ingestion Canonicalization (Cluster B) — Design

**Date:** 2026-07-01
**Status:** Approved (brainstorming) → ready for implementation plan
**Cluster:** B (ingestion canonicalization) — second of the three clusters from the
Fireflies-dogfood roadmap (stoa: `rastate/synthesis-fireflies-dogfood-synthesis-ingestion`,
changes #3 + #4; mneme claim `de70ba90`). Independent of Cluster A's `DispositionReason`
vocabulary (that is read-trace; this is write-side ingestion) but shares the "every
transform observable, never silent" invariant.

## Goal

Give Mneme consumers a first-class **recall-before-write** surface so extraction reuses
*canonical* entities instead of minting near-duplicates, and a **subject census** that
surfaces subject fragmentation that already happened. The 2026-07-01 Fireflies dogfood
proved ingestion — not the algebra — is the bottleneck: independent extraction of a second
transcript reused 0/26 canonical subjects and minted 4 near-duplicates
(`project:crewtracks` vs `project:crewTracks-liner-build`), firing zero supersession.
Feeding the existing canonical subjects back into the extractor flipped it to 18/18 reuse.
Today every consumer hand-rolls that loop; this cluster makes it a supported primitive.

## Core decision (the fork)

Subject reconciliation happens **at ingest (prevent)**, not post-hoc (merge). `key_census`
ratification writes an `alias-of` claim the read pipeline honors via `keyAliases`; there is
**no symmetric subject-alias machinery**, and this design does not build one. Rationale:
the ratified ingestion discipline is "recall-before-write at ingest (canonicalize obvious
matches) + ratify UNCERTAIN merges post-hoc; never let the extractor canonicalize blind"
(mneme claim `de70ba90`), and building post-hoc subject merging would touch either the
corpus-isolation invariant (subject-aliases in the read pipeline) or the non-destructive
provenance guarantee (subject-rewrite). Both are **deferred** (detect→declare→contest:
detect now, ratify when demand is real). See Non-goals.

## Non-goals

- **No post-hoc subject merging.** No subject-alias mechanism (symmetric to key aliases)
  and no subject-rewrite/derived-write migration. Subject census *detects* fragmentation;
  it does not merge it. (Deferred; separate spec, gated on real demand.)
- **No algebra change.** `reconcile`, `subjectCensus`, and the refactored `keyCensus` are
  pure surface ops composing existing retrieval/algebra operators. `recall()` and the read
  pipeline are untouched.
- **No forced canonicalization.** `reconcile` returns scored *suggestions* + a disposition;
  it never mutates or auto-merges. The over-anchoring failure the dogfood hit
  (`traffic-control`, a genuinely new division, folded into `liner-division`) is prevented
  by returning `new`/`uncertain` for weak matches — the consumer decides.
- **No fetch/extraction.** Extraction stays a consumer concern (`ExtractFn` in
  `examples/fireflies-ingest.ts`). This cluster gives the consumer the *existing-entity*
  half of recall-before-write; the consumer wires it into its own extractor.
- **CLI deferred.** Library + MCP only for v1 (the dogfood surface). `mneme reconcile` /
  `mneme subject-census` can follow the `mneme explain` template later.

## Context — the patterns this conforms to

- `keyCensus` (currently in `src/surface/recall.ts`) is the template: read all raw claims →
  run `canonicalReadStages` (τ_valid → ⊕_dedupe → ⊥/resolveDeprecateOlder → drop) to get the
  **live** claim set → count distinct keys → score all O(K²) key pairs with the registered
  rank fn (`similarityFn`, warmed via `warmValues` for hybrid) → sort desc → truncate.
- The MCP `key_census` tool (`src/mcp/server.ts:267`) is the tool template: `readOnlyHint:
  true, idempotentHint: true, openWorldHint: false`; deps are `{ embeddings: await
  initEmbeddings(), keyCardinality }`; non-fatal warnings go to stderr
  (`console.error("[mneme/<tool>] ...")`); the surface op stays pure (no I/O).
- Surface ops take `(session, args, deps)` and are exported from both `src/surface/index.ts`
  (the `mneme/surface` entry) and the root barrel `src/index.ts`. Layering is enforced by
  `src/surface/layering.test.ts` (no `src/surface`/`src/retrieval` file imports `src/mcp`).

## Module structure (SRP / SoC / DRY)

`keyCensus` lives inside `recall.ts` today, which conflates recall with census. This cluster
factors census out and adds two siblings. **Public exports stay byte-identical** — the
barrels re-point to the new modules (internal move, the same pattern the ops-layer migration
used); external importers of `mneme`/`mneme/surface` see no change, guarded by a back-compat
test.

- **Shared deps type → `src/surface/types.ts`.** The read-deps shape `{ embeddings;
  keyCardinality? }` currently lives in `recall.ts` as `RecallDeps`; census/reconcile
  depending on a *recall*-named type is an SoC smell. Promote it to the neutral surface
  types home as `ReadDeps` (where `Session`/`CorpusSpec`/`SessionOptions` already live) and
  make `RecallDeps = ReadDeps` a back-compat alias (public export unchanged). All three ops
  (`recall`, census, `reconcile`) consume `ReadDeps`.

- **`src/surface/entities.ts`** — the shared primitive (one responsibility: *live distinct
  entities + similarity*). Consumed by both census and reconcile (DRY):
  ```ts
  export type EntityAxis = "subject" | "key";
  export interface DistinctEntity { value: string; claims: number } // value = subject or key string
  /** Live distinct entities on `axis`, over canonicalReadStages (same live-set semantics as keyCensus).
   *  `aliasMap` AND `now` are passed in (not recomputed) so ONE loadAliasContext call + ONE evaluation
   *  instant per op are threaded — never double-read, and no independent Date.now() that could diverge
   *  from the alias load on a tauValid boundary (matches keyCensus's single-`now`). */
  export function distinctEntities(session: Session, corpus: string, axis: EntityAxis, deps: ReadDeps, aliasMap: KeyAliasMap, now: number): DistinctEntity[];
  /** Score every unordered pair of the given strings with the registered rank fn (hybrid warmed, jaccard fallback).
   *  Returns { rankFn, warnings, scoreOne(a,b) } — the scorer, not the pairs, so callers choose the topology. */
  export function entityScorer(strings: string[], deps: ReadDeps): Promise<{ rankFn: string; warnings: string[]; scoreOne: (a: string, b: string) => number }>;
  ```
  `distinctEntities` reuses `canonicalReadStages` exactly as `keyCensus` does today, taking
  the already-loaded `aliasMap` as `keyAliases`; `entityScorer` reuses `similarityFn` +
  `warmValues` exactly as `keyCensus` does today (the warm→jaccard-fallback block is
  extracted from `keyCensus`, removing that duplication).

- **`src/surface/census.ts`** — census reporting (one responsibility). Holds:
  - `censusCore(axis, session, args, deps)` — loads alias context ONCE (via the exported
    `loadAliasContext`), enumerates via `distinctEntities`, scores all O(n²) pairs via
    `entityScorer`, sorts desc (score, then names, for determinism), truncates to `limit`.
    Returns `{ entities, candidates, rankFn, warnings, aliasContext }` — the `aliasContext`
    is returned so `keyCensus` builds its alias report from the same load (no second read);
    `subjectCensus` ignores it. `reconcile` loads its own single alias context.
  - `keyCensus` — **moved verbatim from `recall.ts`**; delegates enumerate+score to
    `censusCore("key", …)`, then keeps its key-specific alias layer (`aliases`,
    `unratified`, the `alias-of` ratification shape). Signature/`CensusArgs`/`CensusResult`
    unchanged.
  - `subjectCensus` — new; delegates to `censusCore("subject", …)`, emits **advisory**
    content (no `alias-of` ratification shape — there is no subject-alias mechanism).

- **`src/surface/reconcile.ts`** — reconciliation (one responsibility): score external
  candidate entities against the corpus's live distinct entities, assign a disposition.

- `recall.ts` keeps `recall` + the shared stage-builders (`loadAliasContext`,
  `buildFilterSigmas`, `buildRecallRanker`, `warmRecallValues`, `MCP_EVIDENCE_POOLING_RULE`);
  `CensusArgs`/`CensusResult` move to `census.ts`, re-exported by the barrels.

## Component 1 — `reconcile` (HIGH, the differentiated slice)

```ts
// src/surface/reconcile.ts
export interface ReconcileArgs {
  corpus: string;
  subjects?: string[];             // candidate subject strings the extractor is about to write
  keys?: string[];                 // candidate key strings
  limit?: number;                  // max suggestions per candidate (default 5)
  reuseThreshold?: number;         // top score ≥ this ⇒ "reuse" (default 0.9)
  newThreshold?: number;           // top score ≤ this ⇒ "new"   (default 0.5)
}
export type ReconcileDisposition = "reuse" | "uncertain" | "new";
export interface EntitySuggestion { existing: string; score: number }
export interface ReconcileMatch {
  candidate: string;
  suggestions: EntitySuggestion[]; // top-`limit`, score desc
  disposition: ReconcileDisposition;
}
export interface ReconcileResult {
  corpus: string;
  subjects: ReconcileMatch[];      // one per input subject (empty if none requested)
  keys: ReconcileMatch[];          // one per input key
  rankFn: string;
  warnings: string[];
  content: string;                 // human-readable: per candidate, disposition + top suggestion
}
export async function reconcile(session: Session, args: ReconcileArgs, deps: ReadDeps): Promise<ReconcileResult>;
```

Mechanism (composition, no new equations):
1. `existingSubjects = distinctEntities(session, corpus, "subject", deps)`,
   `existingKeys = distinctEntities(session, corpus, "key", deps)` (live canonical set).
2. Build one `entityScorer` over the union of candidate + existing strings per axis (so
   hybrid warm-up covers both sides in a single pass), then for each candidate score it
   against every existing entity, take the top-`limit`.
3. **Disposition** from the top suggestion's score: `≥ reuseThreshold → reuse`;
   `≤ newThreshold → new`; strictly between → `uncertain`. Empty corpus (no existing
   entities) ⇒ every candidate is `new` with no suggestions. This is the over-anchoring
   guard: a genuinely-new entity scores low → `new`, never silently folded.
   The default thresholds (0.9 / 0.5) are **provisional, not calibrated** — hybrid recall
   scores are known to cluster tightly (0.83–0.94, no natural separation; dogfood window
   review 2026-06-22). Defaults ship as a documented starting point; the disposition is
   advisory and the consumer tunes the thresholds. Calibrating them against real reuse/new
   labels is deferred (a bench arm), consistent with "knobs off until calibrated."
4. Read-only: an unknown corpus returns all-`new` with a warning; it never creates the
   corpus (mirrors recall/census read-only discipline).

The consumer feeds `reuse` matches back into its extractor prompt (the dogfood move) or
canonicalizes before `writeMany`; `uncertain` → surface for contest; `new` → mint. Every
suggestion carries its score — nothing is silent.

## Component 2 — `subjectCensus` (MEDIUM, detection companion)

```ts
// src/surface/census.ts
export interface SubjectCensusResult {
  corpus: string;
  subjects: { subject: string; claims: number }[]; // distinct live subjects + per-subject counts, desc
  candidates: { a: string; b: string; score: number }[]; // top near-duplicate subject pairs, score desc, ≤ limit
  rankFn: string;
  warnings: string[];
  content: string; // advisory report: "these subjects look like one entity — canonicalize at ingest via reconcile"
}
export async function subjectCensus(session: Session, args: CensusArgs & { corpus: string }, deps: ReadDeps): Promise<SubjectCensusResult>;
```

Symmetric to `keyCensus` on the subject axis, via `censusCore("subject", …)`. The one
deliberate asymmetry: `content` is **advisory**, not a paste-ready ratification shape,
because there is no subject-alias to ratify (that is the deferred post-hoc-merge work). The
advisory names the fragmented pair and points at `reconcile` as the ingest-time fix.

## Surfaces

- **Library:** `reconcile`, `subjectCensus` + their types exported from `src/surface/index.ts`
  and the root barrel `src/index.ts`, next to `recall`/`keyCensus`/`explainRecall`. `keyCensus`
  export unchanged (re-pointed to `./census.js`).
- **MCP** (`src/mcp/server.ts`), mirroring the `key_census` tool exactly:
  - `subject_census` — inputs `{ corpus?, limit? }`; `readOnlyHint/idempotentHint`; deps
    `{ embeddings: await initEmbeddings(), keyCardinality }`; warnings→stderr
    (`[mneme/subject_census]`); output = `SubjectCensusResult` fields.
  - `reconcile` — inputs `{ corpus?, subjects?: string[], keys?: string[], limit?,
    reuseThreshold?, newThreshold? }`; same annotations/deps/warning convention; output =
    `ReconcileResult` fields.
- **CLI:** deferred.

## Error handling

Best-effort observability parity with census: alias-load / warm-up failures degrade
gracefully (empty alias map / jaccard fallback) with a `warnings` entry, never throw —
reusing the existing `loadAliasContext` and warm-up try/catch patterns. Unknown corpus →
empty result, no corpus creation.

## Testing

- **`src/surface/entities.test.ts`** — `distinctEntities` returns the live canonical set for
  each axis (deprecated/merged/alias-shaped claims excluded, matching `keyCensus`'s live
  semantics); `entityScorer` scores symmetric pairs and falls back to jaccard when embeddings
  are unavailable (warning present).
- **`src/surface/reconcile.test.ts`** — the dogfood reproductions:
  - candidate `project:crewTracks` vs existing `project:crewtracks` → top score ≥ reuse
    threshold → `disposition: "reuse"`, suggestion names the existing subject.
  - candidate `division:traffic-control` with existing `client:liner-division` → low score →
    `disposition: "new"` (the over-anchoring guard; NOT folded).
  - a mid-band pair → `uncertain`.
  - key candidates reconcile symmetrically.
  - empty/unknown corpus → all-`new`, no corpus created; warning on unknown.
- **`src/surface/census.test.ts`** — the `keyCensus` `describe` blocks are **extracted from
  `recall.test.ts`** (they are intermingled there — ~18 references — not a separate file) and
  moved here **byte-identical** (assertions unchanged), proving the move is behavior-
  preserving; plus new `subjectCensus` tests (enumerates fragmented subjects, scores the
  near-duplicate pair high, advisory `content` names the pair). `recall.test.ts` keeps only
  recall tests afterward.
- **`src/surface/layering.test.ts`** — stays green (new files import no `src/mcp`).
- **Back-compat (public API unchanged after the move)** — `src/mcp/backcompat.test.ts` + a
  surface barrel export test assert `keyCensus`/`CensusArgs`/`CensusResult` are still exported
  from `mneme` and `mneme/surface` (and still resolvable by `src/mcp/index.ts` and the
  external `integrations/openclaw/memory-mneme` consumer), and that `reconcile`/`subjectCensus`
  are exported.
- **MCP integration** (`src/mcp/server.integration.test.ts`) — `subject_census` and
  `reconcile` tools return the expected structured content; read-only (no writes).

## Scope / future (deferred, demand-gated)

- Post-hoc subject merging — either subject-aliases honored by the read pipeline (symmetric
  to key aliases) or a replayable subject-rewrite derived-write. Both are separate specs,
  built only when a consumer needs to merge *already-fragmented* subjects rather than prevent
  fragmentation at ingest.
- CLI `reconcile` / `subject-census` commands (follow the `mneme explain` template).
- A `reconcile`-backed enrichment to the write path (auto-suggest on `remember`) — only if
  the manual reconcile→extractor loop proves too high-friction in dogfood.
