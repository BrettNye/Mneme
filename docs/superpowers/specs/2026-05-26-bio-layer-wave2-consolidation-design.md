# Design: Bio Layer Wave 2 — Consolidation (model-free core)

**Date:** 2026-05-26
**Status:** Approved design (brainstorm complete). Next step: DAG implementation plan via `writing-dag-plans`.
**Type:** New capability in the bio layer (`src/bio/`), plus a layer-wide tuning-config formalization (`BioPolicy`). No substrate changes required (the runId query filter Dreaming added is reused).

---

## 1. Context and relationship

This is the second **wave 2** mechanism of the bio cognitive layer (`docs/superpowers/specs/2026-05-26-bio-layer-design.md`), the deferred sibling of **Dreaming** (`...-wave2-dreaming-design.md`). Where Dreaming *generates new knowledge* (insights/hypotheses), **Consolidation re-packs and stabilizes existing claims** — the two halves the original design split (Dreaming §2: "a compact restatement of the same facts… is Consolidation's job").

The substrate it needs is in place and clean. Critically, the **bio↔substrate write-path reconciliation is already done**: the gateway is fully Mneme-backed (`createMnemeGateway(mneme, corpusId)` routes `AppendOp`→`Mneme.commit/supersede/promote`), so this slice inherits scope-schema validation, write-time contradiction policy, provenance finalization, the write-event log, and DB-derived monotonic seq **for free**. The architectural debt Dreaming had to compensate for in-layer is paid.

### 1.1 The loop Consolidation closes

Consolidation is the gate that lets synthetic knowledge graduate:

> Dreaming writes a `candidate` insight → the agent surfaces and uses it → outcomes accumulate Beta evidence (wave-1 keystone, outcome-reweighting) → **Consolidation promotes it to `validated`** → the next dream pass's collapse filter — which reseeds **only** on *validated* dreams (Dreaming §5.2) — can now build on it.

Without Consolidation, dreamed candidates never become eligible to reseed dreaming, and the wave-2 loop is open. Consolidation is also where redundant corroborating claims collapse into one, keeping the corpus's *default read view* from accreting clutter (while the full record stays append-only and queryable).

---

## 2. Scope

**This slice is the model-free core of Consolidation: two pure, deterministic behaviors over an episode's produced claims.**

- **Promotion** — advance a claim's lifecycle (`candidate → provisional → validated`) when its Beta confidence **lower bound** clears per-tier thresholds. Forward-only; the substrate enforces lifecycle direction.
- **Corroboration folding** — fold a group of ≥ K *agreeing* claims (same `subject / key / scopeHash / valueHash`) into one consolidated claim via ⊕, and deprecate the folded inputs. Reduces redundancy in the default read view.

**In scope:** the synchronous `consolidate(episode)` pass (select → plan → apply), the `derive`+`promote` op expression, the `"consolidate"` provenance marker, fail-safe + single-flight handling, optional runner scheduling, and a monotonicity (anti-runaway) property test.

**Also in scope — the unified `BioPolicy` (§4).** This slice formalizes bio-layer tuning into one config object so policy can be swept empirically with no code changes. Consolidation's knobs are one sub-policy of it; the same change **exposes currently-hardcoded knobs in two existing mechanisms**: the wave-1 keystone evidence weights (`usageWeight`, `outcomeWeight`, `scalarPseudocount`) and dreaming's `prior`/`maxDepth`. This is a **purely additive, behavior-preserving** refactor — every default equals today's constant, so existing wave-1 and dreaming tests stay green.

**Out of scope:** see §11. Everything deferred is captured there authoritatively and mirrored into the `mneme-bio-layer-scope` memory.

---

## 3. Architecture — a separate synchronous pass

A `consolidate(episode)` entry point on the `BioMemory` facade, structurally mirroring Dreaming but **synchronous** — there is no model and no async model call. New module `src/bio/processes/consolidation.ts`; an optional trigger on the runner.

