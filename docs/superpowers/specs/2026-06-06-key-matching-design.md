# Key matching: census, ratified aliases, alias-aware contest (design)

**Date:** 2026-06-06
**Status:** Approved design, pre-implementation
**Canonical spec:** `mneme-spec-v0.2-consolidated.md` — §4.8 (canonical read composition — this slice extends its grouping semantics), §4.6 (`SimilarityFn` seam — reused for key-pair scoring), §3.3 (keyCardinality precedent for declarative per-key inputs).
**Standing decisions honored:** [composition-first — no new operators; aliases are a declarative input on existing ⊥/σ] · [knobs-off-until-calibrated — census reports scores, never enforces a threshold] · [the wedge: deterministic, non-destructive, replayable — ratification is a supersedable claim, never a config-file mutation; stale losers are deprecated, not deleted] · [C3 transport — per-key options flow config/inputs → read-time `DetectionOptions`, never corpus schema].
**Driven by:** dogfood protocol Q2 (`docs/dogfood/2026-06-06-dogfood-protocol.md` §3) — near-duplicate keys (`editor` / `preferred_editor`) silently bypass ⊥ because claims with different keys never contest; the stale fact is never deprecated and pollutes served context. This slice builds the detect → declare → contest loop the protocol's census procedure performs manually.

## Decisions made during brainstorming (user-ratified)

