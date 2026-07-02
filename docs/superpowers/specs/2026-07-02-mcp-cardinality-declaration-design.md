# MCP Cardinality Declaration + Write-Discipline Guidance — Design

**Date:** 2026-07-02
**Status:** Approved (brainstorming) → ready for implementation plan
**Motivation:** Close the MCP *utilization* gap for the shipped Clusters A/B/C. Two concrete
gaps surfaced by auditing `src/mcp/server.ts`: (1) the Cluster C safety warning tells the
agent to *"declare keyCardinality:\"multi\""* but **no MCP tool can do that** — corpora are
auto-created (via `remember`→`ensureCorpus`) with no schema, and the only cardinality source
is the server's global `config.keyCardinality`, which is operator-only and server-wide;
(2) the `MNEME_WRITE_SCHEMA` session instructions predate Cluster B and never route the agent
to `reconcile`/`subject_census` (the recall-before-write primitives), and recall warnings are
absent from the human-readable `content` block.

## Goal

Make the shipped A/B/C features actually usable by an MCP agent: a first-class path to
declare per-key cardinality (so the safety warning is actionable), and write-discipline
guidance that routes the agent through the canonicalization + transparency tools.

## Core decisions (from brainstorming)

- **Narrow `declare_cardinality` tool**, not a broad `create_corpus` and not a `keyCardinality`
  param on `remember`. It directly closes the gap with minimal surface; auto-create for writes
  is untouched.
- **Create-or-patch, merge semantics.** `declare_cardinality` works whether the corpus already
  exists (auto-created) or not. Declaring one key merges into any existing `schema.keyCardinality`
  (never wipes other declared keys or other schema fields). Idempotent.
- **Claims are never touched.** Re-`createCorpus` replaces only the corpus *def* (the catalog
  Map + sidecar); claims live in the adapter store keyed by corpus id. Verified: `Catalog.createCorpus`
  does `corpora.set(id, def)` (overwrite, no throw); claims are stored separately.

## Non-goals

- **No general `updateCorpus` / `create_corpus` tool** (YAGNI — narrow declare only).
- **No `keyCardinality` on `remember`** (would overload the per-claim write with a per-corpus
  schema mutation).
- **No algebra/read-path change.** `resolveKeyCardinality` (Cluster C) already merges the
  per-corpus schema declaration over the deps/global map — `declare_cardinality` just makes the
  schema side settable via MCP. Global `config.keyCardinality` continues to work unchanged.
- **Warning text stays generic** — the surface-layer `cardinalitySafetyWarnings` names no MCP
  tool (layering: surface must not reference transport). The MCP tool *description* +
  `MNEME_WRITE_SCHEMA` reference `declare_cardinality`.
- **CLI `declare-cardinality` flag deferred** (add if a CLI consumer needs it).
- **No schema-version bump** on declaration — cardinality is read-time metadata; existing claims
  (`corpusId@version`) stay valid, so the version is unchanged.

## Context — verified current state

- `Catalog.createCorpus(def)` (`src/catalog/catalog.ts:10`) overwrites (`corpora.set`); no
  `updateCorpus` exists. `getCorpus`/`listCorpora` expose the def (with `schema`).
- `session.createCorpus(spec)` (`src/surface/session.ts:77`) validates `keyCardinality`
  fail-fast (Cluster C, the loop to extract) and persists via `saveCorpora`. It tracks
  `versionOf`.
- The read path resolves effective cardinality per-corpus via `resolveKeyCardinality`
  (`src/surface/cardinality.ts`) — schema declaration wins over the deps/global map.
- MCP wiring (`src/mcp/server.ts`): `MNEME_WRITE_SCHEMA` instructions (line 15) mention
  `recall`/`key_census` only; `remember` description (line 51) mentions neither reconcile nor
  cardinality; `recall` warnings go to `structuredContent.warnings` (line 242) + stderr but NOT
  the `content` text (line 231). `explain`, `reconcile`, `subject_census` tools exist.

## Part 1 — `declare_cardinality`

### Surface: `session.declareCardinality`

Add to the `Session` interface + implementation (`src/surface/session.ts`):

```ts
/** Declare per-key cardinality for a corpus (create-or-patch, merge). Validates values;
 *  creates the corpus if absent, else merges into schema.keyCardinality and re-persists the
 *  def (claims untouched). Returns the effective keyCardinality map after the merge. */
declareCardinality(corpusId: string, cardinality: Record<string, "single" | "multi">): Record<string, "single" | "multi">;
```

Implementation:
1. `validateKeyCardinality(cardinality)` (shared validator — see DRY below); throws on any value
   ∉ `{single,multi}`.
2. If the corpus does not exist (`!mneme.listCorpora((c) => c.id === corpusId).length`):
   delegate to `this.createCorpus({ id: corpusId, keyCardinality: cardinality })` (reuses the
   full def-building path). Return `cardinality`.
