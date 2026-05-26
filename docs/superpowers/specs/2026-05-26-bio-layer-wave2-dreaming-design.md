# Design: Bio Layer Wave 2 — Dreaming

**Date:** 2026-05-26
**Status:** Approved design (brainstorm complete). Next step: DAG implementation plan via `writing-dag-plans`.
**Type:** New capability in the bio layer (`src/bio/`), plus one small substrate prerequisite in `src/adapters/`.

---

## 1. Context and relationship

This is **wave 2** of the bio cognitive layer (`docs/superpowers/specs/2026-05-26-bio-layer-design.md`). Wave 1 shipped reinforcement, forgetting-as-suppression, outcome-reweighting, and the runner on the append-only gateway. Wave 2 adds **Dreaming**: a scheduled, generative pass that reviews an episode's claims and writes back **new insight claims** the next session can use ("wake up smarter").

Dreaming is the bio layer's **first LLM-dependent process** — everything in wave 1 is model-free. The substrate it builds on is in place: combination `⊕` and contradiction `⊥` are done; the append-only bio gateway exists (`src/bio/gateway.ts`).

**Write-path note (audit finding).** Dreaming writes through the **bio gateway's append-only `derive`** (`adapter.insertClaim`), which is a *separate* write path from the substrate's `Promoter`/`commitDerived` pipeline (`src/write/pipeline.ts`, `derived-write.ts`). That pipeline adds scope-schema validation, write-time contradiction-policy enforcement, monotonic seq, and provenance finalization — none of which the gateway path performs. Dreaming therefore does **not** route through the substrate's derived-write machinery; it compensates in-layer (scope validation in Admit, §6; conflicts surfaced at read-time via `⊥`). Reconciling the two write paths (routing the bio layer through `Promoter`) is tracked as architectural debt (§13), to be brainstormed **after** Dreaming is implemented.

**Consolidation** (the other wave-2 mechanism in the original plan) is **out of scope here** — Dreaming is brainstormed and built alone to isolate the novel/risky design.

---

## 2. Scope

**Dreaming produces NEW knowledge — insights/hypotheses, including generalizations** ("these 3 failures share cause X", "tool Y needs workaround Z", "across N episodes the pattern is Z"). It does **not** produce summaries/compression — that is re-packing existing claims, which is Consolidation's job (deferred). A generalization counts as an insight (new abstraction); a compact restatement of the same facts does not.

**In scope:** the async `dream(episode)` pass (select → dream → admit), the injected `DreamFn` port, collapse-prevention guardrails, dream admission with provenance, the runId substrate query filter, optional runner scheduling.

**Out of scope:** see §13.

---

## 3. Architecture

Dreaming is a **separate async pass**, distinct from the synchronous wave-1 cycle. New module `src/bio/processes/dreaming.ts`; a `dream(episode)` entry point on the `BioMemory` facade; an optional async trigger on the runner.

```
async dream(episode, { modelVersion }):           [src/bio/processes/dreaming.ts]
   1. SELECT  (bio, read-side)  ── gateway.read(episode claims by runId)
                                   → collapse filter (drop unvalidated dreams)
                                   → depth cap → token bound
   2. DREAM   (injected port)   ── await dreamFn({ episode, claims, maxInsights })
                                   → ProposedInsight[]
   3. ADMIT   (bio, write-side) ── validate cites → compute depth → build CandidateClaim
                                   → derive AppendOp → gateway.apply
   → DreamReport { proposed, admitted, dropped, errors }
```

- **Reuses the wave-1 gateway** (`read` + `apply`), so append-only and idempotency carry over for free. Dreaming writes only `derive` ops; it never mutates. The synchronous `cycle`/`evidence-update` path is untouched.
- **Bio owns Select and Admit (incl. all collapse guardrails); the consumer owns only the generative `DreamFn`.** Safety cannot be bypassed by a sloppy model integration (this is Approach A; consumer-owned generation was rejected for ceding safety control).
- **Dream marking without a core change.** The `Source` enum (`src/core/claim.ts`) has no `"dream"` value and is not reopened. A dreamed claim is `source: "llm"` **marked via `provenance.workflow = "dream"`** (a bio-owned constant). The collapse filter identifies dreams by that marker + `status`.

