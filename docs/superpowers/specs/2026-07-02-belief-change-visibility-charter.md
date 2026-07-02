---
id: superspec-charter-belief-change-visibility
title: "Belief-change visibility & maintenance"
type: superspec-charter
created: 2026-07-02
---

<!-- THIN charter: connective tissue ONLY. Child detail lives in each child's plan. -->

# Belief-change visibility & maintenance

## Intent

Make Mneme's core differentiator — the non-destructive, observable, replayable belief-change
ledger — **visible and maintainable at the product (MCP) surface**. Today the algebra changes
the belief state (supersede, merge, collapse) and keeps every prior version in the ledger, but
none of that is surfaced: `remember` returns `{id,status}` (no supersession), no tool shows a
claim's lineage or replays a derivation, and the census/reconcile detectors never run on a
cadence so corpora drift back into fragmentation. Three interlocking pieces close this, all
upholding the wedge: nothing silently changes or hides a belief, and no canonicalization is
applied without a proposal a human/agent confirms. Sourced from the post-A/B/C utilization audit
(this session) and the standing `mneme-mcp-surface-hides-algebra` / `mneme-positioning-wedge`
notes.

## Decomposition — the children

- **belief-change-maintainable** — supersession-aware `remember` response (per-write
  belief-change detector, gap #2) + an `audit` propose-loop (whole-corpus detector → ranked
  proposed declarations → one-step confirm, gap #4).
- **belief-change-history** — a `history`/lineage tool surfacing the full non-destructive lineage
  of a `(subject,key)`, plus `inspect`/`replay`/`derive` wired to the MCP surface (gap #1).

## Interfaces / contracts between pieces

**The one shared contract is the belief-change reason vocabulary.** REUSE and extend Cluster A's
`DispositionReason` union (defined in `src/surface/explain.ts`: `served | merged-into{targetId} |
deprecated-by{byId,via} | tau-invalid | below-floor | abstained | over-limit | alias-or-flag`) as
the SINGLE canonical set of belief-change kinds. Every surface speaks it:

- `explain` (Cluster A, shipped) — read-time per-claim dispositions.
- **write-response (#2)** — a `SupersessionOutcome` for what THIS write did, e.g.
  `{ action: "committed"|"superseded"|"merged"|"duplicate"; deprecatedIds: string[]; reason?: DispositionReason }`
  where `reason` uses the SAME kinds (`deprecated-by`, `merged-into`).
- **audit (#4)** — a ranked list of PROPOSED declarations, each carrying the belief-change it
  would resolve (single-cardinality collision → `deprecated-by via:"single-cardinality"`;
  key-alias candidate → a merge proposal), in the same vocabulary.
- **history (#1)** — lineage entries, each describing a transition in the same vocabulary.

**Cross-child decision (charter-owned):** do NOT mint a parallel "supersession"/"event"/"lineage"
type. If a kind is missing (e.g. a write-time `superseded-earlier`), EXTEND the `DispositionReason`
union at its home — never fork it. **Vocabulary home:** it currently lives in `explain.ts`; the
FIRST child that needs to import it cross-module promotes it to a neutral home
(`src/surface/belief-change.ts` or `types.ts`), mirroring the Cluster C `ReadDeps → types.ts`
promotion; `explain.ts` then re-exports for back-compat. Subsequent children import from the
neutral home.

## Shared invariants

- **I1 — Non-destructive.** A superseded/deprecated claim is never deleted; it stays in the
  ledger and remains readable. `history` (#1) exposes it; no child removes it.
- **I2 — Every belief-change observable.** No write silently supersedes (#2 reports it); no read
  silently collapses (Cluster C already warns). A change the agent cannot see is a defect.
- **I3 — Propose-never-apply.** `audit` (#4) and any canonicalization surface PROPOSE
  declarations/merges; a human or agent explicitly confirms them (applies via
  `remember`(alias-of) / `declare_cardinality`). **No surface auto-applies a canonicalization.**
  Violating this turns Mneme into a destructive KV store — it is the wedge, a hard rule.
- **I4 — One vocabulary.** All surfaces use the reused/extended `DispositionReason` kinds; no
  child defines its own belief-change/supersession/lineage shape (see Interfaces).

## Build order

- The shared vocabulary is settled first: `DispositionReason` is reused as-is or extended/promoted
  by whichever child imports it cross-module first (per Interfaces).
- **belief-change-maintainable** and **belief-change-history** share ONLY the vocabulary — no code
  dependency between them → independently pullable in either order. Pull ONE child at a time;
  **belief-change-maintainable first** (per direction).
- **Out-of-scope guard (no child may build it):** post-hoc *subject* merging stays deferred —
  #4's subject half is prevention-only (reconcile-at-ingest). No subject-alias / subject-rewrite
  mechanism in any child.

## Child status

| id | child | status | order |
|----|-------|--------|-------|
| belief-change-maintainable | write-response supersession (#2) + audit propose-loop (#4) | planned | 1 |
| belief-change-history | history/lineage + inspect/replay/derive to MCP (#1) | not started | 2 |