1. **Layered intervention: detect → declare → contest.** Efficiency does not differentiate the intervention points (keys are short strings; distinct-key counts are tens-to-hundreds; every option costs µs–ms). The differentiator is the accuracy mechanism: lexical similarity cannot separate real drift from legitimate near-keys — token-jaccard scores `editor`↔`preferred_editor` (drift) and `finding-corpus-model`↔`finding-corpus-isolation` (legitimately distinct) **identically at 0.5**. No threshold replaces judgment, so enforcement requires a ratified input set; detect/declare/contest are the natural seams of the problem, not safety padding. Minimal build: census + map-consuming contest, ratification = a plain write. Write-time advisory **dropped** this slice.
2. **Aliases live in-corpus as claims, not config.** Ratifying is a `remember`; un-ratifying is supersession; replay reconstructs which aliases were active when. The long-run ratifier is an agent, and claims are MCP-writable with zero new write machinery; config.json would need file-write access and lives outside the auditable record.
3. **Alias reach: ⊥ grouping + σ key filters.** A ratified alias means "same attribute, everywhere a key identifies a claim group or filters a read." ⊕ evidence pooling across aliased keys is excluded (observation-dedup territory, §5.6); see Out of scope.
4. **Approach: alias-aware grouping via the options transport (A1), not a rename stage (A2).** A1 threads a flat alias map through `DetectionOptions` exactly as `keyCardinality` travels today; claims are never modified; served claims keep their stored keys (ledger-faithful view). A2 (an explicit canonicalization stage — relational algebra's actual rename ρ) gives structural consistency for all downstream operators but costs a new AST node + compile/replay/serialization obligations and silently serves rewritten keys — off-wedge without extra annotation machinery, and composition-first gates new operators while A1 expresses the need. The ⊕_dedupe alias-blindness under A1 is benign: aliased same-value claims fail to pool, then group canonically at ⊥ with the same valueHash → not a contradiction pair → both serve, and κ's content-dedup catches the redundancy. Aliased different-value claims are exactly the contest we want. **Documented trigger to revisit A2:** a third alias-aware consumer, or a product need to serve canonical keys.

## Design

### 1. Alias claim convention (no new write machinery)

A ratified alias is an ordinary claim:

```
subject: "key:<variant>"        e.g. "key:preferred_editor"
key:     "alias-of"
value:   "<canonical>"          e.g. "editor"
schema:  "key.alias"
```

- **Ratify** = `remember` with this shape (existing MCP tool, unchanged).
- **Re-point** = write again; supersession picks the newer (⊥ + `resolveDeprecateOlder` operating on alias claims themselves).
- **Un-ratify** = write a self-alias (`key:preferred_editor` → value `"preferred_editor"`). Identity mapping; drops out of the resolved map. No tombstone semantics.
- **Scope:** corpus-wide. Keys are corpus-global; per-subject aliasing is YAGNI.
- **Marker semantics:** the operative identifier is the *shape* — `key === "alias-of"` ∧ subject prefix `"key:"` — because the MCP `remember` tool exposes no `schema` argument and ratification must stay a plain `remember`. The MCP write path auto-stamps `schema: "key.alias"` when the shape matches (one-line enrichment in the remember handler), so the schema tag remains the principled audit marker; the loader σ and the serving filter match on the shape, which also covers alias claims written through non-MCP paths.

### 2. Alias map loader (`src/retrieval/key-alias.ts` — NEW, sibling of `read-pipeline.ts`)

The loader is a read recipe, so it lives in the retrieval layer (algebra = mechanisms, retrieval = recipes, MCP = surface).

```ts
export type KeyAliasMap = Record<string, string>; // variant → canonical (chains pre-resolved)

export interface AliasLoadResult {
  map: KeyAliasMap;
  warnings: string[]; // cycles dropped, ties dropped, malformed claims ignored
}

/**
 * Pass 1 (alias-blind): σ(key = "alias-of") + shape check (subject prefix "key:")
 * → τ_valid(t) → ⊥ + resolveDeprecateOlder (all-single cardinality) → drop
 * deprecated/flag artifacts. No regress: "alias-of" is one fixed key, so this
 * pass needs no alias map. Composes existing operators with its own small recipe
 * — it must NOT reuse canonicalReadStages verbatim, because the canonical
 * serving filter (extended in §4) drops alias-shaped claims.
 *
 * Pass 2: build variant→canonical pairs from survivors, resolve chains to fixpoint
 * (a→b, b→c ⇒ a→c), with deterministic degradation:
 *   - cycles (a→b, b→a): drop all cycle members from the map; warn.
 *   - resolution ties for one variant: flag artifact (existing behavior), variant
 *     dropped from the map; warn.
 *   - self-alias: identity; excluded from the map.
 *   - malformed value (non-string/empty): claim ignored; warn.
 * Degraded-but-deterministic, never a crash: the ledger is append-only, so a bad
 * alias write is fixed by superseding it, and recall must keep working meanwhile.
 * Warnings surface on stderr and in census output.
 */
export function aliasMapOf(claims: Corpus, opts: { evaluationInstant: number }): AliasLoadResult;

/** All keys sharing key's canonical, plus the canonical itself (σ expansion helper). */
export function keyFamilyOf(key: string, map: KeyAliasMap): string[];
```

### 3. Alias-aware ⊥ grouping (`src/algebra/contradiction.ts` — additive)

```ts
export interface DetectionOptions {
  keyCardinality?: Record<string, "single" | "multi">;
  keyAliases?: KeyAliasMap; // NEW — flat, pre-resolved (no chains/cycles reach algebra)
}
```

- Grouping becomes `(subject, canonical(key), scopeHash)` where `canonical(k) = keyAliases?.[k] ?? k` — a lookup at the existing grouping site (`contradiction.ts:49`). Resolution operators untouched; they already work on clusters.
- `cardinalityOf` consults the **canonical** key: declare cardinality on the canonical, variants inherit. (Cardinality declared only on a variant is ignored — document in config comments.)
- Algebra core stays mechanism-only: it receives a flat map and knows nothing about where it came from. Chain/cycle handling is the loader's job (retrieval layer).

### 4. Read pipeline + MCP recall threading (`src/retrieval/read-pipeline.ts`, `src/mcp/tools.ts`)

- `ReadPipelineOpts` gains `keyAliases?: KeyAliasMap`, forwarded to the resolve stage's `DetectionOptions` — the exact path `keyCardinality` travels (C3 transport).
- The canonical post-resolve filter (drop deprecated + `contradiction.flag`) **also drops alias-shaped claims** (`key === "alias-of"` ∧ subject prefix `"key:"`) — alias claims are infrastructure, not servable content. The compiled form of the filter is extended to match (additive compile-coverage delta, no new node).
- MCP `recall` flow per call: load alias claims (adapter query by key `"alias-of"`) → `aliasMapOf` → pass `map` into `ReadPipelineOpts` → when the `key` argument is present, σ matches `keyFamilyOf(key, map)` instead of the single literal key. No caching this slice (alias claims number in the dozens; see Out of scope).
- Served claims keep their **stored** keys. The only externally visible changes: stale aliased losers stop appearing (deprecated by ⊥), and key-filtered recall reaches across the family.

### 5. Census tool (`key_census` — NEW MCP tool, read-only)

- **Input:** `corpus` (default `"knowledge"`), `limit` (default 20 candidate pairs).
- **Output (structured + composed text):**
  - distinct keys with claim counts (the protocol's manual census, automated);
  - candidate near-duplicate key pairs scored pairwise by the **same `SimilarityFn` seam recall uses** — `hybridMax(jaccard, cosine)` when the embedding model is loaded, jaccard fallback — with `rankFn` reported exactly as recall reports it;
  - all pairs sorted by score descending, **no enforcement threshold** (knobs-off): the scores plus subsequent ratify/ignore decisions are the labeled dataset that would eventually calibrate an auto-suggest threshold;
  - currently ratified aliases (the resolved map) + loader warnings (cycles, ties);
  - the ready-to-paste `remember` shape for ratifying a pair (affordance only — census never writes).
- Cost: O(K²) pairwise over distinct keys, K ≈ tens — ms lexical, ~seconds embedding on first warm. On-demand only; never on the recall path.

### 6. Replay & provenance (`src/write/derive.ts` — additive)

`stampResolveDefaults` stamps `keyAliases` onto resolve nodes at derive time, exactly as it stamps `keyCardinality` today. A derived claim's `queryExpression` carries the alias-map **snapshot** active at derivation — replay reproduces exactly even after aliases are re-pointed or un-ratified. Additive field on an existing serialized options object: no AST changes; compile/replay coverage extends the existing resolve-node tests.

### 7. Testing

- **Unit:** `key-alias.test.ts` — chains, cycles, self-alias, ties, malformed values, supersession among alias claims, `keyFamilyOf` expansion. `contradiction.test.ts` — canonical grouping, cardinality-via-canonical, absent-map = today's behavior byte-for-byte.
- **Integration (MCP-level), the Q2 scenario end-to-end:** write `editor`, write `preferred_editor` with a newer conflicting value → both serve (drift demonstrated); ratify the alias → only the newest serves, and `key: "editor"` retrieves across the family; census reports the scored pair pre-ratification and the resolved alias post-ratification.
- **Replay:** derive a claim with stamped aliases; supersede the alias; replay → `exact` (stamping isolates derived claims from map evolution).
- **Regression:** full suite green; recall with zero alias claims is behavior-identical to today (empty map = identity).

### 8. Acceptance criteria

1. The Q2 integration scenario passes: drifted pair contests after ratification; stale loser deprecated, not deleted; key-filtered recall reaches the family.
2. `key_census` returns scored candidate pairs using the same similarity seam as recall, reporting `rankFn`, plus the resolved alias map and loader warnings.
3. Replay of a derived claim is `exact` across a post-hoc alias change.
4. Empty/absent alias map is a behavioral no-op (existing 1,528+ tests green, no expectation edits).

## Out of scope (documented triggers)

| Deferred | Trigger to revisit |
|---|---|
| Write-time advisory in `remember` | Window evidence shows drift accumulating faster than census cadence catches it |
| Auto-suggest / auto-merge threshold | Enough census-score + ratify/ignore decisions accumulate to calibrate (census output is that dataset) |
| ⊕ evidence pooling / aggregation groupBy across aliases | A third alias-aware consumer appears — also the A2 (rename stage) trigger |
| Alias-map caching in recall | Measured recall latency regression (will not occur at dozens of alias claims) |
| Per-subject aliases; config-file alias map | Concrete observed need |
| Serving canonical keys (rewriting) | Product need for canonical-key views — pairs with the A2 trigger |
