# Recall Explain Trace — Design

**Date:** 2026-07-01
**Status:** Approved (brainstorming) → ready for implementation plan
**Cluster:** A (read-pipeline transparency) — first of the three clusters from the
Fireflies-dogfood roadmap (stoa: `rastate/synthesis-fireflies-dogfood-synthesis-ingestion`;
mneme claim `de70ba90`). Defines the reason-vocabulary contract that Clusters B/C inherit.

> **Revision 2026-07-01 (post ops-layer migration).** The operations layer
> (`recall`/`remember`/`keyCensus` + `EmbeddingState`/`RecallDeps`/`RecallArgs` + corpus
> ops) moved from `src/mcp` to `src/surface` (main @ `3b640fe`); MCP is now thin transport.
> `explainRecall` and the `RecallTrace`/`ClaimDisposition`/`DispositionReason` types
> therefore land in **`src/surface`**, next to the migrated `recall` — not `src/retrieval`
> as originally drafted. The reason-vocabulary contract below is unchanged; only the module
> home, the layering rationale, and the export surface changed. See **Layering** below.

## Goal

Make a `recall` **explainable**: for a given query, produce a per-claim trace stating
*why* each candidate claim was served / merged / deprecated / dropped, plus per-stage
counts. This turns the opaque read pipeline
(`σ → τ_valid → ⊕_dedupe → ⊥/resolveDeprecateOlder → drop → ρ → abstain/floor → limit`)
into an auditable **read-provenance**.

Motivation: in the 2026-07-01 Fireflies dogfood, a capable agent reasoned about what
`recall` would serve and was **wrong 4–5 times** — the stage interaction is genuinely
opaque. For a substrate whose differentiator is auditability, "why did recall serve these
claims and not those?" must be answerable. This is also *why the benchmarks hinted but
missed* the ingestion findings: they measure outcomes (`updateCorrect`, `recall@k`) but
cannot show the mechanism.

## Non-goals

- **Not all reads** — `recall` only. Not `key_census`, not bio's signal retrieval
  (`RetrievalContext`/`RetrievalPolicy`). Those are separate, later, if ever (YAGNI).
- **No mutation, no generated knowledge** — pure observation. This is read-side
  observability, categorically distinct from bio's write-side cognitive passes
  (`createDreamPass`/`createConsolidatePass`): a `RecallTrace` is read-provenance, not a
  `CycleReport` change-log.
- **Does not instrument the algebra operators** — the layering contract (algebra never
  imports retrieval or surface; operators stay pure `Corpus → Corpus`) is preserved.