```
consolidate(episode, opts?): ConsolidationReport      [src/bio/processes/consolidation.ts]
   1. SELECT   gateway.read(episode claims by runId)   — fresh, post-reinforcement state;
                                                          active claims only (exclude deprecated)
   2. PLAN     pure (claims, opts, now) → AppendOp[]:
        ├─ FOLD     group active claims by (subject, key, scopeHash, valueHash);
        │           for each group of size ≥ K:
        │             • derive(consolidated)   status = tierFor(pooledConfidence)
        │             • promote(each input → "deprecated", reason: "folded into <id>")
        └─ PROMOTE  for each NON-folded active claim whose lowerBound earns a higher tier
                    than its current status:
                      • promote(claim → tier, reason: "consolidation: lowerBound … ≥ …")
   3. APPLY    gateway.apply(ops, opKey)               — one atomic batch (the only write)
   → ConsolidationReport { promoted, folded, deprecated, dropped, errors }
```

Design properties:

- **Reuses the Mneme-backed gateway** (`read` + `apply`). Append-only, idempotency, scope validation, and contradiction policy carry over; no new write path is introduced. The synchronous wave-1 `cycle`/`evidence-update` path is untouched, as is the async `dream` pass.
- **Reads fresh state.** Because it is a separate pass (not a same-batch cycle stage), it reads the latest committed claim versions, so promotion reflects the **post-reinforcement** confidence and there is no conflict with evidence-update superseding a claim in the same atomic batch. (This is why §8.2 of the base design drew consolidation as a cycle stage, but it ships as a separate pass — the same pressure that moved Dreaming out of the synchronous cycle.)
- **Fold xor promote.** Grouping decides each claim's fate: a claim in a fold-eligible group (size ≥ K) is folded; any other active claim is a promotion candidate. One claim is never both folded and promoted in a pass, so the two emitters cannot collide on a single id.
- **Marker without a core change.** Consolidated claims are marked `provenance.workflow = "consolidate"` (a bio-owned constant, exactly the trick Dreaming used for `"dream"`). The `Source` enum and `DerivationProvenance` are **not** reopened.

---

## 4. The unified `BioPolicy` (configurable; defaults are tuning starting points)

All bio tuning is data, not code, gathered into **one** config object so an empirical sweep varies a single thing. Every field is optional; every default equals the value the layer hardcodes today, so introducing `BioPolicy` changes **no** behavior until a knob is overridden.

```ts
interface BioPolicy {
  evidence?: {              // wave-1 keystone (currently hardcoded in evidence-update.ts)
    usageWeight?: number;       // α added per usage signal               — default 0.5
    outcomeWeight?: number;     // α/β added per outcome (the learning rate) — default 2.0
    scalarPseudocount?: number; // scalar→Beta promotion strength          — default 2
  };
  dreaming?: {              // wave-2 dreaming (prior/depth currently hardcoded in dreaming-types.ts)
    prior?: { alpha: number; beta: number }; // fresh-dream confidence    — default { alpha: 1, beta: 3 }
    maxDepth?: number;          // dream→dream recursion cap               — default 3
    maxInputClaims?: number;    // select token bound (already configurable) — default 200
  };
  consolidation?: {         // this slice
    promoteThresholds?: { provisional?: number; validated?: number }; // lower-bound gates — default 0.50 / 0.65
    lowerBoundK?: number;       // σ below the mean for the lower bound (mean − k·σ) — default 1.645 (≈ one-sided 95%)
    foldRule?: string;          // ⊕ ruleId for corroboration folding      — default RULE.WEIGHTED_AVG (see §6)
    foldThreshold?: number;     // K — minimum group size to fold          — default 3 (clamped ≥ 2)
  };
}

// exported as DEFAULT_BIO_POLICY (the empirical starting points); each mechanism
// also re-exports its own resolved defaults so the constants stay greppable.
```

`BioPolicy` is supplied once at `createBioMemory({ …, policy?: BioPolicy })` and threaded to each mechanism: `evidence` → `evidenceUpdate(policy.evidence)` inside the cycle, `dreaming` → the dream pass/select, `consolidation` → the consolidate pass. `consolidate(episode, opts?)` additionally accepts a per-call `consolidation` override (per-call beats construction), useful for sweeping promotion/fold knobs without rebuilding the facade.

