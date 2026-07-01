# Operations-Layer Migration — Design

**Date:** 2026-07-01
**Status:** Approved (brainstorming) → ready for implementation plan
**Foundation for:** the recall-explain-trace spec (Cluster A) and the ingestion clusters (B/C);
surfaced by the explain-spec audit. Related: stoa `rastate/synthesis-fireflies-dogfood-synthesis-ingestion`.

## Goal

Fix an operation/transport **Separation-of-Concerns violation**: the read/write/catalog
operations `recall` / `remember` / `keyCensus` / `listCorpora` / `ensureCorpus` — and their
types — live in `src/mcp/tools.ts`, the **transport** module, even though none of them touch
MCP. Relocate them **down** to `src/surface` (the existing ergonomic operations facade),
make `src/mcp` a thin transport that imports them, and keep `mneme/mcp` **re-exporting** them
so nothing breaks.

This restores clean layering (`core < algebra < {retrieval, write} < surface < mcp`) and
unblocks `explain` landing in its proper layer instead of forcing a backward
`retrieval → mcp` dependency.

## Non-goals

- **No API redesign.** Signatures stay byte-identical (`recall(session, args, deps)` etc.).
  No Session methods, no deps-on-session — that is a separate, later enhancement (YAGNI).
- **No behavior change.** This is a pure relocation; every existing test must pass unchanged.
- **No `server.ts` / `config.ts` logic changes** beyond import paths.
- Not the `explain` feature — this only makes room for it.

## Context

`recall()` is pure orchestration over `session` + retrieval stages (`canonicalReadStages`,
`key-alias`, `coverage`) + algebra ranking; `remember()` is pure `session.write`. They are
**domain operations**, not transport. The smell is already visible: the OpenClaw plugin and
`openMnemeEngine` import these operations from `mneme/mcp`. `src/surface` currently imports
`core`/`algebra`/`write` but **not** `retrieval`, so adding a `surface → retrieval` edge is a
forward dependency, not a cycle.

## Inventory (from `src/mcp/tools.ts`)

**Functions:** `recall`, `keyCensus`, `parseAsOf`, `remember`, `ensureCorpus`, `listCorpora`.
**Types:** `RecallDeps`, `RecallArgs`, `RecallMatch`, `RecallResult`, `CensusArgs`,
`CensusResult`, `RememberArgs`, `RememberResult`, `ListResult`.
**Plus `EmbeddingState`** — currently defined in `src/mcp/embeddings.ts`; it is part of
`RecallDeps`' shape, so it must move out of `mcp` too (else `surface → mcp`).

## Target layout

- **`src/surface/recall.ts`** (reads): `recall`, `keyCensus`, `parseAsOf`, `EmbeddingState`,
  `RecallDeps`, `RecallArgs`, `RecallMatch`, `RecallResult`, `CensusArgs`, `CensusResult`.
- **`src/surface/remember.ts`** (writes/catalog): `remember`, `ensureCorpus`, `listCorpora`,
  `RememberArgs`, `RememberResult`, `ListResult`.
- **`src/surface/index.ts`** re-exports both (so `mneme/surface` and the root `mneme` barrel
  expose the operations — the canonical new home).
- **`src/surface/test-support.ts`** — move `freshSession` / `jaccardDeps` / `makeFakeHybridDeps`
  here from `src/mcp/test-support.ts` (surface-level test helpers, importable by both surface
  and mcp tests).

## What `mcp` becomes

- **Delete `src/mcp/tools.ts`** (contents moved). No re-export shim — the barrel covers it.
- **`src/mcp/index.ts`** (the `mneme/mcp` barrel): re-export the operations **from
  `../surface/*`** instead of `./tools.js`. Keeps `mneme/mcp` importers working unchanged.
- **`src/mcp/server.ts`**: import the operations from `../surface/*` (transport unchanged —
  `registerTool`, response formatting, `appendRecallLog` all stay).
- **`src/mcp/embeddings.ts`**: import `EmbeddingState` from surface instead of defining it
  (the `initEmbeddings` loader stays — it is genuine runtime wiring).
- **`src/mcp/engine.ts`** (`openMnemeEngine`): `EmbeddingState` type source shifts to surface;
  otherwise untouched.

## Consumers to update (exhaustive — from grep)

`src/mcp/index.ts`, `src/mcp/server.ts`, `src/mcp/embeddings.ts`, `src/mcp/embeddings.test.ts`,
`src/mcp/test-support.ts` (moves), `src/mcp/engine.test.ts`, and the moved test file. External
`mneme/mcp` importers — `integrations/openclaw/memory-mneme/{index,index.test}.ts` — are
**not** edited; they keep working through the barrel re-export (this is the back-compat proof).

## Tests

- `src/mcp/tools.test.ts` → split/move to `src/surface/recall.test.ts` + `remember.test.ts`;
  passes **unchanged** (behavior identical).
- `src/mcp/server.test.ts` / `server.integration.test.ts` / `engine.test.ts`: re-import ops
  from surface; pass unchanged.
- **Back-compat test** (new, in the mcp suite): `import { recall, remember, keyCensus } from`
  the `mneme/mcp` barrel resolves and a `remember → recall` round-trip works — proving the
  re-export contract holds for external consumers.
- **Layering invariant** (greppable, asserted in CI/spec-review): no file under
  `src/surface/` or `src/retrieval/` imports from `src/mcp/`.

## Success criteria

1. Full suite green — behavior-preserving (the load-bearing guarantee).
2. `recall` / `remember` / `keyCensus` importable from `mneme`, `mneme/surface`, **and**
   `mneme/mcp` (back-compat).
3. Nothing in `src/surface` or `src/retrieval` imports `src/mcp` (layering restored).
4. `tsc --noEmit` clean.
5. `src/mcp/tools.ts` no longer exists.

## Notes for the follow-on explain spec

Once this lands, revise `2026-07-01-recall-explain-trace-design.md`: `explainRecall` and the
`RecallTrace`/`DispositionReason` types land in `src/surface` (or `src/retrieval` for the
stage-tracing core), next to the migrated `recall` — no backward dependency, honoring
"retrieval/surface own their own operations."
