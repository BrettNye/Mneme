# MCP dogfood upgrade: retrieval layer, full-algebra recall, dogfood conventions (design)

**Date:** 2026-06-06
**Status:** Approved design, pre-implementation
**Canonical spec:** `mneme-spec-v0.2-consolidated.md` — §4.8 (canonical read-side composition note — this slice reifies it in code), §4.6 (`SimilarityFn`/`sim_cosine`), §3.2/§3.3 (schema, defaults).
**Standing decisions honored:** [dogfood-via-MCP first, recall must exercise the algebra] · [single embedding abstraction — PR #21's `EmbeddingAdapter` port] · [two-knob read surface: `abstainBelowTop` (abstention) + `relevanceFloor` (precision)] · [composition-first].
**Driven by:** post-PR#21 board — dogfooding is the standing first priority and the cheapest test of H2 (does the algebra survive un-curated reality?). The MCP server exists (src/mcp — remember/recall/list_corpora, per-repo corpus via CLAUDE_PROJECT_DIR, connected to the user's Claude Code today) but recall runs only σ→ρ.jaccard→κ — no temporal slice, no dedupe, no ⊥/resolve, no knobs, no embeddings.

## Decisions made during brainstorming (user-ratified)

1. **Embedding wiring — graduate to src with graceful fallback.** One implementation (single-abstraction rule): `createLocalEmbeddingAdapter` moves from bench to **`src/adapters/embedding/transformers-local.ts`** — a NEW `src/adapters/embedding/` directory so future models/providers are sibling files beside the same port (user call: "sep folders for embed vs different models"). The transformers import stays DYNAMIC inside the function (core deps stay 3-lean). The MCP server lazy-initializes on first recall; if the package/model is unavailable, it logs one stderr warning and serves jaccard — the server never dies for lack of a model. Bench imports the adapter from src (its local copy deleted; `warmForQuestion` stays bench-side, it's record-shaped).
2. **Knob defaults — off + observability first.** `abstainBelowTop`/`relevanceFloor` recall args default 0 (off) for the first dogfood window; recall returns `topScore`/`abstained`/`rankFn` and appends a calibration log line per call. Dials get set from observed interactive distributions — the measured-dial discipline applied to ourselves. (Benchmark's 0.872 is bge-base + question-style queries; interactive queries may distribute differently.)
3. **Cardinality — `.mneme/config.json` per project.** Optional file beside the db: `{ "keyCardinality": { "decision": "multi", ... } }`; validated at load (invalid values = loud startup error — never silently all-single); absent file = all-single (today's behavior). Versionable per repo; editable as dogfooding teaches which keys accumulate.
4. **The pipeline becomes front-and-center — a retrieval LAYER (user elevation).** The canonical read composition is a primary piece of the methodology, so it gets a first-class home: **`src/retrieval/`**, a layer ABOVE algebra for named compositions of operators (SoC: algebra = operators, retrieval = recipes, surface = session facade). `read-pipeline.ts` exports the canonical core; **bench arm A migrates to consume it** in this slice — the deterministic benchmark re-run is the proof that the extraction is behavior-identical, and the benchmark becomes the recipe's standing verification instrument.

## Design

### 1. Retrieval layer (src/retrieval/read-pipeline.ts — NEW LAYER)

```ts
import type { Stage } from "../algebra/expression.js";
import type { Corpus, RankedCorpus } from "../algebra/types.js";

export interface ReadPipelineOpts {
  /** Evaluation instant for τ_valid (and the caller's evaluationClock). */
  evaluationInstant: number;
  /** Per-key cardinality forwarded to ⊥ (DetectionOptions). Absent = all-single. */
  keyCardinality?: Record<string, "single" | "multi">;
  /** ⊥ eligibility floor; default 0 (all contest). */
  conflictThreshold?: number;
  /** Dedupe config; defaults { fn: "jaccard", cutoff: 0.5, rule: "rule_weighted_avg" }
   *  (the safe idempotent rule — the bio-layer precedent). */
  dedupe?: { fn: string; cutoff: number; rule?: string };
}

/**
 * The canonical read-side core (canonical spec §4.8 composition note, reified):
 *   τ_valid(t) → ⊕_dedupe(rule, similarity) → ⊥(keyCardinality, floor)
 *   → resolveDeprecateOlder → drop deprecated + contradiction-flag artifacts
 * Returns Corpus→Corpus stages; callers prepend leaf/σ and append ranking + knobs:
 *   rho.by(fn, query) → abstainBelowTop(τ_a) → relevanceFloor(τ_p) → (top-k | κ)
 */
export function canonicalReadStages(opts: ReadPipelineOpts): Stage<Corpus, Corpus>[];
```

- Pure composition of existing exports (oplusDedupe, pairsOf, resolveDeprecateOlder, filterCorpus, tauValid) — no new operator semantics. Composition-first: this layer ADDS no math, only names a recipe.
- Layering rule (enforced by review): `src/retrieval/` imports from algebra/catalog only; surface, mcp, and bench import from retrieval. Algebra never imports retrieval.
- Barrel-exported (`canonicalReadStages`, `ReadPipelineOpts`).

### 2. Bench arm A migrates to the recipe (bench/longmemeval/answer.ts)

`answerArmA`'s hand-rolled middle (τ_valid → dedupe → ⊥/resolve → drop) is replaced by `canonicalReadStages({ evaluationInstant: t, keyCardinality: opts.keyCardinality, dedupe: { fn: "jaccard", cutoff: opts.dedupeCutoff ?? 0.5 } })`. Ranking tail (rho.by → abstainBelowTop → relevanceFloor) unchanged. **Acceptance: the manual benchmark reproduces PR #21's exact numbers** (KU recall@3 0.95, abstention 1.0, updateCorrect 1.0, 60/60) — the behavior-identity proof for the extraction.

### 3. MCP embeddings wiring (src/mcp/embeddings.ts — NEW; src/adapters/embedding/transformers-local.ts — MOVED)

```ts
// src/mcp/embeddings.ts
/** Lazy singleton: on first call, dynamic-import the local adapter, register
 *  "cosine" (cosineOver(adapter, cache)) + "hybrid" (hybridMax(simJaccard, cosine)),
 *  registerEmbeddingAdapter. Returns { rankFn: "hybrid", adapter, cache } on success;
 *  on ANY failure logs ONE stderr warning and returns { rankFn: "jaccard" } — cached
 *  either way (no retry storm). Injectable adapter factory for tests (fake adapter). */
export function initEmbeddings(factory?: () => Promise<EmbeddingAdapter>): Promise<EmbeddingState>;
```

- Warm-up per recall: `await warmEmbeddings(adapter, cache, [...corpus claim values (canonicalized, same rule as cosineOver), query])` before the synchronous query — the cache makes repeat recalls incremental (only new claims embed).
- The bench's `warmForQuestion` keeps its home in bench; MCP has its own corpus-shaped warm helper here.

### 4. Recall runs the full pipeline (src/mcp/tools.ts)

```
leaf → σ(subject/key filters) → ...canonicalReadStages({ evaluationInstant: now, keyCardinality, dedupe })
     → rho.by(state.rankFn, about) → abstainBelowTop(args.abstainBelowTop ?? 0)
     → relevanceFloor(args.relevanceFloor ?? 0) → matches(limit) / κ.markdown(maxTokens)
```

- New optional args: `abstainBelowTop`, `relevanceFloor` (0..1, validated by the stages' own throws → tool error).
- `RecallResult` gains `topScore?: number` (post-pipeline, pre-knob top — the calibration signal), `abstained: boolean`, `rankFn: string`. Existing fields unchanged (additive).
- Read-only contract preserved: unknown corpus still returns empty without creating.

### 5. Observability (src/mcp/recall-log.ts — NEW, tiny)

Append one JSONL line per recall to `.mneme/recall-log.jsonl` (beside the db): `{ ts, corpus, about, topScore, matchCount, abstained, rankFn }`. Best-effort: failures go to stderr, never block or fail the tool. This is the knob-calibration dataset accumulating for free (decision 2).

### 6. Config (src/mcp/config.ts — NEW, tiny)

Load `.mneme/config.json` (path derived from dbPath's directory) at server startup: `{ keyCardinality?: Record<string, "single" | "multi"> }`. Validation: unknown top-level keys warn; invalid cardinality values → loud startup error (uses the same "single"|"multi" discipline as `cardinalityOf`). Absent file = `{}`.

### 7. Remember-side ingest discipline (src/mcp/tools.ts, server.ts)

- `remember` gains optional `scope?: Record<string, string>` (the different-referent protection the detection slice flagged for THIS ingest path) and optional `validFrom?: string` (ISO; backdating so supersession ordering is honest; default now).
- `ensureCorpus` declares default `scopeFields: { project: "string", person: "string", context: "string" }` for NEW corpora. Pre-existing corpora are untouched (strict-scope rejects scope writes there — acceptable; dogfooding starts a fresh corpus or goes scopeless on legacy).

### 8. Dogfood protocol (pre-registered — the experiment design)

- **Window:** 2 weeks of normal Claude Code use; per-repo corpora; explicit-write habit via a memory-instruction (controller writes it at close-out: store durable decisions/preferences/facts via `remember`; consult `recall` when prior context matters).
- **Falsification questions (pre-registered):** (1) did supersession resolution ever serve the right fact where plain recall wouldn't? (2) did key drift silently break detection (probe-4 in the wild → evidence for the key-matching slice)? (3) once dialed from the log data, did abstention ever correctly refuse / ever falsely refuse? (4) friction: is explicit-write usable; is warm-up latency tolerable?
- **Evidence:** the recall log + write-event log + provenance collect it passively; review at window end.

## Error handling

- Embedding init failure (missing package, download failure, bad model) → ONE stderr warning, jaccard fallback, cached state (no retry storm). `rankFn` in results makes degradation visible.
- Config: invalid cardinality value or malformed JSON → startup error naming the file and value (never silently all-single). Absent file = fine.
- Knob args outside [0,1] → the stages' existing throws surface as tool errors.
- Recall-log append failure → stderr only.
- Warm-up validation failures (dim/finiteness — adapter misbehaving) → recall returns a tool error naming the adapter (fail loud; cache uncorrupted by warmEmbeddings' validate-before-store contract).

## Measurement / acceptance

- **Behavior-identity (merge-blocking):** manual benchmark via the migrated arm A reproduces PR #21 exactly — KU recall@3 0.95, recall@10 1.0, updateCorrect 1.0, abstention 1.0, zero false abstentions, 60/60; probes 7/7; fixture 9/9 offline.
- **MCP integration (fake adapter, CI):** recall through the full pipeline returns deduped/resolved/ranked matches with topScore/abstained/rankFn; supersession scenario (two values, same subject/key, different validFrom) returns ONLY the newer; multi-declared key (via config) returns both values; fallback path serves jaccard with rankFn:"jaccard".
- **Real-server smoke (manual, once):** remember + recall round-trip against the local server with the real model; report the topScore observed.
- Full suite green; typecheck clean; CI zero-network preserved (fake adapter in tests; integration tests stay jaccard).

## Testing (TDD)

- retrieval: canonicalReadStages — supersession resolved, multi-key kept, dedupe merges restatements, flag artifacts dropped, opts defaults; equivalence test vs the previous hand-rolled arm-A middle on a seeded corpus.
- mcp/embeddings: init success path (fake factory) registers hybrid; failure path falls back + warns once + caches; warm helper canonicalization parity.
- mcp/config: valid / absent / malformed / bad-value cases.
- mcp/tools: recall pipeline behaviors above; knob args; topScore/abstained fields; remember scope + validFrom; read-only contract.
- bench: arm A equivalence (benchmark numbers — run at close-out, merge-blocking).

## Explicitly out of scope (deliberately deferred)

- Knob auto-calibration from the recall log (manual dial after the observation window).
- Bio runner attachment to the dogfood corpus (bio efficacy slice).
- Schema migration of pre-existing corpora; per-corpus config maps (one map per project suffices for v1).
- Key-drift tolerant matching (probe 4 — own slice; dogfooding gathers its real-world evidence).
- MCP exposure of dedupe cutoff / conflictThreshold as tool args (server-side recipe defaults suffice; add when a consumer needs them).
- Retrieval-layer recipes beyond the canonical read pipeline (the layer exists; recipes accrete as needed).
