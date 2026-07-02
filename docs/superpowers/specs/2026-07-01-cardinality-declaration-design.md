# Cardinality Declaration + Safety (Cluster C) — Design

**Date:** 2026-07-01
**Status:** Approved (brainstorming) → ready for implementation plan
**Cluster:** C (cardinality declaration + safety) — third of the three clusters from the
Fireflies-dogfood roadmap (stoa: `rastate/synthesis-fireflies-dogfood-synthesis-ingestion`,
change #2; mneme claim `de70ba90`). Consumes the same operator (`pairsOf`) that Cluster A's
`deprecated-by … via:"single-cardinality"` disposition derives from; the A-before-C build
gate is satisfied (A shipped, PR merged).

## Goal

Make per-key cardinality **declarable per-corpus** through the ergonomic `CorpusSpec`, and
**warn at serving time** when the `single`-cardinality default silently collapses distinct
facts. The dogfood proved cardinality is load-bearing (`single`→1 served, `multi`→3) and that
the undeclared default `single` silently deprecates distinct values — a footgun. Today
`keyCardinality` is only settable via the MCP server's **global config** (`src/mcp/config.ts`),
never per-corpus, and the collapse is silent.

## Core decisions (from brainstorming)

- **Declaration lands on the library `CorpusSpec`** (not MCP). `ClaimSchema.keyCardinality`
  already exists and persists with the corpus def; the gap is that `CorpusSpec` doesn't expose
  it and the read path ignores it (it reads `keyCardinality` from `RecallDeps`/global config).
- **Precedence: the corpus's own declaration wins per-key over the deps/global map.** A
  corpus-level declaration is more specific than a server-global default. Undeclared corpora →
  effective map = the deps map = today's behavior (back-compat).
- **The safety warning fires at recall-time** (served `warnings[]`), always-on, no opt-in —
  surfaced exactly where the (mis)collapsed result is observed. `keyCensus` (the key-audit
  surface) warns too. Detection reuses `pairsOf` (DRY; the same operator Cluster A labels).

## Non-goals

- **No algebra change.** Pure surface, reusing `pairsOf`/`cardinalityOf`/`canonicalReadStages`.
- **No auto-fix.** The warning is advisory; it never flips `single→multi`.
- **Write/remember path untouched.** Recall-time was chosen over write-time; `remember` gains
  no cardinality logic.
- **MCP declaration deferred.** MCP auto-creates corpora and cannot pass a `CorpusSpec` (the
  known scope-declaration gap); MCP keeps sourcing cardinality from global config, which the
  effective-merge preserves. Adding an MCP corpus-declaration surface is a separate, gated
  effort.
- **CLI `corpus create --cardinality` flag deferred** (YAGNI; add when a CLI consumer needs it).
- **Not** `subjectCensus`/`reconcile` — cardinality is a key-axis concern; those surfaces are
  unchanged.

## Context — the current state this conforms to

- `ClaimSchema.keyCardinality?: Record<string,"single"|"multi">` already exists
  (`src/catalog/schema.ts:16`) and is part of the stored `Corpus.schema`
  (`src/catalog/corpus.ts`); it round-trips through the corpus-store (`saveCorpora`/`loadCorpora`).
- `cardinalityOf(key, map)` (`schema.ts:64`) resolves cardinality, defaulting undeclared keys
  to `"single"`, and throws on values outside `"single"|"multi"`.
- `createCorpus` (`src/surface/session.ts:77`) builds the `ClaimSchema` from `CorpusSpec` but
  never sets `keyCardinality` (CorpusSpec has no such field). It already validates
  `scalarPseudocount` fail-fast — the pattern to mirror for cardinality validation.
- The read path (`recall`/`keyCensus`/`reconcile`) receives `keyCardinality` via
  `RecallDeps`/`ReadDeps`; in MCP that comes from `config.keyCardinality`
  (`openMnemeEngine` → `eng.keyCardinality`). `canonicalReadStages`/`pairsOf` consume it.
- `pairsOf(corpus, threshold, { keyCardinality, keyAliases })` (`src/algebra/contradiction.ts:185`)
  returns value-difference contradiction pairs; `clustersOf` excludes `"multi"` keys and forms
  single-cardinality clusters for `(subject, canonical key, scopeHash)` groups with ≥2 distinct
  values. This is exactly the detection Part B needs.

## Module structure (SRP / SoC / DRY)

- **`src/surface/cardinality.ts`** (new) — single responsibility: cardinality resolution +
  safety detection. Consumed by `recall` and `census` (DRY).
  ```ts
  import type { Session, ReadDeps } from "./types.js";
  import type { Corpus } from "../algebra/types.js";
  import type { KeyAliasMap } from "../retrieval/key-alias.js";

  /** Effective per-key cardinality for a corpus: the corpus's stored schema.keyCardinality
   *  merged OVER the deps/global map (per-key, corpus declaration wins). Returns undefined
   *  when neither source has entries (so callers pass undefined → all-single default,
   *  unchanged). Reads the corpus def via session.mneme.listCorpora. */
  export function resolveKeyCardinality(
    session: Session, corpus: string, depsCardinality?: Record<string, "single" | "multi">,
  ): Record<string, "single" | "multi"> | undefined;

  /** Advisory warnings for single-cardinality (subject, canonical key) groups holding ≥2
   *  distinct values (which read-time resolution collapses to the latest). Reuses clustersOf —
   *  the cluster former behind pairsOf, from which Cluster A's deprecated-by via:"single-
   *  cardinality" derives. `corpus` must be the pre-⊥ corpus (τ_valid + ⊕_dedupe applied),
   *  i.e. exactly what canonicalReadStages feeds into ⊥, so the count matches what actually
   *  gets deprecated. */
  export function cardinalitySafetyWarnings(
    corpus: Corpus, effectiveCardinality: Record<string, "single" | "multi"> | undefined,
    aliasMap: KeyAliasMap,
  ): string[];
  ```
  `resolveKeyCardinality` reads `session.mneme.listCorpora((c) => c.id === corpus)[0]?.schema.keyCardinality`
  and returns `{ ...depsCardinality, ...schemaCardinality }` (schema wins), or `undefined` when the
  merged map has no keys (so callers pass `undefined` → all-single default, unchanged).
  `cardinalitySafetyWarnings` calls `clustersOf(corpus, 0, { keyCardinality: effectiveCardinality,
  keyAliases: aliasMap })` — which already excludes `"multi"` keys, groups by `(subject, canonical
  key, scopeHash)`, and exposes `distinctValues` per cluster — then emits one warning per cluster
  with `distinctValues >= 2`, naming `cluster.triple.subject`, `cluster.triple.key` (already
  canonical), and the count. No manual grouping and no need for the private `canonicalKeyOf`.
  Note: `cardinality.ts` does not import `entities.ts` (avoids a cycle with the
  `entities → recall` `MCP_EVIDENCE_POOLING_RULE` import); it depends only on `types`, algebra
  (`types`, `contradiction`'s `clustersOf`/`ContradictionCluster`), and `retrieval/key-alias`
  (`KeyAliasMap`).

- **`src/surface/types.ts`** — add `keyCardinality?` to `CorpusSpec`.

- **`src/surface/session.ts`** — `createCorpus` validates + writes `schema.keyCardinality`.

- **`src/surface/recall.ts`** — `recall` resolves the effective cardinality via
  `resolveKeyCardinality` (replacing its direct use of `deps.keyCardinality`), and appends
  `cardinalitySafetyWarnings` over its σ-scoped pre-⊥ corpus to the existing `allWarnings`.

- **`src/surface/census.ts`** — `censusCore` resolves effective cardinality via
  `resolveKeyCardinality`; `keyCensus` appends `cardinalitySafetyWarnings` over the full-corpus
  pre-⊥ set to its `warnings`. (`subjectCensus` is unaffected by the warning — subjects have no
  cardinality — but it flows through `censusCore` so it transparently gets the resolved map.)

- **`src/surface/reconcile.ts`** — `reconcile` resolves effective cardinality via
  `resolveKeyCardinality` and threads it into its `distinctEntities` calls (so live-entity
  enumeration honors the per-corpus declaration). It does NOT emit the safety warning (it scores
  external candidates, it is not a serving surface for stored facts).

## Part A — Declaration

1. `CorpusSpec.keyCardinality?: Record<string, "single" | "multi">` (`types.ts`).
2. `createCorpus` (`session.ts`):
   - Validate: every value ∈ `{"single","multi"}`; throw a clear error otherwise (fail-fast,
     mirroring the `scalarPseudocount` validation loop already present).
   - Set `schema.keyCardinality = spec.keyCardinality` **only when provided** (omit the field
     when `undefined`, so existing defs and the store stay byte-identical for undeclared corpora).
3. Round-trips through `saveCorpora`/`loadCorpora` (already serializes the full `schema`).
4. `resolveKeyCardinality` makes the stored declaration flow into the read path per-corpus,
   merged over the deps/global map (declaration wins). Each op computes
   `const effective = resolveKeyCardinality(session, corpus, deps.keyCardinality)` once, then
   uses `effective` wherever it currently uses `deps.keyCardinality`:
   - `recall` — passes `effective` to `canonicalReadStages` (recall.ts:280) and to
     `loadAliasContext` (replacing `deps.keyCardinality` at recall.ts:213/210 usage).
   - `censusCore` / `reconcile` — pass `effective` to `loadAliasContext`, and to `distinctEntities`
     by handing it `{ ...deps, keyCardinality: effective }` (distinctEntities reads
     `deps.keyCardinality`; no signature change). This transparently covers `keyCensus`,
     `subjectCensus`, and `reconcile`'s live-entity enumeration.

## Part B — Safety warning (recall-time)

Detection (`cardinalitySafetyWarnings`): over the pre-⊥ corpus (τ_valid + ⊕_dedupe), run
`clustersOf` with the effective cardinality + alias map. Each single-cardinality cluster with
`distinctValues >= 2` → emit one warning naming the subject, canonical key, and count:

> `single-cardinality (subject:client:acme, key:database.choice) holds 3 distinct values — recall serves only the latest; declare keyCardinality:"multi" if they should coexist.`

- **`recall`:** capture `const canon = canonicalReadStages({ ... effective ... })` (recall already
  builds these; hold the array like `explainRecall` does), compute the pre-⊥ corpus with the prefix
  it already composes (`pipe(leaf, ...sigmas, canon[0], canon[1])` — τ_valid + ⊕_dedupe), run
  `cardinalitySafetyWarnings`, append to `allWarnings`. This is one extra lightweight query per
  recall (no ranking, no embeddings warm-up — recall's dominant cost). Cost note: the query is
  bounded to the σ-scoped subset and skips the expensive stages; acceptable for an always-on
  safety net. Warnings already surface to the caller (and to stderr via the MCP server convention).
- **`keyCensus`:** it already reads all raw claims and runs the canonical pipeline; compute the
  pre-⊥ corpus (τ_valid + dedupe over the full corpus) and append the same warnings to its
  `warnings`.

Threshold: ≥2 distinct values under one single-cardinality `(subject, canonical key)`. Fixed
(not configurable — YAGNI).

## Error handling

Best-effort, consistent with the surrounding read ops: `resolveKeyCardinality` degrades to the
deps map if the corpus def is unavailable; `cardinalitySafetyWarnings` is wrapped so a detection
failure appends a warning rather than throwing (never fails the recall). `createCorpus`
validation is the one intentional throw (fail-fast at declaration, like `scalarPseudocount`).

## Testing

- **`src/surface/cardinality.test.ts`**
  - `resolveKeyCardinality`: corpus with `schema.keyCardinality` declared → returned; declaration
    wins per-key over the deps map; undeclared corpus → returns the deps map unchanged; both empty
    → `undefined`.
  - `cardinalitySafetyWarnings`: a single-cardinality `(subject,key)` with 3 distinct values →
    one warning naming subject/key/count; the same key declared `multi` → no warning; a group with
    1 value → no warning; token-similar values merged by `⊕_dedupe` (so 1 post-dedupe value) → no
    warning (proves it operates on the pre-⊥/post-dedupe set, matching the pipeline).
- **`src/surface/session.test.ts` (or the createCorpus test file)** — `createCorpus` persists
  `schema.keyCardinality`; round-trips across a reopen (`loadCorpora`); invalid value throws;
  omitted → field absent (byte-identical def for undeclared corpora).
- **`src/surface/recall.test.ts`** — a recall over a corpus with a single-cardinality key holding
  ≥2 distinct values surfaces the safety warning in `warnings`; declaring that key `multi` (via
  the corpus schema) both serves all values AND suppresses the warning (end-to-end of Part A + B).
- **`src/surface/census.test.ts`** — `keyCensus` surfaces the same warning; `subjectCensus`
  does not (unchanged).
- Full suite + `tsc --noEmit` green; `src/surface/layering.test.ts` green (no `src/mcp` imports);
  `src/mcp/backcompat.test.ts` green (MCP global-config path preserved via the effective-merge).

## Scope / future (deferred)

- MCP corpus-declaration surface (the scope-declaration gap) — declare `keyCardinality` for
  MCP-created corpora.
- CLI `corpus create --cardinality k=single,...` flag.
- Making the safety threshold or message configurable (only if a consumer needs it).
