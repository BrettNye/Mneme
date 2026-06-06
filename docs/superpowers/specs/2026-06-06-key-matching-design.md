# Key matching: census, ratified aliases, alias-aware contest (design)

**Date:** 2026-06-06
**Status:** Approved design, audited, pre-implementation
**Canonical spec:** `mneme-spec-v0.2-consolidated.md` — §4.8 (canonical read composition — this slice extends its grouping semantics), §4.6 (`SimilarityFn` seam — reused for key-pair scoring), §3.3 (keyCardinality precedent for declarative per-key inputs).
**Standing decisions honored:** [composition-first — no new operators; aliases are a declarative input on existing ⊥/σ] · [knobs-off-until-calibrated — census reports scores, never enforces a threshold] · [the wedge: deterministic, non-destructive, replayable — ratification is a supersedable claim, never a config-file mutation; stale losers are deprecated, not deleted] · [C3 transport — per-key options flow inputs → read-time `DetectionOptions`, never corpus schema].
**Driven by:** dogfood protocol Q2 (`docs/dogfood/2026-06-06-dogfood-protocol.md` §3) — near-duplicate keys (`editor` / `preferred_editor`) silently bypass ⊥ because claims with different keys never contest; the stale fact is never deprecated and pollutes served context. This slice builds the detect → declare → contest loop the protocol's census procedure performs manually.

## Decisions made during brainstorming (user-ratified)

