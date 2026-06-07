# C7 fix — surface-layer scalarPseudocount declaration

**Date:** 2026-06-07
**Status:** Approved (founder-ratified design + amendments A1–A3)
**Scope:** Surface layer only (`src/surface/`). Substrate untouched. Bio's on-ramp slice.

## Problem

`session.createCorpus` (src/surface/session.ts:74) hardcodes `scalarPseudocount: {}`
into every corpus schema it builds. The substrate's `pseudocountFor`
(src/catalog/schema.ts:37) throws on any source missing from that map — correctly, per
canonical §3.2 ("no silent default", a MUST). Today nothing trips: `betaFromRaw`
(src/write/source-weight.ts:7), the scalar→Beta promotion path, has **zero production
callers** (verified — only its own test). The moment the bio layer attaches to a
surface-created corpus and promotes scalar confidence to Beta (the evidence-pooling /
promotion slice, three measured justifications already on the board), every such corpus
throws. All dogfood corpora are surface-created via `ensureCorpus`
(src/mcp/tools.ts:100), so the landmine sits exactly where bio lands first.

Recorded as audit note **C7** in
`docs/superpowers/specs/2026-06-06-mcp-dogfood-upgrade-design.md` ("fix belongs to the
surface layer when bio attaches"). Bio is attaching; this is the fix.

## Ratified decisions

1. **Full A.1 map + per-corpus override** (over flat-2 and required-no-default): the
   surface declares a complete six-source default keyed to the Appendix A.1 trust
   tiers; `CorpusSpec` exposes an override. Per-source trust ordering is preserved —
   it is part of why Beta promotion is justified at all.
2. **Backfill on load + persist** (over in-memory-only and explicit-migration):
   `openSession` repairs persisted corpora carrying the C7 bug signature and persists
   the upgrade, so the live dogfood corpus is covered on next session open and the
   sidecar stops lying about what the corpus uses.
3. **Amendments A1–A3** and one made-explicit invariant, folded in below.

## Design

### Change 1 — declared default (src/surface/types.ts)

```ts
/**
 * Per-source pseudocounts for scalar→Beta coercion, from canonical Appendix A.1
 * trust tiers. These are spec-authored priors, UNCALIBRATED — the bio efficacy
 * instrument sweeps this dial (flat-2 vs tiered is one config via the
 * CorpusSpec.scalarPseudocount override). Declaring them here keeps §3.2's
 * no-silent-default MUST intact at the substrate: the surface is a caller, and
 * this is its explicit declaration.
 */
export const DEFAULT_SCALAR_PSEUDOCOUNT: Record<Source, number> = {
  manual: 10,
  verification: 10,
  workflow: 5,
  heuristic: 5,
  llm: 2,
  imported: 2,
};
```

`CorpusSpec` gains:

```ts
/** Per-source scalar→Beta pseudocounts; merged over DEFAULT_SCALAR_PSEUDOCOUNT. */
scalarPseudocount?: Partial<Record<Source, number>>;
```

(`Partial<Record<Source, number>>` matches `ClaimSchema.scalarPseudocount` exactly —
src/catalog/schema.ts:14; no type bridge needed.)

**Exports:** `DEFAULT_SCALAR_PSEUDOCOUNT` is declared in `src/surface/types.ts` and
re-exported via `src/surface/index.ts` **and the root barrel `src/index.ts`** — the
examples import exclusively from `../src/index.js` (modeling the published package
surface), so the root export is load-bearing for the examples amendment below.

### Change 2 — createCorpus merge (src/surface/session.ts)

In `session.createCorpus`, replace the hardcoded empty map with a merge that **strips
explicit-`undefined` override entries**:

```ts
const pcOverrides = Object.fromEntries(
  Object.entries(spec.scalarPseudocount ?? {}).filter(([, v]) => v !== undefined)
);
// ...
scalarPseudocount: { ...DEFAULT_SCALAR_PSEUDOCOUNT, ...pcOverrides },
```

Merge, not replace: a partial override can never re-arm the throw for an undeclared
source. The strip is load-bearing, not pedantry (audit finding 2.5): under `Partial`,
`{ scalarPseudocount: { llm: undefined } }` type-checks (no
`exactOptionalPropertyTypes`), a naive spread copies the `undefined` over the default
(`pseudocountFor` checks `=== undefined` → throw re-armed), and `JSON.stringify` then
**drops** the entry — persisting a five-key map that is non-empty, so the Change-3
backfill predicate can never repair it. Pinned by test 3b.

`ensureCorpus` (src/mcp/tools.ts) needs **no change** — it inherits the default.

**Invariant (pinned by test):** every post-fix `createCorpus` persists a **complete**
six-source map. `{}` (or a partial map missing legal sources) can never be written by
the surface again — which is precisely what keeps the backfill predicate (Change 3)
forever-unambiguous. A future refactor that "optimizes" to persisting only the override
partial would silently re-open the ambiguity; the test exists to fail that refactor.

### Change 3 — load-time backfill (src/surface/session.ts, openSession)

During corpus re-registration, a loaded def is **C7-damaged** when:

```ts
def.schema.scalarPseudocount == null ||
  Object.keys(def.schema.scalarPseudocount).length === 0
```

(A2: absent-OR-empty — an older sidecar revision lacking the field entirely must not
stay armed.)

For each damaged def: set `schema.scalarPseudocount = { ...DEFAULT_SCALAR_PSEUDOCOUNT }`
before `mneme.createCorpus(d)`, and emit **one stderr line per repaired corpus** (A1):

```
console.error(
  `${dbPath}.corpora.json: backfilled scalarPseudocount for '${d.id}' (C7 repair, A.1 defaults)`
);
```

The sidecar isn't git-tracked; this line is the only audit visibility the repair gets.
(Considered and declined: a warnings-on-open return surfaced by the MCP layer via the
tools-pure/server-prints pattern — proportionate ceremony for a recurring condition,
not for a one-time bug repair. If a second load-time repair class ever appears,
revisit.) Noted deliberately: this is the **first** `console.error` in `src/surface/`
— precedent exists in `src/cli/` and `src/mcp/` (server.ts:175,253,282; recall-log.ts:24;
embeddings.ts:81), none in the surface layer until now.

After the re-registration loop, if **any** def was repaired, call
`saveCorpora(dbPath, mneme.listCorpora())` **once**. No repair → no write (load stays
read-only on healthy stores). Non-empty maps are respected verbatim — never merged,
never rewritten.

Schema `version` is unchanged: the backfill is a bug repair, not a semantic migration,
and no production code path reads the map today (behavior-inert by construction).

## Window safety

The dogfood window (active until ~2026-06-20) is unaffected: the map is dead config
until bio attaches — no read path (recall/census/⊥/remember) consults
`scalarPseudocount`. The only observable changes on the live store are one persisted
sidecar upgrade and one stderr line on the first post-fix session open.

## Error handling

- `saveCorpora` already writes atomically (tmp + rename) and throws on failure; a
  failed repair-persist surfaces as an `openSession` error — acceptable, since a
  half-open session over an unwritable store is worse.
- No new throw paths. `pseudocountFor`'s throw is untouched and still guards the
  substrate (§3.2 posture preserved).

## Testing

1. **All-six-sources**: surface-created corpus → `betaFromRaw(raw, s, schema)`
   succeeds for every legal `Source`.
2. **Override merge**: `createCorpus({ scalarPseudocount: { llm: 4 } })` → llm 4,
   other five at A.1 defaults.
3. **Complete-map invariant**: post-fix corpus → persisted sidecar map has all six
   sources (pins the Change-2 invariant against partial-persist refactors).
3b. **Explicit-`undefined` override stripped**: `createCorpus({ scalarPseudocount:
   { llm: undefined } })` → llm at default 2; persisted map has six **numeric**
   values (pins the strip against a naive-spread refactor; audit finding 2.5).
4. **Backfill, empty**: sidecar with `scalarPseudocount: {}` → re-open → map
   backfilled, sidecar persisted with full map.
5. **Backfill, absent** (A2): sidecar def lacking the field → same repair.
6. **Stderr fires on backfill and only on backfill**: repaired corpus → one line;
   healthy corpus → no line, no sidecar rewrite.
7. **Non-empty respected**: persisted `{ workflow: 4, manual: 8 }` → loaded verbatim,
   no merge, no rewrite, no stderr.
8. Full suite + tsc green (baseline 1,661 — audit-verified by full run).

## Out of scope

| Item | Disposition |
|---|---|
| Bio's flat `evidence.scalarPseudocount: 2` (BioPolicy) | Stays. Switching bio to the per-source path is the **promotion slice**, gated on the bio efficacy instrument's numbers. |
| Substrate changes (`pseudocountFor`, `betaFromRaw`, ClaimSchema) | None. §3.2 throw is correct and load-bearing. |
| Dogfood-corpus behavior | Unchanged (dead config until bio attaches; see Window safety). |
| Pseudocount calibration | The A.1 values are uncalibrated spec priors; the efficacy instrument sweeps the dial. |
| `examples/quickstart.ts:45`, `examples/bio-quickstart.ts:36` | Both build CorpusDefs directly (substrate facade, not CorpusSpec) with `scalarPseudocount: {}` — the canonical examples model the C7 bug. Update both to spread `DEFAULT_SCALAR_PSEUDOCOUNT`. No behavior change (examples never promote). |

**Carried-forward obligation (promotion slice):** when promotion consumes this map at
read/derive time, **verify the map is stamped into derivation provenance for replay
determinism** — the keyAliases field-by-field-rebuild lesson (PR #23 plan audit) says
verify, never assume.