**Scope of the policy — write/process knobs only.** `BioPolicy` covers the three *process* families above. **Read-time** knobs stay caller-supplied per retrieval, by deliberate design: suppression `floor` and the `decay` policy live on `RetrievalContext` because different queries legitimately want different lenses (they are not one global setting). The signal-buffer `cap` stays a `createSignalBuffer` argument (an operational limit, not a learning parameter). §11 notes these as intentionally out of `BioPolicy`.

**`consolidation.foldThreshold` is clamped to ≥ 2.** K = 1 would be non-terminating: folding a single claim emits `derive` (one new claim with the *same* `subject/key/scopeHash/valueHash`) + `promote(→deprecated)`, a net change of zero that re-triggers next pass forever. The effective K is `max(2, foldThreshold)`; this guarantees the monotonicity bound in §7.

---

## 5. Promotion policy

Throughout §5–§6, the knobs (`lowerBoundK`, `promoteThresholds`, `foldRule`, `foldThreshold`) are read from the **resolved consolidation policy** — `policy.consolidation` from construction, merged with any per-call `consolidate(episode, opts)` override.

For each non-folded active claim:

1. **Compute the lower bound.** `lowerBound = max(0, mean − k·σ)`, where `mean` and `σ = √variance` come from the Beta binding (`src/distribution/beta.ts` exposes both; no quantile exists), and `k = opts.lowerBoundK`. This is a normal approximation — cheap and dependency-free. An exact Beta-quantile lower bound is a deferred refinement (§11), not built here.
   - *Why the lower bound, not the mean:* it requires **both** high belief **and** sufficient evidence. A claim with `mean ≈ 1.0` but a single observation has a wide distribution and a low lower bound, so it cannot graduate on thin evidence. (Decided in brainstorming; switching to the mean would reintroduce thin-evidence inflation.)
2. **Map to a tier.** `tierFor(lowerBound)` = the highest lifecycle tier whose threshold the lower bound clears: `validated` if `≥ promoteThresholds.validated`, else `provisional` if `≥ promoteThresholds.provisional`, else the claim's current status (no promotion).
3. **Emit forward-only.** Emit a `promote(claim.id → tier, reason)` op **only** when `tierFor` ranks strictly above the claim's current status (`LIFECYCLE_ORDER` from `src/write/pipeline.ts`). `reason` records the numbers, e.g. `"consolidation: lowerBound 0.71 ≥ validated@0.65"` → audit trail. Already-deprecated claims are never selected.

Promotion never changes a claim's `value`/`confidence`/`evidence` — only its `status`, in place, via the substrate's forward-only `promote`.

---

## 6. Fold policy (corroboration only)

Folding consolidates **agreeing** claims. Contradiction-resolution synthesis (`resolveSynthesizeBelief`, which needs ⊥) is *not* in scope — that is the deferred "contradiction triage" (§11).