- **Not** the cardinality warning (Cluster C) or the dedupe-count product surfacing
  (Fix #5). This spec *defines* the reason vocabulary those consume; they are separate
  deliverables.

## Context

The canonical read core lives in `src/retrieval/read-pipeline.ts` (`canonicalReadStages`;
`rankedTailStages` is a sibling recipe). The migrated `recall` in `src/surface/recall.ts`
composes it directly:

```
leaf → σ(subject?, keyIn family) → canonicalReadStages(τ_valid → ⊕_dedupe → ⊥/resolve → drop)
     → ranker (rho.by | rho.blend, inline — NOT rankedTailStages) → abstain/floor knobs (in-memory) → limit slice
```

Crucially, **`src/surface` already imports both `src/retrieval` and `src/algebra`**:
`recall.ts` imports `canonicalReadStages` from `../retrieval/read-pipeline.js`,
`aliasMapOf`/`keyFamilyOf` from `../retrieval/key-alias.js`, `coverageOf` from
`../retrieval/coverage.js`, and algebra ops (`sigma`, `rho`, `oplusDedupe`'s siblings,
`abstainBelowTop`, `relevanceFloor`) directly. So the original reason for placing the
explainer in `src/retrieval` (it needs algebra + pipeline access) is satisfied *equally*
from `src/surface` — and co-locating with `recall` keeps the consistency invariant (below)
a same-file guarantee.

The `→id` attributions we need ("merged into X", "deprecated by Y") live *inside*
`oplusDedupe`'s grouping (`src/algebra/combination.ts`) and `pairsOf`'s contradiction pairs
(`src/algebra/contradiction.ts`) — which the operators currently discard. `pairsOf` is
already exported; the dedupe grouping is not.

## The reason vocabulary — the contract surface

This union is the **shared contract** the transparency + cardinality program is built on:
Cluster C reads the `deprecated-by … via: "single-cardinality"` variant; Fix #5 reads the
`merged-into` variant. When those clusters are planned together, this is the contract a
charter would own. **Unchanged by the migration.**

```ts
interface RecallTrace {
  corpus: string;
  candidateCount: number;            // claims after the σ (subject/key) filter
  stageCounts: {                     // survivor count after each stage
    afterTau: number;
    afterDedupe: number;
    afterContradiction: number;      // after ⊥/resolveDeprecateOlder + the drop stage
    ranked: number;
    afterKnobs: number;              // after abstain + relevanceFloor
    served: number;                  // after the limit slice
  };
  claims: ClaimDisposition[];        // one entry per candidate claim
  warnings?: string[];               // best-effort re-derive failures (never throws)
}

interface ClaimDisposition {
  id: string;
  subject: string;
  key: string;
  disposition: "served" | "merged" | "deprecated" | "dropped";
  reason: DispositionReason;
  score?: number;                    // present iff the claim reached ranking
}

type DispositionReason =
  | { kind: "served" }
  | { kind: "merged-into"; targetId: string }                          // ⊕_dedupe        (Fix #5)
  | { kind: "deprecated-by"; byId: string; via: "single-cardinality" } // ⊥/resolve        (Cluster C)
  | { kind: "tau-invalid" }                                            // τ_valid
  | { kind: "below-floor"; score: number; floor: number }             // relevanceFloor
  | { kind: "abstained"; topScore: number; threshold: number }        // abstainBelowTop
  | { kind: "over-limit"; rank: number; limit: number }               // limit slice
  | { kind: "alias-or-flag" };                                         // infra drop stage
```

`via: "single-cardinality"` is a discriminated field (not a bare boolean) so future
resolution modes (e.g. `deprecate-lower`, `deprecate-minority`) extend the union without a
breaking change.

## Architecture

New module `src/surface/explain.ts` (surface layer — permitted to import algebra and the
retrieval read-pipeline stages, exactly as its neighbor `recall.ts` does). One entry point,
signature-aligned with the migrated `recall`:

```ts
import type { Session } from "./types.js";
import type { RecallArgs, RecallDeps } from "./recall.js";

export function explainRecall(
  session: Session,
  args: RecallArgs,
  deps: RecallDeps,
): Promise<RecallTrace>;
```

It composes the **same** stages as `recall`, but **stage-by-stage**, capturing the corpus
between stages and re-deriving attributions. `recall()` itself is untouched → **zero
hot-path cost** when not explaining. `explainRecall` is invoked only on the opt-in path.

## Mechanism — re-derive (not instrument)

Mirror `recall`'s exact composition (including σ subject filter + alias key-family
expansion, and the *inline* ranker/knobs — **not** `rankedTailStages`, so the re-derivation
tracks the real served path):

1. **Candidates:** `leaf(corpus) → σ(subject?, keyIn family)` — using the SAME alias map /
   key-family expansion `recall` builds via `loadAliasContext` + `keyFamilyOf` — then record
   candidate ids and their subject/key. (Claims filtered by σ never entered the read and are
   not traced. `candidateCount` = survivors of σ.)
2. **`tau-invalid`:** run `tauValid(now)` with the same `now = parseAsOf(args.asOf) ?? Date.now()`
   recall uses; candidates present before but absent after → `tau-invalid`.
3. **`merged-into`:** **small DRY refactor** — extract `oplusDedupe`'s grouping
   (`src/algebra/combination.ts`) into a pure exported helper (e.g.
   `dedupeGroups(rule, opts)(corpus) → { survivors, mergedInto: Map<lostId, survivorId> }`)
   that *both* `oplusDedupe` and the explainer call. The explainer reads `mergedInto` to
   attribute each merged-away claim. (Stays within algebra — no layering violation, DRY not
   a reimplementation.)
4. **`deprecated-by`:** call `pairsOf(corpus, threshold, { keyCardinality, keyAliases, evidencePoolingRule })`
   (already exported) with the SAME opts recall passes into `canonicalReadStages`; for each
   claim `resolveDeprecateOlder` deprecated, find the pair it lost and record `byId` +
   `via: "single-cardinality"`.
