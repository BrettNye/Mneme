---
title: Mneme Getting-Started + Quickstart
created: 2026-05-29
status: design
---

# Mneme Getting-Started + Quickstart — Design

## 1. Goal

Make Mneme tangible to a newcomer with a **getting-started doc backed by a runnable,
tested example**. The reader should, in a few minutes, understand what Mneme is and copy a
working snippet that exercises the features that make it distinctive — not just CRUD.

Non-goals: no new product surface (no CLI, no service, no MCP). Documentation + one example
file only. (A standalone app on Mneme was explicitly deferred.)

## 2. Audience & scope

A developer evaluating Mneme as an epistemic / claims store. The quickstart covers **core +
key differentiators** in one coherent narrative:

- construct → commit → query (the core path)
- **Beta-typed confidence** (confidence is a distribution, not a scalar)
- **contradiction → resolve** via `supersede`
- **decay over time** via `delta` with a pinned `evaluationClock`
- **reproducibility / replay** via `mneme.replay()`

The bio layer (episodes, cognitive cycle, consolidation, summarize) is out of scope — it
gets its own doc later.

## 3. Scenario

A **coding assistant's memory about a user.** The assistant learns facts about a user,
one fact is contradicted and superseded, confidence is Beta-typed, and relevance decays.
This domain naturally exercises every differentiator without contrivance.

Concretely:
- `subject: "user"`, `key: "pref.language"`, `value: "Python"` — committed with high Beta
  confidence.
- Later the user switches: `value: "Rust"` — committed via `supersede`, deprecating the old
  claim.
- A second fact (`key: "pref.editor"`) is committed earlier in time, then queried under a
  decay policy at a later pinned clock to show effective-confidence drop.

## 4. Narrative (the teaching arc)

1. **Construct.** `createSqliteAdapter(":memory:")` → `createMneme({ adapter, availableTiers:
   [{ kind: "core" }] })` → `mneme.createCorpus(corpusDef)`. One paragraph on corpus = a
   namespaced claim store with a schema + defaults.
2. **Commit a claim.** `mneme.commit(corpusId, candidate, { writer })`. Short explainer:
   `confidence` is a Beta distribution `{ alpha, beta }` — Mneme tracks *how much evidence*
   backs a belief, not just a point probability.
3. **Query it back.** `mneme.query(corpusId, pipe(leaf(corpusId), rho.jaccard(queryText),
   kappa.markdown(maxTokens)))` → a token-bounded `ComposedContext` ready to drop into an LLM
   prompt. Shows the algebra pipeline (select-rank-compose).
4. **Contradiction → resolve.** `mneme.supersede(corpusId, oldId, replacement, { writer })`.
   The old claim becomes `deprecated`; the replacement is committed. One paragraph: Mneme
   makes belief change explicit and auditable rather than silently overwriting.
5. **Decay over time.** `mneme.query(corpusId, pipe(leaf(corpusId), delta.exponential(
   halfLifeDays)), { evaluationClock })` at a clock well after the claim's `recorded` time —
   show `confidence.effective` is lower than `confidence.raw`. Note the pinned clock makes
   this deterministic (and is what replay relies on).
6. **Reproducibility / replay.** `mneme.replay(claim)` returns a `ReplayStatus`. Per the
   decision in §5, demonstrate it on a normal committed claim → `integrity_unknown` (no
   recorded query), and describe in prose that claims derived from a recorded query
   re-execute to `exact` / `mismatch`.

Close with a "where to go next" pointer (the replay engine design, the bio layer).

## 5. Decision: the replay step (option A)

There is **no public API to create a derived claim** — `deriveClaimFrom` / `commitDerived`
are not exported; only `mneme.replay()` is. Hand-building `provenance.derivedFrom` in a
getting-started would be poor pedagogy.

**Decision (A):** demonstrate `mneme.replay()` on a normal committed claim, which returns
`integrity_unknown` (the claim has no recorded query), and *describe* the `exact` / `mismatch`
behavior for derived claims in prose. This keeps every line of the quickstart on the genuine
public surface with no faked provenance. It slightly undersells replay, accepted as the
honest trade.

**Tracked follow-up (not built here):** expose a minimal public derive surface
(`deriveClaimFrom` / `commitDerived`, or a `mneme.derive(...)` method) so a future quickstart
revision can show the full `derive → replay → exact` arc. Logged as a known public-surface
gap; deliberately deferred to keep this slice doc-only.

## 6. Files & delivery

| File | Purpose |
|------|---------|
| `README.md` (new, repo root) | Prose quickstart with annotated code excerpts; the human-facing doc. |
| `examples/quickstart.ts` | Canonical runnable example — the source of truth for the code. Exports `runQuickstart()` returning structured results; a script entry (guarded by an `import.meta` check) prints a readable trace. |
| `examples/quickstart.test.ts` | Imports `runQuickstart()` and asserts key outcomes so the example cannot silently rot. |
| `package.json` | Add `tsx` as a devDependency and an `"example": "tsx examples/quickstart.ts"` script. |

**Drift control.** `examples/quickstart.ts` is the canonical code; the README shows excerpts
from it. The test guards the example against API drift. README excerpts are kept short and a
maintainer note points to the example as source of truth.

## 7. `runQuickstart()` shape (testability)

`runQuickstart()` reads time-dependent operators through pinned `evaluationClock` values
(never wall-clock), returning a structured summary. Note: a committed claim's `recorded`
timestamp is set from wall-clock at commit time, so the exact `effectiveAfterDecay` value is
not bit-stable across runs — but the property the test asserts (`effectiveAfterDecay <
rawConfidence`) is stable for any positive age. Summary shape, e.g.:

```ts
export interface QuickstartResult {
  committedId: string;
  contextIncludesValue: boolean;       // step 3: composed context contains the claim value
  supersededOldStatus: string;          // step 4: "deprecated"
  replacementValue: string;             // step 4: "Rust"
  rawConfidence: number;                // step 5
  effectiveAfterDecay: number;          // step 5: < rawConfidence
  replayStatusOfPlainClaim: string;     // step 6: "integrity_unknown"
}
```

A guarded script entry runs it and `console.log`s a readable trace for `npm run example`.

## 8. Testing strategy

`examples/quickstart.test.ts` asserts:
- `committedId` is a non-empty string.
- `contextIncludesValue === true`.
- `supersededOldStatus === "deprecated"` and `replacementValue === "Rust"`.
- `effectiveAfterDecay < rawConfidence` (decay actually reduced effective confidence).
- `replayStatusOfPlainClaim === "integrity_unknown"`.

Real integration only — a real in-memory sqlite adapter, no mocks. Must pass under the
existing `vitest run` suite and keep `tsc --noEmit` clean.

## 9. Acceptance criteria

- `README.md` exists at repo root and walks through all six narrative steps with code.
- `examples/quickstart.ts` runs cleanly via `npm run example` (and `npx tsx
  examples/quickstart.ts`), printing a readable trace.
- `examples/quickstart.test.ts` passes and asserts the §8 outcomes.
- Every code path uses only the **public** package surface (imports from the package root /
  `mneme`), except the test runner harness.
- `tsx` is a devDependency; `"example"` script present.
- Full suite green; `tsc --noEmit` clean.

## 10. Out of scope / follow-ups

- Public derive surface (§5) — tracked, deferred.
- Bio-layer getting-started — separate doc.
- CLI / MCP / service on Mneme — deferred by explicit decision.