---

## 4. The `DreamFn` port and `ProposedInsight` contract

Defined in `src/bio/processes/dreaming.ts`, exported via the barrel. The one seam the consumer implements; the model integration lives entirely outside bio.

```ts
type DreamFn = (input: DreamInput) => Promise<ProposedInsight[]>;

interface DreamInput {
  episode: Episode;
  claims: Claim[];        // the selected, collapse-safe, token-bounded set (bio decides this)
  maxInsights?: number;   // soft budget hint bio passes through
}

interface ProposedInsight {
  key: Key;               // kebab-dotted identity of the new insight
  value: Value;
  scope?: Scope;
  cites: ClaimId[];       // REQUIRED: which input claims this insight derives from
  rationale?: string;     // optional basis text → admitted as evidence
}

interface DreamReport {
  proposed: number;
  admitted: number;
  dropped: { key?: string; reason: string }[];
  errors: string[];
}
```

- **Structured output, not freeform text.** `DreamFn` returns parsed `ProposedInsight[]`; the consumer's implementation owns the prompt *and* parsing the model response. Bio never sees raw model text → no prompt/parse logic, model-free, trivially fakeable in tests.
- **`cites` is required and validated.** Bio verifies every cited id was in the selected set and drops insights citing unknown ids (guards against hallucinated citations). `cites` feeds `derivedFrom` and the depth computation.
- **No confidence field.** The consumer cannot set a dream's confidence — bio assigns a fixed low Beta at admit (§6). Anti-inflation: a dream can never declare itself trustworthy.

---

## 5. Select stage (collapse-safety)

Bio builds the collapse-safe, bounded input set before any model sees anything:

