# LongMemEval retrieval bench — algebra A/B (design)

**Date:** 2026-06-05
**Status:** Approved design, pre-implementation
**Canonical spec:** `mneme-spec-v0.2-consolidated.md` — §4.4 (`τ_known`), §4.8 (`⊥` + resolution operators), §4.9 (`⊕`)
**Repo home:** `bench/` (benchmark package standard: `convert/` + `datasets/` + per-suite module + npm scripts). Zero `src/` changes.

## Problem

We want fast, repeatable e2e pressure tests of retrieval quality on large corpora, and a
test of the core hypothesis: **claims with complex dependencies/superseding are retrieved
more correctly through the algebra read path (recall + `⊥`/resolve + `τ_known`) than
through plain similarity recall.** Hand-seeding corpora risks seeding data the algebra is
good at. LongMemEval (MIT, HuggingFace) is a standard benchmark whose
**knowledge-update, temporal-reasoning, and abstention** question categories are exactly
the superseding/temporal/contradiction behaviors the algebra exists for, and it ships
labeled evidence (which sessions/turns answer each question), enabling deterministic
scoring with no LLM judge.

Prior decision honored: this is **self-evaluation** (two Mneme read paths against each
other), not a competitor benchmark entry. Comparability against published Mem0/Zep
numbers is a documented phase-2 extension, unblocked for free once this lands.

## Decisions made during brainstorming

1. **LLM at the edge only.** One-time cached extraction pass (sessions → claims JSONL);
   all benchmark runs after that are deterministic and free. Full LLM pipeline
   (answer-gen + judge) rejected for v1: cost + variance pollute the A/B signal.
2. **Arms = resolution on/off.** Bio is write-side (gateway/consolidation), not a read
   path, so "algebra vs bio" is not directly testable; the honest test is
   algebra-read-path vs plain-recall baseline. Bio-ingested arm C is deferred.
3. **Module lives in `bench/`** following the established standard (cf.
   `bench/convert/icews.ts`, `bench/pressure/*`, `pressure:*` scripts), not
   `test/acceptance` (external datasets, long runtimes, machine-specific numbers) and
   not a new top-level package (repo is not a workspace monorepo).

## Data flow

```
download → extract (LLM, one-time, cached) → ingest → answer (arms A/B) → score → report
```

### Download

LongMemEval_S and the oracle variant from HuggingFace into
`bench/datasets/longmemeval/` (gitignored). Exact `curl` commands documented in
`bench/RESULTS.md`, same convention as icews14/ConceptNet. The oracle variant
(evidence-only haystacks) supports a `--oracle` run mode that takes recall out of the
loop: update/temporal-correctness measured on oracle haystacks attribute the result to
resolution alone, separating "retrieval found it" from "resolution chose right".

Scope: the **knowledge-update, temporal-reasoning, and abstention** categories
(~250 questions of the 500), each with its own ~115k-token haystack of timestamped
chat sessions. Full 500-question and LongMemEval_M scale runs are deferred.

### Extract — `bench/convert/longmemeval.ts`

For each timestamped session, an LLM pass emits claims:

```
{ subject, key, value, valid: { from: <session timestamp> }, confidence?, tags }
```

- **Provenance is the linchpin:** every extracted claim carries tags
  `session:<sessionId>` and `turn:<n>` so scoring can match retrieved claims back to
  LongMemEval's labeled evidence. A claim with missing provenance tags is invalid.
- Transport: Anthropic Messages API via plain `fetch` + `ANTHROPIC_API_KEY` env var —
  **no new dependency**. Model ID and prompt version are pinned constants and are
  written into the artifact header line so a cache built under a different
  model/prompt is detected and refused.
- Cache: output `bench/datasets/longmemeval/longmemeval-claims.jsonl`, keyed
  per-session; re-runs skip already-extracted sessions (resumable after interruption).
- Validation: LLM output is zod-parsed; malformed output is retried with backoff, then
  counted as `skipped` — never silently dropped. Conservation check:
  `extracted + skipped == sessions`.
- Testability: the extraction core takes an injected `llm: (prompt: string) =>
  Promise<string>`; unit tests mock it. Network code lives only in the thin CLI shell.

### Ingest — `bench/longmemeval/ingest.ts`

