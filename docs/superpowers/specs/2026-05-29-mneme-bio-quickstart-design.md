---
title: Mneme Bio-Layer Quickstart
created: 2026-05-29
status: design
---

# Mneme Bio-Layer Quickstart — Design

> Deliverable 2 of 2. Sibling of the epistemic-core quickstart
> (`docs/superpowers/specs/2026-05-29-mneme-quickstart-design.md`).

## 1. Goal

Make Mneme's **bio (cognitive) layer** tangible with a getting-started section backed by a
runnable, tested example. A reader should see, in one coherent loop, what the bio layer adds
on top of the claim store: episodic memory that **recalls** relevant claims, **reinforces**
the ones that led to success, and **consolidates**.

Non-goals: no new product surface. Documentation + one example file + its test. The
`summarize` / `dream` processes (which require an injected model function) are out of scope —
mentioned in prose, not demonstrated.

## 2. Framing & scope

- **Framing:** AI agent episodic memory — the bio layer's intended home turf. (The epistemic
  quickstart deliberately used a non-AI monitoring scenario; this one embraces the agent
  framing because episodes / recall / reinforcement / consolidation *are* cognitive concepts.)
- **Scope:** core loop **+ consolidation**, model-free throughout. No stubbed model functions.
  `summarize` / `dream` are noted as extension points but not built into the example.

## 3. Scenario

An **AI coding agent's episodic memory about a project.** The agent stores facts it has
learned ("the build command is `npm run build`", "tests live under `src/`"). For a task it
recalls those memories; the task succeeds; the recalled memories are reinforced (their Beta
`alpha` rises); then the episode is consolidated.

## 4. Bio-layer surface used (all public, from the package root)

- `createBioMemory({ mneme, corpusId })` → bio memory instance.
- `bio.openEpisode()` → `{ id }`.
- `bio.recall(query: BioQuery, policies: RetrievalPolicy[], ctx: RetrievalContext, episode?: EpisodeId): Claim[]`
  — `BioQuery = { corpusId }`; `RetrievalContext = { now, decay }`. Passing the episode id
  records the surfaced claim ids on the episode.
- `bio.recordOutcome(episode, "success" | "failure", weight?): CycleReport` — buffers the
  outcome and runs an inline cognitive cycle.
- `bio.consolidate(episode): ConsolidationReport`.

The mneme instance is wired the public way (`createMneme` + `createSqliteAdapter` +
`createCorpus`). The `makeBioMneme` test helper is intentionally **not** used (it is not part
of the public surface).

Relevant shapes:
- `CycleReport = { opsApplied: number; claimsSuperseded: number; errors: string[] }`.
- `ConsolidationReport = { promoted: number; folded: number; deprecated: number; dropped: {...}[]; errors: string[] }`.

## 5. Narrative (the teaching arc)

1. **Construct.** `createMneme` + `createSqliteAdapter(":memory:")` + `createCorpus`, then
   `createBioMemory({ mneme, corpusId })`. One paragraph: the bio layer is a cognitive overlay
   — it doesn't replace claims, it learns *which* claims matter from how episodes turn out.
2. **Seed memories.** `mneme.commit(...)` two facts the agent knows, each with a Beta
   confidence (e.g. `alpha: 3, beta: 1`).
3. **Open an episode** — `const ep = bio.openEpisode()` (one task/session).
4. **Recall** — `bio.recall({ corpusId }, [], ctx, ep.id)` surfaces the memories into the
   episode (`ctx = { now, decay: () => 1 }`). Show the recalled count.
5. **Record a successful outcome** — `bio.recordOutcome(ep.id, "success")` returns a
   `CycleReport`; the cognitive cycle (evidence-update) reinforces the surfaced memories by
   superseding each with a higher-`alpha` Beta. One paragraph on bounded credit assignment:
   only *surfaced* claims get credit.
6. **Observe reinforcement** — read the active memory back; its `alpha` (and confidence mean)
   is higher than the seeded value.
7. **Consolidate** — `bio.consolidate(ep.id)` returns a `ConsolidationReport`.

Close with a "where to go next": `summarize` / `dream` take an injected model function; the
replay engine; the epistemic-core quickstart.

## 6. Files & delivery

| File | Purpose |
|------|---------|
| `README.md` (modify) | Replace the closing "bio layer ships with its own quickstart (coming next)" line with a `## Bio layer (cognitive memory)` section: short prose + annotated excerpts, pointing at the runnable example. |
| `examples/bio-quickstart.ts` | Canonical runnable example — exports `runBioQuickstart()` returning a structured summary; a guarded script entry prints a readable trace. |
| `examples/bio-quickstart.test.ts` | Runs `runBioQuickstart()` and asserts the §7 outcomes. |
| `package.json` | Add `"example:bio": "tsx examples/bio-quickstart.ts"` to `scripts` (tsx devDep already present from deliverable 1). |

vitest already discovers `examples/**/*.test.ts` (added in deliverable 1). `examples/` stays
outside the `tsconfig` `include`, so the example is validated by execution under vitest/tsx
and the main `tsc --noEmit` remains clean.

## 7. `runBioQuickstart()` shape (testability)

```ts
export interface BioQuickstartResult {
  recalledCount: number;          // step 4: memories surfaced into the episode (>= 1)
  cycleErrors: number;            // step 5: CycleReport.errors.length (0)
  opsApplied: number;             // step 5: CycleReport.opsApplied (> 0 — reinforcement happened)
  seededAlpha: number;            // step 2
  reinforcedAlpha: number;        // step 6: active memory's alpha after the cycle (> seededAlpha)
  consolidationErrors: number;    // step 7: ConsolidationReport.errors.length (0)
}
```

A guarded script entry runs it and prints a readable trace for `npm run example:bio`.

To read `reinforcedAlpha`: after the cycle, the seeded claim has been superseded, so read the
active (non-`deprecated`) claim for that subject/key from the corpus and take
`confidence.parameters.alpha`.

## 8. Testing strategy

`examples/bio-quickstart.test.ts` asserts:
- `recalledCount >= 1` (recall surfaced the seeded memory).
- `cycleErrors === 0` and `opsApplied > 0` (the cognitive cycle ran and reinforced).
- `reinforcedAlpha > seededAlpha` (successful use strengthened the memory).
- `consolidationErrors === 0` (consolidation ran cleanly on a known episode).

Real integration only — a real in-memory sqlite adapter, no mocks. Must pass under the
existing `vitest run` suite and keep `tsc --noEmit` clean.

## 9. Acceptance criteria

- `README.md` has a `## Bio layer (cognitive memory)` section walking the seven narrative
  steps with code; the old "coming next" line is gone.
- `examples/bio-quickstart.ts` runs via `npm run example:bio` (and `npx tsx
  examples/bio-quickstart.ts`), printing a readable trace; exports `runBioQuickstart()`.
- `examples/bio-quickstart.test.ts` passes and asserts the §8 outcomes.
- Every code path uses only the public package surface; `makeBioMneme` is not used.
- `"example:bio"` script present.
- Full suite green; `tsc --noEmit` clean.

## 10. Out of scope / follow-ups

- `summarize` / `dream` demonstrations (need an injected model function) — noted as extension
  points, not built.
- Public derive surface — still tracked from deliverable 1, unrelated here.