1. **Gather the episode's claims** — claims whose `provenance.runId ∈ episode.runIds`, fetched via a **runId query filter** on the gateway/adapter (the substrate prerequisite, §11/§12). Not an in-memory scan: an in-memory filter would be O(corpus) per pass, and dreaming runs over an accumulating corpus, so it must be an indexed query. This is the episode's **produced** claims (those *written* under the episode's run), **not** the `surfaced`/read set the SignalBuffer tracks — Dreaming reflects on what was *learned/recorded* in the session, not what was merely read. **Integration contract:** the consumer MUST tag the claims it writes during a session with the same `runId` it passed to `openEpisode`/`attachRun`; otherwise an episode has no produced claims and `dream(episode)` is a no-op for it.
2. **Collapse filter (primary guard).** Drop any **unvalidated dream**: `provenance.workflow === "dream"` AND `status === "candidate"`. Grounded claims and *validated* claims (incl. validated dreams) pass. A dream must be confirmed before it can reseed dreaming — this breaks the synthetic feedback loop.
3. **Depth cap (backstop).** Exclude any claim whose dream-depth ≥ `MAX_DREAM_DEPTH`. Depth is stored explicitly on each dream at admit (§6), so this is a cheap field read, not a recursive `derivedFrom` walk. Non-dream claims are depth 0. Since insight depth = max(cited input depth) + 1, excluding over-depth inputs bounds every new insight at ≤ `MAX_DREAM_DEPTH`.
4. **Token bound.** Cap to `maxInputClaims` (tunable), keeping top-N by recency-then-confidence, so the consumer's model context can't be blown.

Everything safety-relevant — eligibility, depth, size — is decided here in bio, before the model, and cannot be overridden downstream.

---

## 6. Admit stage

For each validated `ProposedInsight`:

1. **Compute depth** = `max(depth of cited claims) + 1`.
2. **Build the `CandidateClaim`:**
   - `key`/`value`/`scope` from the insight (subject derived from the key).
   - `confidence`: bio-assigned **`DREAM_PRIOR`** — a fixed **low** Beta (default `Beta(1,3)`, mean 0.25, tunable). A fresh dream must read *clearly* subordinate (not 50/50); with `source: "llm"`'s low source-weight + decay + `status: "candidate"` it stays well below grounded claims until evidence validates it.
   - `status: "candidate"`, `source: "llm"`, `provenance.workflow: "dream"`.
   - `provenance.derivedFrom`: `{ queryExpression: "dream", inputClaims: insight.cites, evaluationClock: now, combinationRule: "dream@<modelVersion>" }`.
   - `evidence`: cited inputs as `{ kind: "claim" }` refs (forms the evidence DAG for `γ`), plus `rationale` as an evidence entry if present.
   - `tags`: includes a depth marker `dream-depth:N` (the explicit depth §5 reads).
3. **Validate** the built claim — run `validateScope` against the corpus `ClaimSchema` and confirm the key is well-formed (`subjectOf`). Drop any insight that fails → `dropped: {reason}`. This compensates in-layer for the gateway not routing through the substrate's `Promoter` (which would otherwise enforce it — see the §1 write-path note).
4. **Emit `derive` AppendOps**, apply via `gateway.apply` with `opKey = "<episode>:<dreamPass>:<i>"` (idempotency carries over). Return `DreamReport`.

*Acyclicity note:* a dreamed claim cites only older input claims, so the evidence DAG cannot cycle by construction; the write path does not currently call `wouldCreateCycle` (unenforced in both the gateway and `Promoter` paths today) — acceptable for dreams, and folded into the write-path reconciliation (§13).

Two decisions driven by **not changing core types**:
- **Model version → `derivedFrom.combinationRule` (`dream@<modelVersion>`) + a tag**, not a new provenance field. `DerivationProvenance` (`src/core/provenance.ts`) has no LLM-model slot and is not reopened. This gives **auditability** (which model dreamed it) but not bit-reproducible replay. `modelVersion` is supplied by the consumer via `dream(episode, { modelVersion })`.
- **Depth → a tag (`dream-depth:N`)**, not a new `Claim` field — same reason, and it makes the §5 depth check a cheap read.

---

## 7. Error handling

The dream pass is async and calls an external model, so it has more failure surface. Guiding principle (as wave 1): **fail safe toward the substrate** — on any uncertainty, write nothing.

| Failure | Handling |
|---|---|
| `DreamFn` throws / times out | Catch → `DreamReport` with `errors`, apply nothing. A failed dream never corrupts the corpus. |
| Malformed / empty insights | Validate each (valid kebab key, value present, `cites` non-empty ⊆ selected set). Drop invalid → `dropped`; admit the valid rest. All-bad batch → `admitted: 0`, no throw. |
| Empty eligible set | Skip the model call entirely; return `{ proposed: 0, admitted: 0 }`. Never call `DreamFn` with nothing. |
| `gateway.apply` fails | Atomic batch (wave-1 carryover): nothing applied, error in report. |
| Concurrent `dream(episode)` | **Single-flight per episode**: a second pass returns immediately with an error and applies nothing. |
| Insight over depth cap | Cannot occur (inputs pre-filtered by depth in Select); re-checked at admit as belt-and-suspenders and dropped if seen. |

---

## 8. Determinism

Dreaming is generative, so a dreamed claim's replay status is inherently **degraded** — bio captures model version + `inputClaims` + `evaluationClock` (auditable: *why / what / which model*) but the generative step is not bit-reproducible. This aligns deliberately with the substrate's derived-writes replay stratification (the `exact` replay-re-execution engine is the deferred v1.x slice per the v1 roadmap). Dreams claim no guarantee the substrate doesn't make.

---

## 9. Testing strategy

Most of the suite is pure/fake — no real model.

1. **Select stage:** fixture claim set → assert unvalidated dreams excluded, over-depth excluded, runId membership, top-N bound. *The collapse filter is the highest-value unit test.*
2. **Admit stage:** `ProposedInsight[]` → assert the `derive` ops: `candidate` / `source:"llm"` / `workflow:"dream"`, `DREAM_PRIOR`, depth = max(cites)+1, depth tag, `derivedFrom.inputClaims`, model version in `combinationRule`, evidence claim-refs; insight citing an unknown id is dropped.
3. **Fake `DreamFn`s:** happy path; one that throws (fail-safe); one returning malformed (dropped).
4. **End-to-end (in-memory SQLite gateway):** seed an episode with grounded + validated-dream + unvalidated-dream claims; run `dream(episode)` with a fake `DreamFn`; assert only eligible claims were fed in, insights admitted correctly, idempotent re-run applies nothing.
5. **Collapse property test (wave-2 centerpiece):** over repeated passes feeding outputs back, assert **depth never exceeds `MAX_DREAM_DEPTH`** AND **unvalidated dreams never appear as inputs** — the feedback loop is provably bounded. The wave-2 analogue of wave-1's append-only invariant test.

Tests follow the Mneme convention (colocated `*.test.ts`, vitest globals).

---

## 10. Components and isolation

| Unit | Responsibility | Depends on |
|---|---|---|
| `DreamFn` / `ProposedInsight` / `DreamInput` / `DreamReport` (types) | The consumer-implemented port + structured I/O | core types |
| Select | Build the collapse-safe, bounded input set | gateway (read, runId filter), depth tag, episode |
| Admit | Materialize insights into marked `derive` ops | gateway (apply), core claim/provenance, `DREAM_PRIOR` |
| `dream(episode, opts)` pass | Orchestrate select → dreamFn → admit; fail-safe; single-flight | the above + injected `dreamFn` |

The model is held at arm's length behind one injected async function; bio owns selection, the collapse filter, admission, and provenance.

---

## 11. Wiring and module structure

- **New:** `src/bio/processes/dreaming.ts` (+ `dreaming.test.ts`) — types + the dream pass.
- **Additive edits:**
  - `src/bio/bio-memory.ts` — inject `dreamFn` at construction (`createBioMemory({ dreamFn })`); add `async dream(episode, { modelVersion })`.
  - `src/bio/runner.ts` — optional thin `startDreaming({ intervalMs })` for sleep-time scheduling.
  - `src/index.ts` — export `DreamFn`, `ProposedInsight`, `DreamInput`, `DreamReport`, and the `dream` surface.
- **Substrate prerequisite:** `src/adapters/adapter.ts` (`ExecutionPlan` gains an optional `runId`/`runIds` filter) + `src/adapters/sqlite.ts` (corresponding `WHERE` clause). Small, isolated, sequenced before the dreaming Select stage.

---

## 12. Dependencies and sequencing

- **Substrate prerequisite (build first):** runId query filter on `ExecutionPlan` + SQLite adapter. The Select stage depends on it.
- **Already in place:** the wave-1 gateway (`derive` op, idempotency, append-only), episode model, derived-writes + provenance, `⊕`/`⊥`.
- **Consumer responsibility:** supply a `DreamFn` and a `modelVersion`. Without a configured `dreamFn`, `dream()` is a no-op/error (bio has no default model).

---

## 13. Out of scope (deferred)

- **Consolidation** (promote + `⊕` synthesize; compression/summaries). Separate wave-2 sibling, brainstormed/built next.
- **Pluggable admission gate (Approach C):** a hook between dream and admit for dedup-against-existing-insights or custom confidence policy. Default admission (mark + provenance) is enough for v1; revisit when dreams need de-duplication.
- **Exact replay of dreamed claims:** requires the serializable query-AST + interpreter (the v1.x replay-re-execution engine per the v1 roadmap). Dreams remain degraded-replay until then.
- **A dedicated LLM-model-version field on `DerivationProvenance`:** currently stashed in `combinationRule`; a clean core field is a later substrate refinement.
- **Dream→Consolidation interplay** (e.g., consolidating dreamed insights): out until Consolidation exists.
- **Bio↔substrate write-path reconciliation (tracked architectural debt):** the bio gateway writes via `adapter.insertClaim` directly, bypassing the substrate's `Promoter`/`commitDerived` pipeline (scope-schema validation, write-time contradiction policy, monotonic seq, provenance finalization). Dreaming compensates in-layer (scope validation in Admit §6; read-time `⊥` for conflicts), but the two write paths should be unified — routing the whole bio layer through `Promoter` is the right end state and also subsumes wave-1's deferred hardening (per-instance `recordedSeq`, supersede/promote atomicity, evidence acyclicity enforcement). **Decision: brainstorm this reconciliation AFTER Dreaming is implemented** (deliberately not smuggled into the Dreaming spec, since it touches the wave-1 gateway).