One temp DB per run; **one corpus per question** (its haystack's claims), following the
multitenant pressure-test pattern. Writes go through `Session.writeMany` with
`contradictionPolicy` per arm (see below). Conservation check: `committed == ingested`.

### Answer — `bench/longmemeval/answer.ts`

Both arms share the same recall primitive (lexical `rho.jaccard`), so the A−B delta
isolates what the algebra adds.

- **Arm B (baseline, vanilla-memory emulation):**
  `session.q(corpus, 'rank jaccard "<question>"')` → top-k claims as-is. Old and new
  versions of a fact both surface; no temporal filtering; never abstains.
- **Arm A (algebra):** hand-built `Stage[]` via `session.mneme.query(...)` (the
  documented DSL escape hatch):
  `leaf → tauKnown(question date) → rho.jaccard(question) → ⊥ detection + resolve
  (deprecate-lower / latest-wins) → top-k`. Superseded claims are resolved away;
  unresolvable `⊥` with no surviving claim above threshold → **abstain**.

Exact stage composition for the `⊥`/resolve step (which `resolve*` operator, where it
sits relative to ranking) is an implementation-plan detail; the public exports
(`tauKnown`, `resolveDeprecateLower`, etc.) and the `session.mneme.query` seam are
confirmed present.

### Score — `bench/longmemeval/score.ts`

Deterministic, no judge. Per category × arm:

| Metric | Definition | Hypothesis prediction |
|---|---|---|
| **evidence-recall@k** | labeled evidence turns represented in top-k retrieved claims (matched via provenance tags); report k = 1, 3, 10 | A ≈ B |
| **update-correctness** | knowledge-update Qs: the top *surviving* claim traces to the latest evidence turn, not a superseded one | **A ≫ B** |
| **temporal-correctness** | temporal Qs: `τ_known` at question time retains right-period evidence and excludes wrong-period evidence | **A ≫ B** |
| **abstention accuracy** | unanswerable Qs: arm abstains rather than confidently returning noise | **A > B** (B never abstains) |

### Report — `bench/longmemeval/run.ts`

CLI runner (`parseArgs`, same shape as `bench/dataset.ts`): emits a markdown table per
category × arm (appended manually to `bench/RESULTS.md` per existing convention),
reports `checks N/M`, exits nonzero on any integrity/conservation failure.

## Module layout

```
bench/
  convert/longmemeval.ts            # extraction CLI (LLM at the edge, injected llm fn)
  datasets/longmemeval/             # gitignored: downloads + cached claims JSONL
  longmemeval/
    types.ts                        # dataset + extracted-claim types (zod schemas)
    ingest.ts                       # claims JSONL → corpus-per-question
    answer.ts                       # arm A / arm B pipelines
    score.ts                        # metrics above
    run.ts                          # CLI runner
    fixtures/                       # tiny hand-written 3-question dataset, committed
    *.test.ts                       # colocated unit tests (repo standard)
```

npm scripts: `eval:lme:extract` (network, one-time), `eval:lme` (deterministic run,
both arms), `eval:lme:fixture` (network-free, CI-safe end-to-end smoke over fixtures).

## Error handling

- Extraction: retry-with-backoff on API errors; zod validation; `skipped` accounting;
  resumable per-session cache; model/prompt-version mismatch in cache header → hard
  refuse with instructions, never silent mixing.
- Runner: conservation checks at every stage boundary (extract, ingest); nonzero exit
  on violation, matching `bench/dataset.ts` discipline.
- Missing `ANTHROPIC_API_KEY` only matters for `eval:lme:extract`; the deterministic
  paths never touch the network and fail fast with a clear message if the claims cache
  is absent.

## Testing (TDD)

- `score.test.ts`: each metric against hand-built claim/evidence fixtures, including
  the superseded-claim and abstention edge cases.
- `convert` tests: injected-mock `llm` returning valid, malformed, and partially valid
  outputs; cache resume; header mismatch refusal.
- `answer.test.ts`: arm A resolves a seeded contradiction to the later claim; arm B
  returns both; τ_known excludes a claim recorded after the question date.
- `eval:lme:fixture`: full pipeline over committed fixtures, asserted end-to-end in CI
  without network or datasets.

## Known limitations (stated, accepted)

- **Lexical recall only.** `rho.jaccard` is not an embedding retriever; absolute
  recall@k is not comparable to vector-based systems. Both arms share it, so the A−B
  delta still cleanly tests the hypothesis. Embedding `rho` is a deferred extension.
- **Retrieval-level metrics, not QA accuracy.** No leaderboard-quotable number until
  phase 2 (answer-gen + LLM judge) is added.
- **Extraction quality is a confound** shared by both arms (and by every system on
  this benchmark); pinning model + prompt makes it a constant, not a variable.

## Explicitly out of scope (deliberately deferred)

- Phase-2 answer generation + LLM judge (leaderboard comparability vs Mem0/Zep).
- Arm C: bio-gateway-ingested corpus with consolidation cycles run before querying.
- Embedding-based similarity (`rho`) backend.
- Full 500-question runs, LongMemEval_M, BEAM-scale stress, TQA/DynamicQA/KUP suites.
- Any change to `src/` — if the bench surfaces a needed library capability (e.g. a
  missing resolve stage shape), that becomes its own spec'd slice.
