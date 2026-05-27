# Design: Bio Layer — Summarization (`SummarizeFn`), additive digest

**Date:** 2026-05-26
**Status:** Approved design (brainstorm complete). Next step: DAG implementation plan via `writing-dag-plans`.
**Type:** New capability in the bio layer (`src/bio/`). No substrate changes required (reuses the runId query filter Dreaming added).

**Sequencing note:** This builds directly on the **Consolidation slice** (the marker convention, the Mneme-backed gateway's derive path, `BioPolicy`). That slice is in review as PR #1. **Do not start implementation until PR #1 is resolved/merged** — the design is safe to finalize now, but the code rests on consolidation's foundation.

---

## 1. Context and relationship

Summarization is the **model-dependent third face of Consolidation** (deferred from that slice's §11). The three faces:

- **Dreaming** — produces *new* knowledge (insights/hypotheses).
- **Consolidation / fold** — re-packs *redundant agreeing* claims (same `subject/key/scope/value`) into one pooled claim.
- **Summarization (this slice)** — re-packs *heterogeneous* episode claims into a compact **natural-language digest** ("a digest to wake up with").

It is the LLM sibling of Dreaming and mirrors that pass's shape: an injected generative port, bio-owned selection/admission/marking, fixed-low non-inflating confidence.

### 1.1 Additive, by the same invariant
The write side **only derives** the digest claim. Inputs are never mutated or deprecated. This respects the bio invariant ("forgetting = read-time suppression, never a write"). Unlike fold — whose deprecation is safe because a fold is a *lossless* re-encoding of identical claims — a summary is a *lossy* abstraction over heterogeneous claims; deprecating its inputs would use a write to hide structured, queryable facts behind prose. So summarization stays additive.

### 1.2 Driver and where compression happens
**Driver: context/session economy** — a compact digest the next session loads cheaply at wake-up. The compression payoff is realized at **read time** (you load the digest instead of all the details); the episodic inputs fade from the default view via the existing wave-1 suppression + decay. **Not** in scope: reducing stored-corpus size (that is a captured deferral, §15 — to revisit only if storage growth becomes the driver, and likely via archival/tiering rather than bending summarize into a deletion tool).

---

## 2. Scope

**In scope:** the async `summarize(episode, { modelVersion })` pass (select → summarizeFn → admit); the injected `SummarizeFn` port + `ProposedSummary`/`SummarizeReport` contracts; the collapse guard; admission with a fixed-low `SUMMARY_PRIOR`, the `"summary"` marker, and runId tagging; the minimal **`getDigest(episode)`** retrieval; optional runner scheduling; the `BioPolicy.summarize` sub-policy.

**Out of scope:** see §15 (all captured to revisit).

---

## 3. Architecture — async pass + thin retrieval

New module `src/bio/processes/summarize.ts` (+ `summarize-types.ts`). Structurally mirrors Dreaming (its LLM sibling).

```
async summarize(episode, { modelVersion }):        [src/bio/processes/summarize.ts]
   1. SELECT  gateway.read({ runIds: episode.runIds })            — episode's produced claims
                → EXCLUDE prior summaries (provenance.workflow === "summary")   ← collapse guard
                → token-bound: top-N by recency-then-confidence (maxInputClaims)
   2. SUMMARIZE (injected port)  await summarizeFn({ episode, claims, maxSummaries })
                → ProposedSummary[]
   3. ADMIT   validate each cites ⊆ selected → build CandidateClaim
                → derive AppendOp → gateway.apply
   → SummarizeReport { proposed, admitted, dropped, errors }

getDigest(episode): Claim[]
   = gateway.read({ runIds: episode.runIds }) filtered in-memory to provenance.workflow === "summary"
```

- **Reuses the Mneme-backed gateway** (`read` + `apply`, derive-only) — append-only, idempotency, scope validation, contradiction policy inherited. No new write path; the synchronous cycle, the dream pass, and the consolidate pass are untouched.
- **Bio owns Select + Admit + marking; the consumer owns only the generative `SummarizeFn`.** Safety cannot be bypassed by a sloppy model integration (Approach A, consistent with Dreaming).
- **Marker:** digests are `provenance.workflow = "summary"` (a bio-owned constant, same trick Dreaming/Consolidation use). No core `Source`/provenance change.

---

## 4. The `SummarizeFn` port and contracts

Defined in `summarize-types.ts`, exported via the barrel. The one seam the consumer implements.

```ts
type SummarizeFn = (input: SummarizeInput) => Promise<ProposedSummary[]>;

interface SummarizeInput {
  episode: Episode;
  claims: Claim[];        // the selected, collapse-safe, token-bounded set (bio decides this)
  maxSummaries?: number;  // soft budget hint bio passes through
}

interface ProposedSummary {
  key: Key;               // kebab-dotted identity of the digest claim
  value: Value;           // the gist — typically a string (Value supports string)
  scope?: Scope;
  cites: ClaimId[];       // REQUIRED: which input claims this gist re-packs
  rationale?: string;     // optional basis text → admitted as evidence
}

interface SummarizeReport {
  proposed: number;
  admitted: number;
  dropped: { key?: string; reason: string }[];
  errors: string[];
}
```

- **Granularity is the consumer's call.** `SummarizeFn` returns `ProposedSummary[]`; bio admits each. The consumer's prompt decides whether to emit one session digest or several topic gists — bio stays granularity-agnostic (mirrors `DreamFn` returning N insights).
- **Structured output, not freeform text.** The consumer owns the prompt *and* parsing; bio never sees raw model text.
- **`cites` is required and validated** ⊆ the selected set; insights citing unknown ids are dropped (guards hallucinated citations). Feeds `derivedFrom.inputClaims` + the evidence DAG.
- **No confidence field.** The consumer cannot set a digest's confidence — bio assigns the fixed `SUMMARY_PRIOR` at admit (anti-inflation; a generated digest cannot declare itself trustworthy).

---

## 5. Select stage (collapse guard)

1. **Gather the episode's produced claims** — `provenance.runId ∈ episode.runIds`, via the existing runId query filter (the substrate prerequisite Dreaming already shipped). This is what was *produced/recorded* in the session, not the surfaced/read set.
2. **Collapse guard — exclude prior summaries:** drop any claim with `provenance.workflow === "summary"`. Because a summary is thereby never in the input set, **a summary can never cite a summary → no chain can form → no depth counter is needed** (simpler than Dreaming's depth cap, which exists only because validated dreams re-enter their input). Double-protected: a `SummarizeFn` that cites a summary id is rejected by the `cites ⊆ selected` check (§6). **Dreams (`workflow:"dream"`) are *not* excluded** — a digest legitimately re-packs the session's hypotheses; no loop arises (dream ≠ summary).
3. **Token bound** — cap to `maxInputClaims` (BioPolicy knob), keeping top-N by recency-then-confidence, so the model's context can't be blown. Salience-based selection is a captured deferral (§15) — for now bio provides the bounded set and the *model* judges what is digest-worthy.

---

## 6. Admit stage

For each validated `ProposedSummary`, build a `CandidateClaim`:

- `key`/`value`/`scope` from the proposal (the gist string is the `value`).
- `status: "candidate"`, `source: "llm"`, `provenance.workflow: "summary"`.
- **`provenance.runId = episode.runIds[0]`** — so the digest is retrievable as part of the episode by `getDigest` (§7). *Verified:* `src/write/pipeline.ts` does not touch `provenance`, and the sqlite adapter persists `provenance.runId` as-written, so a writer-supplied runId survives commit. (An episode with no runIds has no produced claims, so `summarize` is a no-op for it — consistent.)
- `confidence`: a fixed low **`SUMMARY_PRIOR`** (BioPolicy knob, default `Beta(1,3)`). Vestigial for ranking — the digest is retrieved by marker, not by confidence (§8) — but kept low for anti-inflation so a digest can never masquerade as a verified belief in default `recall()`.
- `provenance.derivedFrom`: `{ queryExpression: "summary", inputClaims: cites, evaluationClock: now, combinationRule: "summary@<modelVersion>" }`.
- `evidence`: cited inputs as `{ kind: "claim" }` refs (+ `rationale` if present).

Emit `derive` AppendOps, apply via `gateway.apply` with `opKey = "<episode>:<summarizePass>:<i>"` (idempotency carries over). Return `SummarizeReport`.

*Acyclicity:* a digest cites only older input claims, so the evidence DAG cannot cycle by construction (same argument as Dreaming/Consolidation).

---

## 7. Retrieval — `getDigest(episode)`

The read-side payoff ("wake up with it"), in scope as a minimal capability:

```
getDigest(episode): Claim[]
   = gateway.read({ runIds: episode.runIds })   // existing indexed runId filter
       .filter(c => c.provenance.workflow === "summary")
```

- **No substrate change** — reuses the runId index; the marker filter is in-memory, bounded to the episode's claims.
- Does **not** apply a restrictive status filter (the digest is `candidate`; it must be returned).
- Cross-episode / corpus-wide digest queries (an indexed `workflow` filter) are the deferred alternative (§15), to add only if needed.

The richer "blend the gist into `ComposedContext` / prefer-gist composition lens" is a **deferred read-side follow-on** — `getDigest` returns the digest claims; how the consumer composes them is theirs for now.

---

## 8. Surfacing & confidence rationale

A digest is an **artifact you load explicitly** (by marker, via `getDigest`), **not a belief that competes on confidence** in default `recall()`. This resolves the tension cleanly:

- Low confidence does **not** hide it — `getDigest` ignores the suppression/ranking path.
- It never **masquerades as a verified belief** — it stays `candidate` + low `SUMMARY_PRIOR`, so if it *does* appear in a general query it reads as clearly subordinate (anti-inflation parity with Dreaming's `DREAM_PRIOR`).

---

## 9. Error handling (fail-safe — mirror Dreaming)

Guiding principle unchanged: on any uncertainty, **write nothing**.

| Failure | Handling |
|---|---|
| `SummarizeFn` throws / times out | Catch → report `errors`, apply nothing. |
| Malformed / empty proposals | Validate each (valid key, value present, `cites` non-empty ⊆ selected). Drop invalid → `dropped`; admit the valid rest. All-bad batch → `admitted: 0`, no throw. |
| Empty eligible set | Skip the model call; return `{ proposed: 0, admitted: 0 }`. Never call `SummarizeFn` with nothing. |
| `gateway.apply` fails | Atomic batch: nothing applied, error in report. |
| Concurrent `summarize(episode)` | **Single-flight per episode** (mirrors Dreaming): a second pass returns immediately with an error and applies nothing. |

---

## 10. Determinism

Generative, so a digest's replay status is inherently **degraded** — bio captures model version (`combinationRule = "summary@<modelVersion>"`) + `inputClaims` + `evaluationClock` (auditable: why / what / which model), but the generative step is not bit-reproducible. Aligns with Dreaming and the substrate's derived-writes replay stratification.

---

## 11. Sleep-phase ordering

Recommended runner sequence: **`consolidate → dream → summarize`** — the digest reflects the *final* post-consolidation, post-dream state, and **includes this sleep's freshly-generated candidate dreams** ("wake up aware of the new ideas"). The `SummarizeFn` prompt decides how much to emphasize speculation — bio adds no "exclude candidate dreams" filter. **Ordering is a non-binding convenience**: the three passes are independent; the consumer sequences them however they want.

---

## 12. Components and isolation

| Unit | Responsibility | Depends on |
|---|---|---|
| `SummarizeFn` / `ProposedSummary` / `SummarizeInput` / `SummarizeReport` (types) | The consumer-implemented port + structured I/O | core types |
| Select | Build the collapse-safe, bounded input set | gateway (read, runId filter), the `"summary"` marker, episode |
| Admit | Materialize proposals into marked, runId-tagged `derive` ops | gateway (apply), core claim/provenance, `SUMMARY_PRIOR` |
| `summarize(episode, opts)` pass | Orchestrate select → summarizeFn → admit; fail-safe; single-flight | the above + injected `summarizeFn` |
| `getDigest(episode)` | Marker-filtered episode read | gateway (read, runId filter) |

---

## 13. Wiring and module structure

- **New:** `src/bio/processes/summarize.ts` (+ `summarize-types.ts`, + tests) — the port/types, the pass, `getDigest`.
- **Additive edits:**
  - `src/bio/bio-memory.ts` — inject `summarizeFn` at construction; add `async summarize(episode, { modelVersion })` and `getDigest(episode)`.
  - `src/bio/policy.ts` — add `BioPolicy.summarize = { prior?, maxInputClaims? }` + defaults (`SUMMARY_PRIOR = Beta(1,3)`, `maxInputClaims = 200`), merged by `resolvePolicy`.
  - `src/bio/runner.ts` — optional thin `startSummarizing({ intervalMs }, episode)` (mirrors `startConsolidating`/`startDreaming`).
  - `src/index.ts` — export `SummarizeFn`, `ProposedSummary`, `SummarizeInput`, `SummarizeReport`, and the `summarize`/`getDigest` surface.
- **No substrate change.** Reuses the runId query filter.
- **Integration contract (shared with Dreaming/Consolidation):** the consumer tags claims it writes during a session with the episode's `runId`; otherwise an episode has no produced claims and `summarize`/`getDigest` are no-ops for it.

---

## 14. Testing strategy

Most of the suite is pure/fake — no real model.

1. **Select:** fixture claim set → assert prior summaries excluded (collapse guard), dreams *included*, runId membership, top-N bound.
2. **Admit:** `ProposedSummary[]` → assert the `derive` ops: `candidate` / `source:"llm"` / `workflow:"summary"`, `SUMMARY_PRIOR`, `provenance.runId = episode runId`, `derivedFrom.inputClaims`, model version in `combinationRule`, evidence claim-refs; a proposal citing an unknown id is dropped.
3. **Fake `SummarizeFn`s:** happy path; one that throws (fail-safe → errors, nothing applied); one returning malformed (dropped).
4. **`getDigest`:** seed an episode with summary + non-summary claims; assert only `workflow:"summary"` claims return, scoped to the episode's runIds; candidate digests are returned (not status-filtered out).
5. **End-to-end (in-memory SQLite gateway via `makeBioMneme`):** run `summarize(episode)` with a fake `SummarizeFn`; assert the digest is admitted, retrievable via `getDigest`, inputs untouched (additive — present and unchanged in a raw read), idempotent re-run applies nothing.
6. **Collapse-guard property test:** over repeated passes feeding outputs back, assert **no summary is ever fed to `SummarizeFn`** (the loop is structurally impossible) — the summarize analogue of Dreaming's collapse test.

Tests follow the Mneme convention (colocated `*.test.ts`, vitest globals).

---

## 15. Out of scope (deferred — captured to revisit)

- **Compressive deprecation of inputs** — deprecating summarized inputs for stored-corpus reduction. Revisit **only if** stored-corpus growth (not context economy) becomes the driver; likely belongs at the substrate as archival/tiering rather than as a summarize-time deletion. Explicitly punted per the brainstorm.
- **Prefer-gist composition lens** — a read-side policy that blends/prefers the digest in `ComposedContext`. `getDigest` is the minimal retrieval; richer composition is a follow-on.
- **Hierarchical / multi-level digests** — a digest of digests (e.g. a weekly digest of daily digests). The collapse guard excludes summaries from input, so this is opt-in later, not accidental.
- **Salience-based input selection** — choosing *which* claims to feed beyond recency/confidence (re-homes the deferred recall-shaping/salience mechanism). For now the model judges salience from the bounded set.
- **Indexed `workflow` substrate query** — a `workflow` filter on `ExecutionPlan`/sqlite for corpus-wide digest queries. `getDigest`'s in-memory marker filter suffices per-episode; add only if cross-episode digest queries are needed.
- **Cross-pass interaction (note):** a Dreaming pass *can* ingest a `summary` claim as input (it isn't excluded by Dreaming's collapse filter). Harmless (dream ≠ summary, no loop); tightening Dreaming's select to also exclude summaries is a possible later refinement, out of scope here.
- **Exact replay** — generative ⇒ degraded; shares the substrate's deferred replay-re-execution engine.

---

## 16. Dependencies and sequencing

- **Gated on the Consolidation slice (PR #1):** reuses the marker convention, the Mneme-backed gateway's derive path, and `BioPolicy`/`resolvePolicy`. Finalize this design now; **start implementation after PR #1 merges.**
- **Already in place:** the Mneme-backed bio gateway (derive, idempotency, append-only); the episode model; the runId query filter; derived-writes + provenance; the Dreaming pass as the structural template.
- **Consumer responsibility:** supply a `SummarizeFn` + `modelVersion`, and tag session writes with the episode's `runId`. Without a configured `summarizeFn`, `summarize()` is a no-op/error (bio has no default model).