1. **Layered intervention: detect → declare → contest.** Efficiency does not differentiate the intervention points (keys are short strings; distinct-key counts are tens-to-hundreds; every option costs µs–ms). The differentiator is the accuracy mechanism: lexical similarity cannot separate real drift from legitimate near-keys — token-jaccard scores `editor`↔`preferred_editor` (drift) and `finding-corpus-model`↔`finding-corpus-isolation` (legitimately distinct) **identically at 0.5**. No threshold replaces judgment, so enforcement requires a ratified input set; detect/declare/contest are the natural seams of the problem, not safety padding. Minimal build: census + map-consuming contest, ratification = a plain write. Write-time advisory **dropped** this slice.
2. **Aliases live in-corpus as claims, not config.** Ratifying is a `remember`; un-ratifying is supersession; replay reconstructs which aliases were active when. The long-run ratifier is an agent, and claims are MCP-writable with zero new write machinery; config.json would need file-write access and lives outside the auditable record.
3. **Alias reach: ⊥ grouping + σ key filters.** A ratified alias means "same attribute, everywhere a key identifies a claim group or filters a read." Excluded: the **standalone ⊕ operator** pooling evidence across aliased keys (observation-dedup territory, §5.6). Note the boundary precisely: canonical grouping inside ⊥ already means `clustersOf`'s per-valueHash confidence pooling spans stored keys within a contest group, and flag artifacts / `cluster.triple.key` carry the **canonical** key — that is in scope and intended; only the standalone ⊕ recipe stays alias-blind.
4. **Approach: alias-aware grouping via the options transport (A1), not a rename stage (A2).** A1 threads a flat alias map through `DetectionOptions` exactly as `keyCardinality` travels today; claims are never modified; served claims keep their stored keys (ledger-faithful view). A2 (an explicit canonicalization stage — relational algebra's actual rename ρ) gives structural consistency for all downstream operators but costs a new AST node + compile/replay/serialization obligations and silently serves rewritten keys — off-wedge without extra annotation machinery, and composition-first gates new operators while A1 expresses the need. The ⊕_dedupe alias-blindness under A1 is benign: aliased same-value claims fail to pool, then group canonically at ⊥ with the same valueHash → not a contradiction pair → both serve; κ's content-dedup catches the redundancy in the composed context (the `matches` array intentionally skips content-dedup, so duplicates MAY appear there — known behavior, not a bug). Aliased different-value claims are exactly the contest we want. **Documented trigger to revisit A2:** a third alias-aware consumer, or a product need to serve canonical keys.

## Audit amendments (2026-06-06, post-scan, fix-all authorized)

- **A1 (must):** the §4 "compiled form of the filter" obligation was phantom — the drop-deprecated/flag filter exists only as a retrieval-layer Stage closure (`read-pipeline.ts:68-71`), not in the AST; derived `queryExpression`s end at `resolve`. The only compile delta is threading `keyAliases` into `detectionOpts` for the resolve node (`compile.ts:~112`, parallel to `keyCardinality`). §4 rewritten.
- **A2 (must):** §6 stamping mechanism corrected. `stampResolveDefaults` reads `corpus.schema` from the **catalog**; aliases are **claims** (C3 forbids schema placement), so it cannot source the map. Mechanism: `deriveClaimFrom` (which holds the adapter) computes `aliasMapOf` over the corpus at `evaluationClock` and sets `keyAliases` **explicitly** on resolve nodes that lack it; `stampResolveDefaults` only preserves an explicit field (explicit-wins, like `threshold`) and never stamps aliases from schema. "No AST changes" corrected to: additive optional field on the resolve `ExprNode`, serialized by the generic canonicalizer for free, with explicit round-trip tests.
- **A3 (must):** `KeyAliasMap` is declared in **algebra** (`contradiction.ts`, structurally `Record<string,string>`); retrieval re-exports it. Algebra never imports retrieval (layering rule, `read-pipeline.ts:4`).
- **A4:** the alias shape predicate gets one owner: `src/retrieval/key-alias.ts` exports `KEY_ALIAS_KEY = "alias-of"`, `KEY_SUBJECT_PREFIX = "key:"`, `isKeyAliasShaped(claim)`. `read-pipeline.ts` (same layer) and `mcp/` (layer above) import it; prose restatements in §1/§2/§4 are references to this single function.
- **A5:** the MCP schema auto-stamp is **dropped**. It had no functional consumer (loader, filter, census all match on shape, deliberately, to cover non-MCP writes) and would have produced an unreliable marker (present only on MCP-written aliases) while special-casing the generic remember handler. The shape IS the marker; `Claim.schema` keeps its uniform `corpusId@version` stamp.
- **A6:** census `corpus` defaults to the server's `defaultCorpus` (basename of `CLAUDE_PROJECT_DIR`), like every sibling tool — not `"knowledge"`. `limit` truncates the score-sorted pair list. Loader param named `corpus`.
- **A7:** the loader's parallel pass-1 recipe is justified by **three** divergences from `canonicalReadStages`, all documented at the definition so a DRY-minded refactor doesn't reintroduce them: (a) the serving filter would drop alias-shaped claims; (b) **no ⊕_dedupe** — semantic, not convenience: jaccard@0.5 can sub-merge two same-variant alias claims pointing at token-similar but DIFFERENT canonicals (`editor` vs `preferred_editor` score 0.5 ≥ cutoff), silently collapsing a supersession/tie into one claim and corrupting the map; (c) **forced all-single cardinality** ignoring the project's config (a stray `"alias-of": "multi"` would disable alias supersession entirely).
- **A8:** hybrid warm-up scope follows σ: the warm-up read uses the **expanded key family**, not the literal `key` arg — otherwise cross-family claims (the exact claims this feature exists to retrieve) silently degrade to jaccard while `rankFn` still reports "hybrid". Census likewise warms the key strings (`warmValues`) before hybrid pair scoring.
- **A9:** Error handling section added (house convention; see §7).
- **A10:** test plan extended: census unit tests (fallback `rankFn`, warnings in output, `limit`, unknown corpus), variant-direction recall, ExprNode round-trip for `keyAliases`.
- **A11:** cardinality declared on a **variant** key is not silently ignored: the map consumer (MCP recall opts build; census report) warns when any `keyCardinality` key is a variant in the resolved map. Loud-over-silent discipline.
- **A12:** alias matching is **case-sensitive exact-string** (stated; the census tokenizer lowercases, so census may score `Editor`↔`editor` at 1.0 — ratify both directions if both casings exist). **Meta-aliases excluded:** a mapping whose variant or canonical is itself `alias-of` or `key:`-prefixed is dropped from the map with a warning. For un-ratify observability, census lists active self-aliases as "un-ratified".
- **A13:** σ family expansion uses a new `keyIn` predicate (mirrors existing `subjectIn`; additive union member in `predicate.ts` — a predicate form, not an operator). The loader and serving filter use plain closures with `isKeyAliasShaped`; no subject-prefix predicate enters the σ vocabulary.

## Design

### 1. Alias claim convention (no new write machinery)

A ratified alias is an ordinary claim:

```
subject: "key:<variant>"        e.g. "key:preferred_editor"
key:     "alias-of"             (KEY_ALIAS_KEY)
value:   "<canonical>"          e.g. "editor"
```

- **Ratify** = `remember` with this shape (existing MCP tool, unchanged — no write-path code in this slice).
- **Re-point** = write again; supersession picks the newer (⊥ + `resolveDeprecateOlder` operating on alias claims themselves).
- **Un-ratify** = write a self-alias (`key:preferred_editor` → value `"preferred_editor"`). Identity mapping; drops out of the resolved map. No tombstone semantics.
- **Scope:** corpus-wide. Keys are corpus-global; per-subject aliasing is YAGNI.
- **Marker semantics:** the operative identifier is the shape — `isKeyAliasShaped`: `key === KEY_ALIAS_KEY` ∧ subject starts with `KEY_SUBJECT_PREFIX` (A4/A5). Shape covers alias claims written through any path, MCP or library. `Claim.schema` is untouched (uniform `corpusId@version`).
- Matching is **case-sensitive exact-string** end-to-end (A12).

### 2. Alias map loader (`src/retrieval/key-alias.ts` — NEW, sibling of `read-pipeline.ts`)

The loader is a read recipe, so it lives in the retrieval layer (algebra = mechanisms, retrieval = recipes, MCP = surface). Exports: `KEY_ALIAS_KEY`, `KEY_SUBJECT_PREFIX`, `isKeyAliasShaped`, `aliasMapOf`, `keyFamilyOf`, and re-exports algebra's `KeyAliasMap` (A3).

```ts
export type KeyAliasMap = ... // re-export from "../algebra/contradiction.js"

export interface AliasLoadResult {
  map: KeyAliasMap;      // variant → canonical, chains pre-resolved, flat
  warnings: string[];    // cycles dropped, ties dropped, meta-aliases dropped, malformed values ignored
}

/**
 * Pass 1 (alias-blind): isKeyAliasShaped survivors of
 *   τ_valid(t) → ⊥ + resolveDeprecateOlder → drop deprecated/flag artifacts.
 * Deliberately NOT canonicalReadStages — three semantic divergences (A7):
 *   (a) the canonical serving filter drops alias-shaped claims;
 *   (b) no ⊕_dedupe — jaccard@0.5 could sub-merge same-variant claims pointing
 *       at token-similar but DIFFERENT canonicals, corrupting the map;
 *   (c) cardinality forced all-single, ignoring project config.
 * No regress: "alias-of" is one fixed key; this pass needs no alias map.
 *
 * Pass 2: build variant→canonical pairs from survivors; resolve chains to
 * fixpoint (a→b, b→c ⇒ a→c); deterministic degradation:
 *   - cycles (a→b, b→a): drop all cycle members; warn.
 *   - resolution ties for one variant: flag artifact (existing behavior),
 *     variant dropped from the map; warn.
 *   - self-alias: identity; excluded from the map (un-ratify).
 *   - meta-alias (variant or canonical is "alias-of" or "key:"-prefixed):
 *     dropped; warn (A12).
 *   - malformed value (non-string/empty): claim ignored; warn.
 * Degraded-but-deterministic, never a throw: the ledger is append-only, so a
 * bad alias write is fixed by superseding it, and recall must keep working.
 * The loader is side-effect-pure: warnings are RETURNED; the MCP layer
 * surfaces them on stderr (house convention — tools/retrieval stay pure).
 */
export function aliasMapOf(corpus: Corpus, opts: { evaluationInstant: number }): AliasLoadResult;

/** All keys sharing key's canonical, plus the canonical itself; [key] when unmapped.
 *  Works from either direction — variant or canonical input reaches the family. */
export function keyFamilyOf(key: string, map: KeyAliasMap): string[];
```

### 3. Alias-aware ⊥ grouping (`src/algebra/contradiction.ts` — additive)

```ts
export type KeyAliasMap = Record<string, string>; // declared HERE (A3)

export interface DetectionOptions {
  keyCardinality?: Record<string, "single" | "multi">;
  keyAliases?: KeyAliasMap; // flat, pre-resolved — no chains/cycles reach algebra
}
```

- Grouping becomes `(subject, canonical(key), scopeHash)` where `canonical(k) = keyAliases?.[k] ?? k` — a lookup at the existing `claimTripleKey` grouping site (`contradiction.ts:48-49`). Resolution operators untouched; they already work on clusters. Flag artifacts and `cluster.triple.key` carry the canonical key (Decision 3).
- `cardinalityOf` consults the **canonical** key (single existing site, `contradiction.ts:43`): declare cardinality on the canonical, variants inherit. Cardinality declared only on a variant triggers a warning at the map-consumer sites (A11), never silent.
- `predicate.ts` gains `keyIn` (mirrors `subjectIn`) for σ family expansion (A13).
- Algebra core stays mechanism-only: it receives a flat map and knows nothing about where it came from. Chain/cycle/meta handling is the loader's job (retrieval layer).

### 4. Read pipeline + MCP recall threading (`src/retrieval/read-pipeline.ts`, `src/mcp/tools.ts`)

- `ReadPipelineOpts` gains `keyAliases?: KeyAliasMap`, forwarded to the resolve stage's `DetectionOptions` — the exact path `keyCardinality` travels (C3 transport). The compile-side delta is the same threading into the resolve node's `detectionOpts` (`compile.ts:~112`); **no filter compilation exists or is added** (A1).
- The canonical post-resolve filter (a retrieval Stage closure) additionally drops `isKeyAliasShaped` claims — alias claims are infrastructure, not servable content.
- MCP `recall` flow per call: fetch alias claims (adapter plan `{ corpusId, key: KEY_ALIAS_KEY }` — index-backed) → `aliasMapOf` → pass `map` into `ReadPipelineOpts`; surface loader warnings on stderr; warn on variant-declared cardinality (A11). When the `key` argument is present, σ uses `{ op: "keyIn", values: keyFamilyOf(key, map) }`, and the **hybrid warm-up read uses the same expanded family** (A8). No map caching this slice (alias claims number in the dozens; see Out of scope).
- Served claims keep their **stored** keys. Externally visible changes: stale aliased losers stop appearing (deprecated by ⊥); key-filtered recall reaches across the family from either direction; aliased same-value duplicates may appear in `matches` (κ dedups the composed context only — Decision 4).

### 5. Census tool (`key_census` — NEW MCP tool, read-only)

Implemented as a pure function over `Session` in `src/mcp/tools.ts` (house structure), registered with a Zod schema in `src/mcp/server.ts` like its siblings.

- **Input:** `corpus` (default: the server's `defaultCorpus`, like every other tool — A6), `limit` (default 20; truncates the score-sorted candidate-pair list).
- **Output (structured + composed text):**
  - distinct keys with claim counts (the protocol's manual census, automated);
  - candidate near-duplicate key pairs scored pairwise by the **same `SimilarityFn` seam recall uses** — `hybridMax(jaccard, cosine)` when the embedding model is loaded, jaccard fallback — with `rankFn` reported exactly as recall reports it; key strings warmed via `warmValues` before cosine scoring (A8);
  - pairs sorted by score descending, **no enforcement threshold** (knobs-off): the scores plus subsequent ratify/ignore decisions are the labeled dataset that would eventually calibrate an auto-suggest threshold;
  - currently ratified aliases (the resolved map), active self-aliases listed as "un-ratified" (A12), loader warnings (cycles, ties, meta-aliases), and variant-declared-cardinality warnings (A11);
  - the ready-to-paste `remember` shape for ratifying a pair (affordance only — census never writes, never logs to the recall-log).
- Cost: O(K²) pairwise over distinct keys, K ≈ tens — ms lexical, ~seconds embedding on first warm. On-demand only; never on the recall path.

### 6. Replay & provenance (`src/write/derive.ts`, `src/algebra/ast.ts` — additive)

- The resolve `ExprNode` gains an optional `keyAliases` field — additive; serialized by the generic canonicalizer; explicit round-trip tests added (A2).
- **Snapshot mechanism (A2):** `deriveClaimFrom` — which holds the adapter — computes `aliasMapOf` over the corpus at `evaluationClock` and sets `keyAliases` explicitly on any resolve node that lacks it. `stampResolveDefaults` preserves an explicit field (explicit-wins, like `threshold` today) and **never stamps aliases from corpus schema** (aliases are claims; C3 forbids schema placement).
- A derived claim's `queryExpression` therefore carries the alias-map snapshot active at derivation — replay reproduces exactly even after aliases are re-pointed or un-ratified, because replay re-executes the serialized node, not the live map.

### 7. Error handling (A9)

| Path | Behavior |
|---|---|
| Bad alias **data** (cycles, ties, meta-aliases, malformed values) | Deterministic degradation per §2 — drop from map, warn; never a throw |
| Alias-claim **fetch fails** during recall (adapter error) | Degrade alias-less (empty map) + stderr warning — recall keeps working; consistent with the embeddings-fallback posture |
| Census on unknown corpus | Empty report, no corpus created (recall's read-only precedent) |
| Mixed confidence-distribution throw (`clustersOf`, `contradiction.ts:85-91`) | **Known interaction, named:** canonical grouping can newly co-locate same-value claims from different stored keys whose confidences use different distributions (e.g. scalar vs Beta), turning a previously-fine corpus into a recall error after ratification. Not handled this slice — pre-existing throw, enlarged surface; recorded for the bio-efficacy slice (which owns scalar→Beta promotion, cf. predecessor C7) |
| Warning transport | Loader/census return warnings (pure); the MCP layer writes stderr (house convention) |

### 8. Testing

- **Unit:** `key-alias.test.ts` — chains, cycles, self-alias, ties, meta-aliases, malformed values, case sensitivity, supersession among alias claims, `keyFamilyOf` both directions, `isKeyAliasShaped` near-miss shapes. `contradiction.test.ts` — canonical grouping, cardinality-via-canonical, flag artifact carries canonical key, absent-map = today's behavior byte-for-byte. `predicate.test` coverage for `keyIn`. ExprNode round-trip with `keyAliases` (A10).
- **Census unit tests (A10):** fake adapter, house style — pair scoring with jaccard fallback (`rankFn` reported), warnings in output, `limit` truncation, unknown corpus → empty report.
- **Integration (MCP-level), the Q2 scenario end-to-end:** write `editor`, write `preferred_editor` with a newer conflicting value → both serve (drift demonstrated); ratify the alias → only the newest serves; `key: "editor"` AND `key: "preferred_editor"` (variant direction — A10) both retrieve across the family; census reports the scored pair pre-ratification and the resolved alias post-ratification. Warm-up family test: hybrid fake adapter + ratified alias → variant-key claim scored by cosine, not jaccard (A8).
- **Replay:** derive a claim with snapshotted aliases; supersede the alias; replay → `exact` (the serialized node isolates derived claims from map evolution).
- **Regression:** full suite green; recall with zero alias claims is behavior-identical to today (empty map = identity; no expectation edits).

### 9. Acceptance criteria

1. The Q2 integration scenario passes: drifted pair contests after ratification; stale loser deprecated, not deleted; key-filtered recall reaches the family from either direction.
2. `key_census` returns scored candidate pairs using the same similarity seam as recall, reporting `rankFn`, plus the resolved alias map, un-ratified self-aliases, and loader/cardinality warnings.
3. Replay of a derived claim is `exact` across a post-hoc alias change (round-trip-tested serialized `keyAliases` on the resolve node).
4. Empty/absent alias map is a behavioral no-op (existing 1,528+ tests green, no expectation edits).

## Out of scope (documented triggers)

| Deferred | Trigger to revisit |
|---|---|
| Write-time advisory in `remember` | Window evidence shows drift accumulating faster than census cadence catches it |
| Auto-suggest / auto-merge threshold | Enough census-score + ratify/ignore decisions accumulate to calibrate (census output is that dataset) |
| Standalone ⊕ pooling / aggregation groupBy across aliases | A third alias-aware consumer appears — also the A2 (rename stage) trigger |
| Alias-map caching in recall | Measured recall latency regression (will not occur at dozens of alias claims) |
| Per-subject aliases; config-file alias map | Concrete observed need |
| Serving canonical keys (rewriting) | Product need for canonical-key views — pairs with the A2 trigger |
| Mixed-distribution co-location throw under canonical grouping | Bio-efficacy slice (owns scalar→Beta promotion; predecessor C7) |