1. **Group** active claims by the full identity-and-value key `(subject, key, scopeHash, valueHash)`. Only same-value groups fold — these are genuinely redundant restatements of one fact.
2. **Threshold.** Fold any group of size ≥ `opts.foldThreshold` (K). Smaller groups fall through to promotion as individual claims.
3. **Build the consolidated claim** via `oplusSynthesizeAs(subject, key, opts.foldRule)` over the group:
   - `confidence`: the ⊕ fold under `foldRule`. **Default `weighted_avg`** (see rationale below); `evidence_pooled` is a documented opt-in.
   - `status`: set **inline** to `tierFor(lowerBound(foldedConfidence))` — the consolidated claim enters at the tier its own pooled confidence earns (it is brand-new this pass, so its lifecycle can't be set by a separate `promote` op on an uncommitted id).
   - `source: "workflow"`, `provenance.workflow: "consolidate"`.
   - `provenance.derivedFrom`: `{ queryExpression: "consolidate", inputClaims: <folded ids>, combinationRule: opts.foldRule, evaluationClock: now, … }`.
   - `evidence`: union of the folded inputs' evidence (forms the evidence DAG for `γ`).
4. **Emit ops:** one `derive(consolidated)` **plus** one `promote(input → "deprecated", reason: "folded into <consolidatedKey>")` per folded input. Folded inputs remain physically present and queryable (append-only invariant honored); they simply leave the default read view and stop pooling.

**Why `weighted_avg` is the default (a deliberate, conservative choice):**

- `evidence_pooled` **sums** Beta pseudocounts, so N agreeing claims yield a sharp, near-certain distribution. That is the correct Bayesian update **only if the inputs are independent** — which we cannot verify. Two claims both derived from the same underlying observation would be double-counted and inflate certainty. This is precisely the already-tracked **§5.6 observation-level-dedup-before-pooling** gap, so pooling is *provably unsafe today*.
- The wave-1 **keystone already accumulates corroboration** (usage/outcomes bump α via supersede). Pooling on fold would count the same support twice.
- Consolidation's job is *re-packing*, not gaining evidence. `weighted_avg` collapses redundancy without inflating — averaging N copies of a value yields the value — and is immune to the double-counting gap.

`evidence_pooled` remains available via `foldRule` and is the right default **once** observation-level dedup lands (§11).

*Acyclicity:* a consolidated claim cites only older input claims, so the evidence DAG cannot cycle by construction (same argument as Dreaming §6).

---

## 7. Termination & safety (anti-runaway)

Folding is **monotone in active-claim count**: each fold deprecates K inputs and adds 1 consolidated claim, a strict net decrease of K−1 ≥ 1 (since K ≥ 2). Deprecated claims are excluded from Select, so the *same* claims can never fold twice; a new fold on the same `(subject, key, scope, value)` requires *new* agreeing claims to arrive. There is therefore no synthetic feedback loop — unlike Dreaming, which needed an explicit depth cap; Consolidation's bound is structural.

This gets the **wave-2 centerpiece property test** (the analogue of Dreaming's collapse test and wave-1's append-only invariant test):

> Over repeated `consolidate` passes on a fixed corpus (no new claims between passes), the active-claim count is **non-increasing**, no claim is folded twice, and the run reaches a fixed point (a pass that emits no fold ops). Promotion is idempotent: a second pass over the same state emits no new promote ops.

---

## 8. Error handling (fail-safe toward the substrate — as wave 1 / Dreaming)

Guiding principle unchanged: on any uncertainty, **write nothing**. Append-only + idempotent ops make retry safe.

| Failure | Handling |
|---|---|
| `gateway.read` fails | Return `ConsolidationReport` with `errors`; apply nothing. |
| `gateway.apply` fails | Atomic batch (carryover): nothing applied, error in report, no partial consolidation. |
| Concurrent `consolidate(episode)` | **Single-flight per episode** (mirrors Dreaming): a second concurrent pass returns immediately with an error and applies nothing. |
| Empty / no eligible groups or promotions | `{ promoted: 0, folded: 0, … }`, no-op; never an error. |
| Invalid op (e.g. promote a claim concurrently deprecated, or a non-forward transition) | Gateway/substrate rejects → surfaced in `report.dropped`/`errors`; batch atomicity protects the rest. |
| Unknown episode | `{ … errors: ["unknown episode"] }`, consistent with `runCycle`/`dream`. |

`ConsolidationReport`:

```ts
interface ConsolidationReport {
  promoted: number;                                  // claims advanced in lifecycle
  folded: number;                                    // consolidated claims created
  deprecated: number;                                // inputs deprecated by folding
  dropped: { key?: string; reason: string }[];       // ops the substrate rejected
  errors: string[];
}
```

---

## 9. Determinism

Consolidation is fully **deterministic** (model-free) — a strictly better replay posture than Dreaming. The fold is a pure ⊕ over recorded inputs and the promotion decision a pure function of recorded confidence + pinned `evaluationClock`. As with all derived writes, `exact` re-execution still awaits the deferred replay-re-execution engine (the v1.x slice in the v1 roadmap), but nothing here is generative, so the recorded provenance fully explains every write.

---

## 10. Components, wiring, and testing

### 10.1 Components and isolation

| Unit | Responsibility | Depends on |
|---|---|---|
| `BioPolicy` + `resolvePolicy(p?)` | Unified tuning config + default-merge helper | core types |
| `ConsolidationReport` (type) | Structured pass output | core types |
| `lowerBound(confidence, k)` | Beta lower-bound (mean − k·σ) | `distribution/beta` (mean, variance) |
| `tierFor(lowerBound, thresholds)` | Lower-bound → lifecycle tier | `Status`, `LIFECYCLE_ORDER` |
| Select | Episode's active claims, fresh | gateway (read, runId filter), episode |
| Plan (fold + promote) | Pure `(claims, consolidationPolicy, now) → AppendOp[]` | `oplusSynthesizeAs`, `lowerBound`/`tierFor`, core claim/provenance |
| `consolidate(episode, opts?)` pass | Orchestrate select → plan → apply; fail-safe; single-flight | the above + gateway (apply) |
| evidence-update / dreaming **refactor** | Source the (now-exposed) weights & prior/depth from `BioPolicy`; defaults unchanged | `BioPolicy` |

### 10.2 Wiring

- **New:**
  - `src/bio/processes/consolidation.ts` (+ `consolidation.test.ts`) — `ConsolidationReport`, `lowerBound`/`tierFor`, the plan functions, and the pass.
  - `src/bio/policy.ts` (+ `policy.test.ts`) — the `BioPolicy` type, `DEFAULT_BIO_POLICY`, and `resolvePolicy(p?)` (deep-merge of partial policy onto defaults). The single home for every bio tuning constant.
- **Additive, behavior-preserving edits (defaults = today's constants; existing tests stay green):**
  - `src/bio/processes/evidence-update.ts` — `evidenceUpdate(evidence?: BioPolicy["evidence"])`; replace the `USAGE_WEIGHT`/`OUTCOME_WEIGHT`/`SCALAR_PSEUDOCOUNT` literals with `evidence.* ?? default`.
  - `src/bio/processes/dreaming*.ts` — source `prior`/`maxDepth` (and existing `maxInputClaims`) from `BioPolicy["dreaming"]`; `DREAM_PRIOR`/`MAX_DREAM_DEPTH` become the exported defaults.
  - `src/bio/bio-memory.ts` — accept `policy?: BioPolicy` at construction; thread `policy.evidence` into the cycle's `evidenceUpdate`, `policy.dreaming` into the dream pass, `policy.consolidation` into the consolidate pass. Add synchronous `consolidate(episode, opts?: { consolidation?: BioPolicy["consolidation"] }): ConsolidationReport`. (Replaces the prior `dream?: DreamPassOpts` field — its knobs now live under `policy.dreaming`.)
  - `src/bio/runner.ts` — optional thin `startConsolidating({ intervalMs })`, mirroring `startDreaming`.
  - `src/index.ts` — export `BioPolicy`, `DEFAULT_BIO_POLICY`, `ConsolidationReport`, and the `consolidate` surface.
- **No substrate change.** The runId query filter Dreaming added (`ExecutionPlan` + sqlite) is reused as-is.
- **Sleep-phase ordering:** when scheduling both, run **consolidate → dream**, so dreams validated by this sleep's consolidation become eligible to reseed the same sleep's dream pass.
- **Integration contract (shared with Dreaming):** the consumer MUST tag claims it writes during a session with the episode's `runId`; otherwise an episode has no produced claims and `consolidate(episode)` is a no-op for it.

### 10.3 Testing strategy

Most of the suite is pure-function testing, no model and (except the round-trip tests) no substrate.

0. **`BioPolicy` / `resolvePolicy` (behavior-preservation gate):** `resolvePolicy(undefined)` deep-equals `DEFAULT_BIO_POLICY`; a partial override merges without dropping sibling defaults; `DEFAULT_BIO_POLICY` values equal the pre-refactor constants (`0.5` / `2.0` / `2`, `Beta(1,3)`, depth `3`, `200`). Plus: `evidenceUpdate()` with default policy produces byte-identical ops to the old hardcoded version, and overriding `outcomeWeight` provably changes the α/β bump. **The existing wave-1 and dreaming suites must stay green unchanged** — that is the refactor's safety contract.
1. **`lowerBound` / `tierFor`:** thin Beta (high mean, low concentration) yields a low lower bound and does **not** promote; a concentrated Beta clears the tier; threshold and `k` are honored from opts.
2. **Promote plan:** a claim whose lower bound earns `validated` emits one forward `promote`; a claim already at-or-above its earned tier emits nothing; deprecated claims are ignored.
3. **Fold plan:** a group of K agreeing claims → one `derive` (`workflow:"consolidate"`, `foldRule` in `combinationRule`, `inputClaims` = group, status = `tierFor(folded)`) + K `promote(→deprecated)`; a group of K−1 is **not** folded; `foldRule` is configurable (assert `weighted_avg` vs `evidence_pooled` produce different folded confidence).
4. **Fold xor promote:** a fold-eligible group is never also individually promoted in the same pass.
5. **End-to-end (in-memory SQLite gateway):** seed an episode with promotable + foldable + ineligible claims; run `consolidate`; assert ops applied, report counts, deprecated inputs leave the default read view but remain in raw reads (append-only), and an **idempotent re-run applies nothing**.
6. **Monotonicity property test (centerpiece, §7):** repeated passes on a fixed corpus → active count non-increasing, no double-fold, reaches a fixed point.

Tests follow the Mneme convention (colocated `*.test.ts`, vitest globals).

---

## 11. Out of scope (deferred — captured to revisit)

Authoritative deferral list; mirrored into the `mneme-bio-layer-scope` memory.

- **LLM compression / summarization** — re-packing claims into a natural-language *gist*. The remaining, model-*dependent* face of Consolidation. Will mirror Dreaming's injected-port pattern with a `SummarizeFn` (consumer owns prompt + parsing; bio owns selection, marking, and a fixed-confidence admit). Deferred to isolate the model-dependent risk, exactly as Dreaming was split from this slice.
- **Contradiction-resolution synthesis** — fusing *disagreeing* claims (same triple, different values) via `resolveSynthesizeBelief`. This is the deferred **"contradiction triage"** and pulls ⊥ detection into scope; out until that mechanism is brainstormed.
- **Bidirectional confidence demotion** — deprecating a claim whose lower bound falls below a floor (failed consolidation / accumulated disbelief). This slice is upward-only; weak/stale claims are handled by wave-1 **read-time suppression**, not a demote-write. Deprecation here arises *only* as a consequence of fold.
- **Observation-level dedup before pooling (§5.6 MUST)** — folding under `evidence_pooled` double-counts shared underlying observations. Until this lands, `weighted_avg` is the safe default and `evidence_pooled` is opt-in. When it lands, `evidence_pooled` becomes the natural default. (Same gap already tracked in the v1 roadmap.)
- **Exact Beta-quantile lower bound** — this slice uses the `mean − k·σ` normal approximation. A proper inverse-incomplete-beta quantile (more accurate for skewed Betas) is a later numeric refinement; it would slot behind the same `lowerBound` interface with no policy change.
- **Unified sleep-phase report** — a combined report across `consolidate` + `dream` (and surfacing each pass's `dropped`/`rejected`) for a single "what happened during sleep" view. Each pass reports independently for now.
- **Read-time knobs intentionally NOT in `BioPolicy`** — suppression `floor` and the `decay` policy stay on `RetrievalContext` (per-query lenses, not one global setting); the signal-buffer `cap` stays a `createSignalBuffer` argument (operational limit). If a future need arises for global read-time defaults, folding them into `BioPolicy` is a candidate then — captured here so the asymmetry is a recorded decision, not an oversight.
- **Exact replay of consolidated claims** — shares the substrate's deferred replay-re-execution engine (v1.x). Consolidation is deterministic, so this is purely the substrate-wide `exact` machinery, not consolidation-specific.

---

## 12. Dependencies and sequencing

- **Already in place:** the Mneme-backed bio gateway (`derive`/`supersede`/`promote`, idempotency, append-only, scope+contradiction enforcement); the episode model; `oplusSynthesizeAs` (⊕); the runId query filter; derived-writes + provenance; `LIFECYCLE_ORDER`/forward-only `promote`.
- **No substrate prerequisite** for this slice.
- **Consumer responsibility:** tag session writes with the episode's `runId` (shared Dreaming contract). No model needed (this slice is model-free).
- **Builds the wave-2 loop closure:** with Consolidation, dreamed candidates can graduate to `validated` and reseed Dreaming — the half of the loop that was open after Dreaming shipped.