3. Else: read the existing def (`mneme.listCorpora((c) => c.id === corpusId)[0]`), build a patched
   def = `{ ...def, schema: { ...def.schema, keyCardinality: { ...(def.schema.keyCardinality ?? {}), ...cardinality } } }`,
   `mneme.createCorpus(patched)` (overwrites the def; claims untouched), `saveCorpora(dbPath, mneme.listCorpora())`.
   Return the merged map.

### MCP tool: `declare_cardinality`

`src/mcp/server.ts`:
- input: `{ corpus?: string (default defaultCorpus), cardinality: Record<string, enum["single","multi"]> }`.
- annotations: `readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false`.
- output: `{ corpus: string, keyCardinality: Record<string,"single"|"multi"> }` (the effective map).
- handler: `const eff = session.declareCardinality(resolvedCorpus, a.cardinality);` → return it.
- description: names the workflow — *"Declare which keys hold multiple coexisting values (multi)
  vs a single latest value (single). Use after a recall/key_census cardinality warning to stop a
  single-cardinality key from silently deprecating distinct facts."*

## Part 2 — write-discipline guidance + transparency loudness

All in `src/mcp/server.ts` (text/wiring only):

1. **`MNEME_WRITE_SCHEMA`** — add, in the write discipline:
   - *"RECONCILE ENTITIES BEFORE MINTING. Before writing a new subject or key, run `reconcile`
     (and `subject_census` to audit) to reuse an existing canonical entity — entity fragmentation
     is the #1 ingestion failure mode."*
   - *"If `recall`/`key_census` warns that a single-cardinality key holds ≥2 distinct values that
     should coexist, declare it multi with `declare_cardinality`."*
   - *"Pass `explain: true` to `recall` to audit why each claim was served / merged / deprecated
     / dropped."*
2. **`remember` tool description** — add: *"Reconcile the subject/key first (`reconcile`) to avoid
   fragmenting claims across near-duplicate entities."*
3. **`recall` `content` footer** — when `r.warnings?.length`, append a `\n\n## ⚠ Warnings\n- …`
   section to the human-readable `text` block (agents that read `content` currently miss the
   cardinality warning, which is only in `structuredContent.warnings`).

## Module structure (SRP / SoC / DRY)

- **`src/catalog/schema.ts`** — add `validateKeyCardinality(map)` (throws on invalid values),
  next to `cardinalityOf`/`validateScope`/`pseudocountFor` (the schema-validation home). Both
  `createCorpus` and `declareCardinality` call it, removing the inline loop duplication.
- **`src/surface/types.ts`** — add `declareCardinality` to the `Session` interface.
- **`src/surface/session.ts`** — implement `declareCardinality`; rewire `createCorpus`'s inline
  validation to `validateKeyCardinality`.
- **`src/mcp/server.ts`** — register `declare_cardinality`; update `MNEME_WRITE_SCHEMA`,
  `remember` description, `recall` content footer.

## Error handling

`declareCardinality` validation is a fail-fast throw (like `createCorpus`). The MCP tool lets it
propagate as a tool error (declaring bad cardinality should fail loudly — it is an explicit
action, not best-effort observability). Reading a corpus that doesn't exist is not an error
(create-or-patch creates it).

## Testing

- **`src/catalog/schema.test.ts`** — `validateKeyCardinality`: passes valid maps, throws on a
  non-`single`/`multi` value; `createCorpus` still rejects invalid (unchanged behavior via the
  extracted validator).
- **`src/surface/session.test.ts`** — `declareCardinality`: (a) on an **existing** auto-created
  corpus, merges into `schema.keyCardinality` preserving other declared keys AND other schema
  fields (`scalarPseudocount`, `subjects`); (b) **claims written before declaring survive** the
  re-create (write 2 claims → declare → claims still readable); (c) on an **absent** corpus,
  creates it with the declaration; (d) invalid value throws; (e) round-trips across reopen;
  (f) idempotent (declaring the same map twice = same schema).
- **`src/mcp/server.integration.test.ts`** — end-to-end: write two distinct values under a key →
  `recall` warns (single default) → `declare_cardinality` `{key:"multi"}` → `recall` now serves
  both AND the warning is gone; the `declare_cardinality` output echoes the effective map; the
  `recall` `content` text contains a `⚠ Warnings` section when warnings exist. `backcompat.test.ts`
  stays green (existing tools unchanged; instruction text is additive).
- Full suite + `tsc --noEmit` green; `layering.test.ts` green.

## Scope / future (deferred)

- CLI `mneme corpus declare-cardinality k=multi,...`.
- A general `updateCorpus`/`create_corpus` surface if a consumer needs more than cardinality.
- Wiring `reconcile`/`declare_cardinality` into the openclaw plugin + the CrewTracks reporting
  MCP (separate consumers).
