# Design: Bio Cognitive Layer on Mneme

**Date:** 2026-05-26
**Status:** Approved design (brainstorm complete). Next step: implementation plan via `writing-plans`.
**Type:** New library design (separate package layered on the Mneme substrate).

---

## 1. Motivation and relationship to Mneme

Mneme is a deliberately *mathematical* memory substrate: immutable typed claims, Beta/scalar confidence, bitemporal time, a query algebra, and audit-grade provenance (see `mneme-spec-v0.2-consolidated.md`, §1.2 "math-not-biology"). It stores evidence and computes views from it; it does not model memory as a living, mutating thing.

The **bio layer** is a separate library that supplies the *biological* dynamics — the behavior people expect from "agent memory" (decay, reinforcement, consolidation, dreaming, learning from outcomes) — **on top of** Mneme without compromising the substrate's immutability or auditability.

The split is the organizing principle throughout:

> **Mneme provides the verbs (decay, rank, traverse, accumulate evidence). The bio layer writes the sentences (when to decay, what to reinforce, when to consolidate, what to drop from view).** Mneme is mechanism; the bio layer is policy and orchestration.

This mirrors Mneme's own thesis (§1.2): "remembering" is input curation at call time, and "learning" is changes to curation over time. The bio layer *is* that curation-and-learning layer the substrate deliberately leaves out.

### 1.1 The hard invariant (the whole safety thesis)

The bio layer may **add new claims**, **supersede** (deprecate-old + insert-new), and **transition status** — all audited. It may **never** mutate a claim's `value` / `confidence` / `evidence` in place, and **never** physically delete a claim.

Every biological behavior is therefore expressed as *new immutable events + read-time policy*, never as in-place mutation. This is what lets one store serve both "the agent's working memory" and "the auditor's complete record." The architecture (§3) enforces this **structurally**, not by convention.

---

## 2. Scope

### 2.1 Driver

Chosen driver: **ideal cognitive layer** — design the full cognitive loop, but stage implementation by substrate-readiness.

### 2.2 v1 core (designed whole, built in two waves)

The six mechanisms form a closed loop: experience → dream/consolidate → reinforce/decay → learn from outcomes → suppress stale.

- **Wave 1 — buildable on today's substrate:** Reinforcement, Forgetting-as-suppression, Outcome-driven reweighting, the runner skeleton.
- **Wave 2 — gated on unbuilt Mneme substrate (write model + synthesis `⊕` + contradiction `⊥`):** Dreaming (generative consolidation), Consolidation/promotion.

### 2.3 The keystone

**Outcome-driven reweighting** is not a peer of the other mechanisms — it is what makes the loop actually *learn*. Without it the layer dreams and decays but never gets smarter. It is protected in v1, with one deliberate constraint (§7.3): **bounded credit assignment** — no causal inference.

### 2.4 Autonomy / packaging

**Hybrid**: a pure cognitive-operations library plus an *optional* runner/scheduler package. Every library mechanism must work with the runner package never installed.

### 2.5 Explicitly deferred (out of scope for v1)

- **Recall-shaping (v1.x):** salience weighting; associative recall (`ρ` + `γ`); working-memory assembly into `ComposedContext`; memory-type policies (re-homes rastate's `type`: episodic/semantic/procedural); audience targeting (re-homes rastate's `audience`/`taskTypes`).
- **Advanced:** source-trust calibration; contradiction triage (depends on `⊥`); compression/summarization (initially folded into Dreaming); priming/context-bias; recency/frequency effects.
- **Runner extras:** idle-detection, between-session hooks, cron, event-driven triggers.
- **Prediction:** forecast **math** → Mneme protocol extension `[P]` (deterministic projection operator, same shelf as Gaussian/Kalman fusion; capture model version in provenance for replay). Prediction **behavior** + prediction-error learning → bio layer. A prediction is structurally just a claim with a **future** valid-time (`valid.from > now`), `source = prediction`, `status = candidate`, `derivedFrom` — so it needs **no new `AppendOp`** (the `derive` op covers it). Prediction-error learning is a generalization of outcome-reweighting.

---

## 3. Architecture (Approach A: read-policies vs write-processes over an append-only gateway)

Mechanisms split by their actual nature:

- **Read-side policies** — pure query transforms (decorators over Mneme's algebra). Never write. Invoked inline by consumers at retrieval time.
- **Write-side processes** — pure functions `(read, signals, episode) → AppendOp[]`. Emit ops; do not apply them.
- **One `MnemeGateway`** — the only thing that touches Mneme. Exposes `read` and `apply(AppendOp[])`. There is no `update`/`delete` method anywhere, so the invariant (§1.1) is enforced by the type surface itself.

### 3.1 Package layout

```
@mneme/bio  (library — embeddable, no runtime)
  gateway.ts      MnemeGateway: read() + apply(AppendOp[]); NO mutate/delete exists
  episode.ts      episode/session boundary (wraps Mneme provenance.runId)
  policies/       read-side query transforms      → suppression.ts
  processes/      write-side (read,signals)→AppendOp[]  → evidence-update.ts
  signals.ts      SignalBuffer + recordUsage()/recordOutcome() entry points (no bus in v1)
  cycle.ts        composes processes into an ordered cognitive cycle
  bio-memory.ts   the facade (recall, record*, runCycle, openEpisode/closeEpisode)

@mneme/bio-runner  (optional package)
  runner.ts       one trigger + "run now"; calls cycle.run — owns no logic
```

---

## 4. The Gateway and the AppendOp contract

```ts
type AppendOp =
  | { kind: "derive";    claim: CandidateClaim }                                    // new claim (dream/consolidation/prediction); derivedFrom required if synthetic
  | { kind: "supersede"; deprecate: ClaimId; with: CandidateClaim; reason: string } // reinforcement / revision: new version replaces old
  | { kind: "promote";   target: ClaimId; to: Status; reason: string };             // lifecycle transition only, no value change

interface MnemeGateway {
  read(query: BioQuery): Claim[];          // thin pass-through to Mneme's query algebra/adapter
  apply(ops: AppendOp[]): AppendResult;    // the ONLY write path
}
```

There is deliberately **no** `update(claim)` or `delete(id)`. A mechanism cannot mutate a claim because the type system gives it no way to express that.

`BioQuery` is **Mneme's existing query specification** (the adapter `ExecutionPlan` / algebra expression), not a new query language — the gateway is a thin pass-through, so the bio layer never reimplements retrieval.

### 4.1 Mechanism → op mapping

| Mechanism | AppendOp |
|---|---|
| Reinforcement | `supersede` — new version with more evidence (α↑), old → deprecated |
| Outcome-reweighting | `supersede` — new version with adjusted evidence |
| Forgetting-as-suppression | *(none — pure read-policy)* |
| Consolidation (wave 2) | `promote` |
| Dreaming (wave 2) | `derive` |
| Prediction (deferred) | `derive` (future valid-time claim) |

### 4.2 Reinforcement is batched supersession, not in-place evidence bumps

Strengthening = a *new claim version* (supersede), preserving full history and staying on today's id-keyed substrate. Superseding on every recall would explode storage with one row per use, so **usage signals buffer and the cycle batches them into one supersession per claim per cycle** (also matching the biology: consolidation happens during the cycle, not continuously). Inline `recordOutcome` may still apply immediately when a result lands.

---

## 5. Episode model

Defined now because Dreaming and Consolidation (wave 2) require knowing "what was the last session."

```ts
interface Episode {
  id: EpisodeId;
  runIds: string[];     // the Mneme provenance.runId(s) belonging to this episode
  startedAt: Instant;
  endedAt?: Instant;
}
```

v1 keeps it minimal: an episode ≈ a session, boundaries declared by the consumer (`openEpisode` / `closeEpisode`) or inferred from `runId`. Processes scope their reads to an episode.

---

## 6. Read-side policies

```ts
interface RetrievalPolicy {
  name: string;
  apply(claims: Claim[], ctx: RetrievalContext): Claim[];   // pure: filter / re-rank only — no gateway access
}
interface RetrievalContext {
  now: Instant;
  decay: DecayPolicy;        // Mneme's δ — applied here to get effective confidence
  episode?: Episode;
  persona?: string;          // for later salience/audience policies
}
```

A policy receives **no gateway**, so by type it cannot write.

### 6.1 Forgetting-as-suppression

```ts
function suppression(opts: { floor: number }): RetrievalPolicy {
  return {
    name: "suppression",
    apply: (claims, ctx) =>
      claims.filter(c => effectiveConfidence(c, ctx.decay, ctx.now) >= opts.floor),
  };
}
```

`effectiveConfidence` is Mneme's δ evaluated at `ctx.now`; the bio layer calls the verb, it does not reimplement decay. A suppressed claim **remains in Mneme**, fully queryable.

### 6.2 Composition and the raw-read bypass

Policies chain as transforms applied in order after the read. **Suppression is a lens, not a wall:**

- `recall(query, policies)` → cognitively-filtered view (default agent path)
- `gateway.read(query)` → unfiltered substrate truth (audit / replay path)

This is what lets the same store serve both the agent's working memory and the auditor's complete record.

---

## 7. Write-side processes

```ts
interface CognitiveProcess {
  name: string;
  run(input: ProcessInput): AppendOp[];     // pure; no apply()
}
interface ProcessInput {
  read: (q: BioQuery) => Claim[];           // read-only handle — deliberately not the full gateway
  episode: Episode;
  signals: SignalBuffer;
  now: Instant;
}
```

A process is handed a read-only handle, not the gateway, so it **emits** ops but cannot apply them. This keeps exactly **one write path** (the cycle calls `gateway.apply` once).

### 7.1 One mechanism, two signals

Reinforcement and outcome-reweighting are the same `supersede`-emitting **evidence-update** process, distinguished only by signal source and weight:

```ts
type Signal =
  | { kind: "usage";   claimIds: ClaimId[]; episode: EpisodeId }                      // weak: surfaced & not contradicted
  | { kind: "outcome"; episode: EpisodeId; result: "success" | "failure"; weight?: number }; // strong, directed
```

Process behavior:
1. read buffered signals for the episode;
2. **usage** → small positive evidence increment on cited claims;
3. **outcome** → larger adjustment on the bounded credit set (§7.3);
4. emit **one `supersede` per affected claim** — batched, never per signal.

### 7.2 Direction of adjustment stays append-only

- success / usage → add **positive** evidence (α↑) → belief rises, uncertainty narrows
- failure → add **disbelief** evidence (β↑) → belief drops

A claim that led to failure loses trust by **gaining counter-evidence**, never by deletion. Outcome-reweighting is thus just Beta evidence accumulation (Mneme's math) with the bio layer choosing the signal→evidence mapping.

### 7.3 Bounded credit assignment (the keystone guardrail)

On an outcome we do **no causal inference**. We attribute to the claims actually **surfaced in that episode**. `recall()` records which claim IDs it surfaced per episode into the `SignalBuffer`; credit = "claims surfaced in episode E, which ended in outcome O." Simple, defensible, replayable.

*v1 simplification:* the surfaced-set lives in the in-memory `SignalBuffer`, flushed per cycle. Persisting it for full cross-session replay is a later refinement.

### 7.4 Learning is auditable

Every `supersede` carries `derivedFrom` provenance naming the process, the signal, and the episode — so "this claim's confidence rose because episode E succeeded" is a traceable record, not a silent mutation.

---

## 8. Signals and the cognitive cycle

### 8.1 Facade

```ts
interface BioMemory {
  openEpisode(): Episode;
  closeEpisode(id: EpisodeId): void;
  recall(q: BioQuery, policies: RetrievalPolicy[], episode?: EpisodeId): Claim[]; // filtered view + records surfaced set
  recordUsage(claimIds: ClaimId[], episode: EpisodeId): void;                     // buffers only (high-frequency)
  recordOutcome(episode: EpisodeId, result: "success"|"failure", weight?: number): void; // buffers + inline cycle
  runCycle(episode?: Episode): CycleReport;                                       // explicit "run now"
}
```

Two cadences: `recordUsage` only buffers (high-frequency, batched); `recordOutcome` buffers **and** fires an inline scoped cycle (outcomes are rare, important, worth immediate trust updates). "Inline" is just `runCycle` scoped to the episode — not a second write path.

### 8.2 The cycle

```ts
interface Cycle {
  processes: CognitiveProcess[];                          // ordered
  run(episode: Episode, buffer: SignalBuffer): CycleReport;
}
```
1. run each process → collect `AppendOp[]` (ordered by process);
2. `gateway.apply(allOps)` — **one atomic batch** (the only write);
3. flush consumed signals;
4. return `CycleReport` (ops applied, claims superseded, errors).

Canonical write-cycle order (wave-1 → wave-2 staging): **evidence-update (reinforce + reweight) → consolidation (promote) → dreaming (derive)**. Suppression is absent here on purpose — it is read-time, never a write stage. v1 has one process (`evidence-update`), so ordering is currently trivial.

---

## 9. The runner

```ts
interface Runner {
  start(opts: { intervalMs?: number }): void;  // optional periodic trigger
  stop(): void;
  runNow(episode?: Episode): CycleReport;       // explicit
}
```

The runner only *calls* `cycle.run` on a clock and **owns no logic**. `BioMemory.runCycle()` is fully usable with the runner package never installed — the hybrid promise. No daemon, idle-detection, cron syntax, or event bus in v1.

---

## 10. Error handling

**Guiding principle: fail safe toward the substrate.** On any uncertainty, write nothing — better to under-reinforce than to corrupt the record. Because every op is append-only and idempotent, retrying is safe.

| Failure | Handling |
|---|---|
| Mneme read fails | `recall` propagates (never fabricate). In a runner cycle: skip, log, retry next trigger — don't crash the runner. |
| `gateway.apply` partial | Batch is **atomic** (Mneme `insertBatch`). On failure: no ops applied, signals **not** flushed (retried), error in `CycleReport`. |
| Retry double-applies | Each op has a deterministic key (`episode + claim + cycleId + signalHash`); `apply` dedupes via Mneme's idempotency records. Re-run applies nothing new. |
| Concurrent cycles | **Single-flight**: one cycle at a time, others queue. Prevents racing supersessions on the same claim. |
| A process throws | **Fail the whole cycle** (atomic; nothing applied, signals retained). No partial cognition. |
| Invalid op (e.g., supersede an already-deprecated claim) | Gateway validates ops before apply; invalid → cycle fails clearly, nothing applied. |
| Signal buffer unbounded | Buffer has a cap + warning; consumer owns cycling cadence. |

---

## 11. Testing strategy

Most of the suite is pure-function testing with no substrate:

1. **Read-policies** — pure `(Claim[], ctx) → Claim[]`. Suppression drops below floor; raw-read bypasses; composition order.
2. **Write-processes** — pure `(stub read, seeded signals) → AppendOp[]`. usage→small α; outcome success→larger α; failure→β; credit set = only surfaced claims; batching = one op per claim.
3. **Gateway enforcement** — type surface has no mutate/delete (compile-time); runtime round-trip of `derive`/`supersede`/`promote` via the real SQLite adapter.
4. **Cycle (integration)** — seed signals → run against in-memory SQLite → assert supersessions, report, signals flushed, and **idempotent re-run** applies nothing.
5. **Runner** — calls cycle on interval; `runNow` works; single-flight holds.
6. **Invariant property test (centerpiece)** — over *random* operation sequences, assert **no claim is ever physically deleted and no `value`/`confidence`/`evidence` is mutated in place** — only new versions + status transitions. This tests the project's core safety thesis directly.

Tests follow the Mneme repo convention (colocated `*.test.ts`, `it` / `expect`).

---

## 12. Dependencies and sequencing

- **Wave 1** (Reinforcement, Forgetting-as-suppression, Outcome-reweighting, runner skeleton) builds on today's Mneme substrate: the id-keyed claim model, soft-delete/supersession, distribution confidence, `recordedAtMost` filtering, and idempotency records already present in `src/adapters/sqlite.ts` and `src/core/`.
- **Wave 2** (Dreaming, Consolidation) is **gated** on Mneme substrate not yet built: the write model (§7 of the spec), synthesis (`⊕`), and contradiction (`⊥`). Do not start wave 2 until those land.
- The **episode model** (§5) is a prerequisite for wave 2 and should exist before then; it is cheap and mostly derivable from `provenance.runId`.

---

## 13. Out of scope

Everything in §2.5 (recall-shaping, advanced mechanisms, runner extras, prediction). The deferred list is authoritative; nothing here should be silently re-scoped into v1 without an explicit decision.
