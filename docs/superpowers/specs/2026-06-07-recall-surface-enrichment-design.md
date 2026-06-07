# Recall surface enrichment: coverage annotation + provenance handles (design)

**Date:** 2026-06-07
**Status:** Approved design, pre-implementation
**Driven by:** the abstention deep-dive (bench/RESULTS.md 2026-06-07): score thresholds net-negative at N=229; unanswerability is dominantly MISSING-ENTITY structure; `entityCoverage` is the first net-positive abstention mechanism (62.5% flag precision vs 26% for the best threshold, 3.1% collateral) — and it is EXPLAINABLE. Plus the capstone's scoring seam: `RecallResult.matches` lacks claim identity, so callers cannot cite or attribute served memories.
**Standing decisions honored:** [annotation, not abstention — the substrate reports structured facts; the CALLING AGENT decides refusal (mirrors the ratification philosophy: judgment stays outside, auditable)] · [composition-first — no new operators; coverage is a retrieval-layer recipe over served claims] · [auditable wording — every warning must be true by construction] · [knobs-off — no auto-abstention dial ships; the agent consumes facts].

## User-ratified decisions

1. **One slice, two enrichments:** coverage annotation AND provenance handles (`id`, `tags` on matches) — same surface, same review pass; closes the capstone scoring seam as a side effect.
2. **Shape: structured field + warning line.** Machine-consumable `coverage` field always present; ONE combined human-readable warning when entities are missing (rides the existing warnings channel → stderr surfacing free).
3. **Placement: retrieval layer** (`src/retrieval/coverage.ts`) — pure recipe functions, MCP consumes; the bench study that validated the signal imports the same code (kills the bench/product drift risk). `key-alias.ts` placement precedent.

## Design decisions (defaults, stated)

- **Extraction = the validated heuristic v1** behind a named seam: mid-sentence capitalized tokens + number-bearing tokens (e.g. "991"), question-word stoplist, dedup. This is exactly what the 62.5%-precision evidence validated. The seam (`entityTokensOf`) is the documented swap point for a real NER later — consumers never change.
- **Compute basis = the SERVED set** (post-pipeline survivors the recall actually consulted — the basis the study validated). Warning wording is therefore "no claim served by this recall mentions 'X'" — true by construction. NOT "zero corpus support", which could be false (a deprecated or τ-excluded claim may mention X).

## Design

### 1. `src/retrieval/coverage.ts` (NEW — sibling of key-alias.ts)

```ts
import type { Claim } from "../core/claim.js";

/** Question-word/stopword list for entity extraction (exported for tests). */
export const ENTITY_STOPWORDS: ReadonlySet<string>;

/**
 * Entity-ish tokens of a question text: mid-sentence capitalized words and
 * number-bearing tokens ("991", "4th"), minus ENTITY_STOPWORDS, deduplicated,
 * input order preserved. HEURISTIC v1 — the named swap seam for a future NER;
 * validated on LongMemEval-oracle (62.5% flag precision). English-capitalization
 * dependent; lowercase entities and paraphrases are known misses (documented).
 */
export function entityTokensOf(text: string): string[];

export interface CoverageEntity { text: string; supported: boolean }
export interface CoverageReport {
  entities: CoverageEntity[]; // one per extracted token, extraction order
  missing: string[];          // unsupported subset, extraction order
}

/**
 * Case-insensitive containment scan of each entity over the claims'
 * subject + key + String(value) text. Pure, deterministic, model-free.
 * Empty entity list ⇒ { entities: [], missing: [] }.
 */
export function coverageOf(entities: readonly string[], claims: readonly Claim[]): CoverageReport;
```

- Barrel-exported from `src/index.ts` (with the other retrieval recipes).
- DRY note: `bench/longmemeval/manual/abstention-signals.ts` migrates its inline
  extraction/coverage to import these (one implementation; the bench study stays
  the standing verification instrument for the signal, mirroring how bench arm A
  verifies `canonicalReadStages`).

### 2. Recall integration (`src/mcp/tools.ts`)

