# Belief-change History — Design (child #2)

**Date:** 2026-07-02
**Status:** Approved (brainstorming) → ready for implementation plan
**Charter:** `docs/superpowers/specs/2026-07-02-belief-change-visibility-charter.md` — this is child
**belief-change-history** (gap #1). Child **belief-change-maintainable** (#2+#4) already shipped
(PR #42, main `48647cd`).

## Intent

Surface Mneme's non-destructive, replayable ledger at the MCP surface — the core differentiator
that is currently invisible. `recall` serves only the live/latest; nothing lets an agent or human
see *"every version of `(client:acme, database.choice)` over time, including the deprecated ones
and why."* This child adds that view. Per the charter scope decision, it ships **`history` +
`inspect`** and defers `replay`/`derive` (which only act on *derived* claims — none exist via the
current MCP surface; demand-pull).

## Core facts (verified)

- **The store is append-only.** Deprecation is computed at READ time (`resolveDeprecateOlder` in
  `canonicalReadStages`) and is never persisted — a superseded claim stays in the store unchanged
  (charter I1 holds by construction). So the "ledger" for a `(subject,key)` is simply all its
  committed claims; `history` reads them all and attributes each version's disposition.
- `session.inspect(corpus, claimId) → Claim | undefined` (via `mneme.readByIds`) already exists —
  `inspect` is a thin MCP wrapper over it.
- Child #1 shipped `belief-change.ts` with the `DispositionReason` vocabulary (charter home) and
  `supersessionOutcome`, which attributes ONE claim via `dedupeGroups` + `pairsOf` (embeddings-free).

## Non-goals

- **No `replay`/`derive` MCP tools** — deferred (paired future slice; no derived claims exist to
  replay via MCP today).
- **No algebra change; no new vocabulary.** Reuses `DispositionReason` + the child-#1 attribution
  (charter I4). Embeddings-free (no ranking).
- **Not a mutation surface** — `history`/`inspect` are read-only (charter I1: they only reveal the
  ledger, never change it).
- **Post-hoc subject merging** stays deferred (charter out-of-scope guard).

## Module structure (SRP / SoC / DRY)

- **`src/surface/belief-change.ts`** — extract the shared per-claim attribution into
  `groupDispositions(claims, keyCardinality, aliasMap, now) → Map<claimId, { disposition: GroupDisposition; reason: DispositionReason }>`
  where `export type GroupDisposition = "served" | "deprecated" | "merged" | "tau-invalid"` is
  DEFINED here (its home, next to the vocabulary), returning EVERY claim's disposition via the
  τ_valid → ⊕_dedupe → ⊥ precedence. Rewire `supersessionOutcome` to use it (it currently inlines
  the same dedupe+pairs logic for one claim; it maps the written claim's disposition + what it
  deprecated → its write-`action`) — DRY: one attribution implementation, used by both
  `supersessionOutcome` and `lineageOf`. Behavior-preserving refactor of shipped code (existing
  belief-change tests stay green).
- **`src/surface/history.ts`** (new) — `lineageOf` + `LineageEntry`/`LineageResult`. SRP: the
  ordered non-destructive lineage of one `(subject,key)`.
- **`src/surface/index.ts` + `src/index.ts`** — export `lineageOf` + its types.
- **`src/mcp/server.ts`** — register read-only `history` + `inspect` tools.

## Component 1 — `lineageOf` (surface) + `history` (MCP)

```ts
// src/surface/history.ts
import type { Session } from "./types.js";
import type { DispositionReason, GroupDisposition } from "./belief-change.js";

export interface LineageEntry {
  id: string;
  value: unknown;
  confidence: number;                 // point estimate
  valid: { from: number; to: number };
  recordedSeq: number;                // ledger order
  tags: string[];
  disposition: GroupDisposition;      // "served" | "deprecated" | "merged" | "tau-invalid" (from belief-change.ts)
  reason: DispositionReason;          // charter vocabulary (deprecated-by / merged-into / served / tau-invalid)
}
export interface LineageResult {
  corpus: string;
  subject: string;
  key: string;
  asOf: number;                       // evaluation instant (default now)
  entries: LineageEntry[];            // ALL versions incl. deprecated/merged, ordered by valid.from then recordedSeq
  content: string;                    // human-readable timeline
}

/** Full non-destructive lineage of one (subject,key): every committed claim + its disposition at
 *  `asOf`, computed via the shared groupDispositions (embeddings-free). Honors per-corpus
 *  cardinality + key aliases. */
export function lineageOf(session: Session, args: { corpus: string; subject: string; key: string; asOf?: string | number }): LineageResult;
```

Mechanism: resolve effective cardinality (`resolveKeyCardinality`) + alias map (`loadAliasContext`);
read all claims for `(subject, key-family)`; call `groupDispositions(...)` to get each claim's
disposition at `asOf`; map to `LineageEntry[]` sorted by `valid.from` then `recordedSeq`; compose a
`content` timeline. **Includes deprecated/merged/tau-invalid versions** — that is the point (the
ledger is non-destructive). Best-effort attribution: an attribution failure degrades an entry to
`served`/no-reason with a note rather than throwing.

MCP `history` tool: input `{ corpus?, subject, key, asOf? }`; `readOnlyHint:true, idempotentHint:true`;
returns `LineageResult` fields; unknown corpus → empty `entries`, corpus not created.

## Component 2 — `inspect` (MCP)

MCP `inspect` tool: input `{ corpus?, claimId }`; `readOnlyHint:true, idempotentHint:true`. Calls
`session.inspect(corpus, claimId)`; returns the raw claim's provenance-relevant fields
(`id, subject, key, value, confidence, valid, recordedSeq, source, tags, status`) or a not-found
result. No new surface op (uses the existing `session.inspect`). Gives agents a provenance handle
for the claim ids `recall`/`history` return.

## Error handling

Read-only and best-effort: `lineageOf` never mutates; an attribution failure degrades gracefully
(entry marked `served`/no reason + a warning in `content`) rather than throwing. Unknown corpus →
empty result (no creation). `inspect` of a missing id → a `{ found: false }`-style result, not an error.

## Testing

- **`src/surface/belief-change.test.ts`** — `groupDispositions` returns a disposition for EVERY
  claim in a group (served / deprecated / merged / tau-invalid) matching the read pipeline; existing
  `supersessionOutcome` tests stay green (behavior-preserving refactor).
- **`src/surface/history.test.ts`** — a `(subject,key)` with a supersession chain (3 distinct
  single-cardinality values, increasing `valid.from`) → `lineageOf` returns all 3 entries: latest
  `served`, older two `deprecated` with `deprecated-by` reasons; a token-similar restatement →
  `merged` (merged-into); a future-dated claim → `tau-invalid`. **Non-destructive proof:** the
  deprecated versions are PRESENT in `entries` (the ledger retained them). Entries ordered by
  `valid.from`. Multi-cardinality key → all `served`.
- **`src/mcp/server.integration.test.ts`** — `history` tool returns the lineage end-to-end;
  `inspect` returns a written claim's fields; both are read-only (no writes; unknown corpus not
  created). `backcompat.test.ts` green.
- Full suite + `tsc --noEmit` green; `layering.test.ts` green.

## Scope / future (deferred)

- `replay`/`derive` MCP tools (create + re-execute derived claims) — a paired slice gated on a real
  need to produce derived claims via MCP.
- `history` scope filters (by tag / source), `asOf` sweeps — only if a consumer needs them.