5. **`alias-or-flag`:** claims removed by the drop stage that are alias-shaped
   (`isKeyAliasShaped`) or carry the contradiction flag key (`CONTRADICTION_FLAG_KEY`).
6. **rank / knobs / limit:** run the same ranker recall builds (`rho.by` when
   `recencyAlpha === 1`, else `rho.blend` with `alpha`/`halfLifeDays`); `below-floor` /
   `abstained` from the `relevanceFloor` / `abstainBelowTop` knob stages; `over-limit` from
   the `limit` slice (record `rank`). Remainder → `served` with `score`.

## Surface (both consumers, one object)

- **Library:** `explainRecall(...)` + the `RecallTrace`/`ClaimDisposition`/`DispositionReason`
  types re-exported from **`src/surface/index.ts`** (the `mneme/surface` entry), and from the
  **root barrel `src/index.ts`** (the `mneme` entry) — mirroring how `recall` is exported
  today. Returns `RecallTrace`.
- **MCP:** an opt-in `explain?: boolean` on the `recall` tool in `src/mcp/server.ts`. When
  `true`, the handler calls `explainRecall` (imported from `../surface/index.js`, same as it
  imports `recall`) and includes `trace: RecallTrace` in `structuredContent`. The fast path
  is unchanged when `explain` is absent/false — `recall` is called exactly as now.
- **CLI:** a `mneme explain <about> [--subject --key --corpus]` command that pretty-prints
  the trace (per-stage counts + a table of dispositions).

## Layering

- `explainRecall` lives in `src/surface`; it imports from `src/retrieval` and `src/algebra`
  (permitted — `recall.ts` already does). It **must not** import from `src/mcp` — enforced by
  `src/surface/layering.test.ts` ("no file under src/surface or src/retrieval imports from
  src/mcp").
- The `dedupeGroups` helper stays in `src/algebra/combination.ts`. Algebra never imports
  retrieval or surface; operators stay pure `Corpus → Corpus`.
- MCP depends inward on surface (`src/mcp/server.ts` imports `explainRecall` from
  `../surface/index.js`), never the reverse.

## Error handling

`explainRecall` is **best-effort observability**: any failure re-deriving a stage yields a
partial trace with a `warnings: string[]` entry rather than throwing. When surfaced through
the MCP `recall` tool, an explain failure never fails the recall itself — the served result
is returned with the trace omitted and a warning.

## Testing

Test file: `src/surface/explain.test.ts` (unit + reproductions + the consistency test,
co-located with the explainer).

- **Dogfood reproductions** (the cases we hit live):
  - 3 distinct-value claims on one `single`-cardinality `(subject, key)`, increasing
    `valid.from` → trace shows 2× `deprecated-by … single-cardinality` + 1 `served`.
  - Same but the key declared `multi` → all 3 `served`, zero deprecations.
  - Two token-similar values (jaccard ≥ dedupe cutoff) → one `merged-into` the other.
  - A future-dated claim → `tau-invalid`.
  - Scores below `relevanceFloor` → `below-floor`; candidates past `limit` → `over-limit`.
- **Consistency invariant (the drift guardrail):** for the same query and deps,
  `explainRecall(...).claims.filter(d => d.disposition === "served").map(d => d.id)` **must
  equal** `recall(...).matches.map(m => m.id)` (as sets). Now a *same-directory* guarantee —
  both live in `src/surface`. If the re-derived explainer ever diverges from the real
  pipeline, this test fails loudly. This is the load-bearing test for the re-derive approach.
- **Layering:** `src/surface/layering.test.ts` continues to pass (explain.ts imports no mcp).
- **Back-compat:** `src/mcp/backcompat.test.ts` — the `recall` tool without `explain` returns
  the identical shape it does today.

## Scope / future

- v1: `recall` explain only, disposition-granularity, re-derive mechanism, in `src/surface`.
- Later (separate specs): Cluster C consumes `deprecated-by` to warn on mass same-key
  deprecation; Fix #5 consumes `merged-into` to surface "N merged as restatements" in the
  normal recall result; possible `key_census` / bio-retrieval explain.