- `RecallResult` gains `coverage: CoverageReport` — ALWAYS present (empty-entities questions get empty arrays; abstained/empty results still report — all-missing is precisely when the calling agent most needs the fact).
- Computed over the **served survivors** (the post-pipeline claims recall ranked — the same array `matches` is drawn from, NOT just the top-k slice).
- When `missing` is non-empty, push ONE combined warning: `question entities with no supporting claim served: 'Sacramento', 'Porsche'` — existing warnings channel; server's existing stderr loop surfaces it unchanged.
- `recall` stays pure (no I/O); the helper composes with the existing flow — coverage computation is one call after the pipeline run.

### 3. Provenance handles (`src/mcp/tools.ts`)

- `matches[]` entries gain `id: string` and `tags: string[]` (copied from the served claim). Agents can now cite the exact claim ("per memory claim 8f3a…, recorded 2026-03-01") and scorers can attribute sessions — closing the capstone seam.
- No other match fields change; additive only.

### 4. Server registration (`src/mcp/server.ts`)

- Recall `outputSchema` gains `coverage` (object: entities array of {text, supported}, missing array) and per-match `id`/`tags`; `structuredContent` passes both through. BOTH sites enumerate fields explicitly — omitting either silently drops the data (the documented S5 lesson from the key-matching plan audit).
- `key_census` is **deliberately not extended**: coverage is question-relative; census has no question. Scope note, not an omission.

### 5. Error handling

| Path | Behavior |
|---|---|
| Extraction on any string | Never throws (regex + set ops); empty/whitespace text ⇒ `[]` |
| Empty entity list | `coverage` present with empty arrays; NO warning |
| Zero served claims (abstained/empty corpus) | All entities reported missing; warning fires — intended (strongest signal for the agent) |
| Non-string claim values | `String(value)` before scan (matches census/judge precedent) |

### 6. Testing

- **Unit (`src/retrieval/coverage.test.ts`):** extraction — capitalized mid-sentence, sentence-initial question words excluded, number-bearing tokens ("991"), stopwords, dedup, order stability, empty input; coverage — containment across subject/key/value, case-insensitivity, empty entities, empty claims (all missing).
- **Recall integration (`src/mcp/tools.test.ts`):** missing entity ⇒ structured field + the single combined warning; fully covered ⇒ field present, no coverage warning; abstained-style empty result ⇒ all-missing; `matches[].id`/`tags` present and equal to the written claim's.
- **Server integration (`src/mcp/server.integration.test.ts`):** `coverage` + `id`/`tags` round-trip through `structuredContent` over the MCP client.
- **Bench migration check:** `abstention-signals.ts` compiles against the shared module and its qualitative output is unchanged (spot value).
- **Regression:** full suite green; both additions are additive (existing tests assert field-level — no expectation edits, the established N6 precedent).

### 7. Acceptance criteria

1. Recall on a corpus lacking a question entity returns `coverage.missing` containing it AND one combined warning naming it, with wording that is true by construction ("served", not "corpus").
2. Recall on a fully-covered question returns `coverage` with all `supported: true` and NO coverage warning.
3. Every match carries `id` and `tags` matching the underlying claim; visible over the MCP boundary in `structuredContent`.
4. `entityTokensOf`/`coverageOf` are pure, barrel-exported, and consumed by both the MCP recall and the bench abstention study (single implementation).
5. Full suite green with zero pre-existing expectation edits.

## Out of scope (documented triggers)

| Deferred | Trigger |
|---|---|
| Auto-abstention from coverage | Never as a silent default; an OPT-IN dial only if dogfood/agent feedback asks (the agent-decides posture is the design) |
| Real NER behind `entityTokensOf` | Measured misses in dogfood/haystack (lowercase entities, paraphrases) |
| Census coverage | A question-like input ever arriving at census |
| Whole-corpus (vs served) coverage basis | A consumer needing "has the corpus EVER heard of X" — different question, different wording obligations |
| Attribute-level coverage (the bio-residual class) | Bio slice (evidence-confidence inputs) |
