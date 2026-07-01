# Recall Explain Trace — Design

**Date:** 2026-07-01
**Status:** Approved (brainstorming) → ready for implementation plan
**Cluster:** A (read-pipeline transparency) — first of the three clusters from the
Fireflies-dogfood roadmap (stoa: `rastate/synthesis-fireflies-dogfood-synthesis-ingestion`;
mneme claim `de70ba90`). Defines the reason-vocabulary contract that Clusters B/C inherit.

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
  imports retrieval; operators stay pure `Corpus → Corpus`) is preserved.
- **Not** the cardinality warning (Cluster C) or the dedupe-count product surfacing
  (Fix #5). This spec *defines* the reason vocabulary those consume; they are separate
  deliverables.

## Context

The canonical read stages live in `src/retrieval/read-pipeline.ts` (`canonicalReadStages`
+ `rankedTailStages`) and compose pure algebra operators from `src/algebra/*`. The
`→id` attributions we need ("merged into X", "deprecated by Y") live *inside*
`oplusDedupe`'s grouping and `pairsOf`'s contradiction pairs — which the operators
currently discard. `pairsOf` is already exported; the dedupe grouping is not.

## The reason vocabulary — the contract surface

This union is the **shared contract** the transparency + cardinality program is built on:
Cluster C reads the `deprecated-by … via: "single-cardinality"` variant; Fix #5 reads the
`merged-into` variant. When those clusters are planned together, this is the contract a
charter would own.

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

New module `src/retrieval/explain.ts` (retrieval layer — permitted to import algebra and
reuse the read-pipeline stages). One entry point:

```ts
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

1. **Candidates:** `leaf(corpus) → σ(subject?, key?)` → record candidate ids and their
   subject/key. (Claims filtered by σ never entered the read and are not traced.)
2. **`tau-invalid`:** run `tauValid(now)`; candidates present before but absent after →
   `tau-invalid`.
3. **`merged-into`:** **small DRY refactor** — extract `oplusDedupe`'s grouping into a pure
   exported helper (e.g. `dedupeGroups(rule, opts)(corpus) → { survivors, mergedInto: Map<lostId, survivorId> }`)
   that *both* `oplusDedupe` and the explainer call. The explainer reads `mergedInto` to
   attribute each merged-away claim. (Stays within algebra — no layering violation, and it
   is DRY, not a reimplementation.)
4. **`deprecated-by`:** call `pairsOf(corpus, threshold, { keyCardinality, keyAliases, … })`
   (already exported) with the SAME opts recall uses; for each claim `resolveDeprecateOlder`
   deprecated, find the pair it lost and record `byId` + `via: "single-cardinality"`.
5. **`alias-or-flag`:** claims removed by the drop stage that are alias-shaped or the
   contradiction flag key.
6. **rank / knobs / limit:** run the ranker; `below-floor` / `abstained` from the knob
   stages; `over-limit` from the slice (record `rank`). Remainder → `served` with `score`.

## Surface (both consumers, one object)

- **Library:** `explainRecall(...)` re-exported from `mneme/retrieval` (and the root
  barrel), returning `RecallTrace`.
- **MCP:** an opt-in `explain?: boolean` on the `recall` tool. When `true`, the result
  includes `trace: RecallTrace` (computed via the explainer path; the fast path is
  unchanged when `explain` is absent/false).
- **CLI:** a `mneme explain <about> [--subject --key --corpus]` command that pretty-prints
  the trace (per-stage counts + a table of dispositions).

## Error handling

`explainRecall` is **best-effort observability**: any failure re-deriving a stage yields a
partial trace with a `warnings: string[]` entry rather than throwing. When surfaced through
the MCP `recall` tool, an explain failure never fails the recall itself — the served result
is returned with the trace omitted and a warning.

## Testing

- **Dogfood reproductions** (the cases we hit live):
  - 3 distinct-value claims on one `single`-cardinality `(subject, key)`, increasing
    `valid.from` → trace shows 2× `deprecated-by … single-cardinality` + 1 `served`.
  - Same but the key declared `multi` → all 3 `served`, zero deprecations.
  - Two token-similar values (jaccard ≥ dedupe cutoff) → one `merged-into` the other.
  - A future-dated claim → `tau-invalid`.
  - Scores below `relevanceFloor` → `below-floor`; candidates past `limit` → `over-limit`.
- **Consistency invariant (the drift guardrail):** for the same query and deps,
  `explainRecall(...).claims.filter(d => d.disposition === "served").map(id)` **must equal**
  `recall(...).matches.map(id)` (as sets). If the re-derived explainer ever diverges from
  the real pipeline, this test fails loudly. This is the load-bearing test for the
  re-derive approach.

Test files: `src/retrieval/explain.test.ts` (unit + reproductions),
and a consistency test co-located there.

## Scope / future

- v1: `recall` explain only, disposition-granularity, re-derive mechanism.
- Later (separate specs): Cluster C consumes `deprecated-by` to warn on mass same-key
  deprecation; Fix #5 consumes `merged-into` to surface "N merged as restatements" in the
  normal recall result; possible `key_census` / bio-retrieval explain.
