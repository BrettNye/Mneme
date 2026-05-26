# Design: Route the Bio Gateway Through Mneme's Write API

**Date:** 2026-05-26
**Status:** Approved design (brainstorm complete). Next step: DAG implementation plan via `writing-dag-plans`.
**Type:** Bio-layer change (`src/bio/*`) + a thin `src/mneme.ts` read addition.

---

## 1. Context

This is the **bio half** of the bio↔substrate write-path reconciliation. The substrate half (spec `2026-05-26-substrate-write-api-extension-design.md`) shipped a unified, atomic, event-logged write API — `Mneme.commit/supersede/promote` backed by `Promoter`'s shared `write` core. But the bio gateway still writes **direct to the adapter** (`adapter.insertClaim`/`deleteClaim`), bypassing that pipeline (scope-schema validation, contradiction policy, provenance finalization, the write-event log, DB-derived monotonic seq).

This spec routes the bio gateway's writes **through `Mneme`** and retires the direct-adapter write path — so every bio write (reinforcement, dreams, consolidation) goes through the validated, audited substrate pipeline.

**Approach A (chosen):** swap the gateway's *implementation* from adapter-backed to Mneme-backed while **preserving the `MnemeGateway` interface** (`read`/`readByIds`/`apply`). Because the interface is the seam, everything above it — `cycle`, the dream pass, `evidence-update`, `signals`, `episode`, the facade's logic — is **unchanged**.

---

## 2. Scope

**In scope:** rewrite `createMnemeGateway` to be Mneme-backed (`createMnemeGateway(mneme, corpusId)`); add thin `Mneme.read`/`readByIds`; map the `AppendOp` union onto `Mneme.commit/supersede/promote`; shift `createBioMemory` construction to `{ mneme, corpusId, dreamFn?, dream? }`; add a `rejected` channel to `AppendResult`.

**Out of scope / deferred:** surfacing `AppendResult.rejected` upward into `CycleReport`/`DreamReport` (keeps the bio stack above the gateway untouched); and the standing compliance gaps from the substrate spec — read-audit / access-denial logging, authn/authz enforcement, encryption, erasure.

---

## 3. Architecture: the gateway swap

`createMnemeGateway` goes from adapter-backed to Mneme-backed; the `MnemeGateway` interface is **unchanged** (still no `update`/`delete`):

```ts
// before:  createMnemeGateway(adapter: StorageAdapter = createSqliteAdapter()): MnemeGateway
// after:   createMnemeGateway(mneme: Mneme, corpusId: string): MnemeGateway
export interface MnemeGateway {
  read(query: BioQuery): Claim[];
  readByIds(ids: ClaimId[]): Claim[];
  apply(ops: AppendOp[], opKey: (op: AppendOp, i: number) => string): AppendResult;
}
```

- The gateway's `materialize` (id/recorded/seq/hashes) and its own idempotency layer are **removed** — `Promoter` owns them now (so the bio path also gets DB-derived monotonic seq, retiring the wave-1 per-instance counter).
- The gateway **no longer references the adapter** at all.
- Because the interface holds, the bio stack above (`cycle`, dream pass `select`/`admit`/orchestrator, `evidence-update`, `signals`, `episode`, facade `recall`/`record*`/`runCycle`/`dream`) is untouched.

---

## 4. The two `Mneme` reads

Thin, existence-checked delegations so the gateway depends only on `Mneme`:

```ts
interface Mneme { /* ...commit/supersede/promote/createCorpus/query unchanged... */
  read(corpusId: string, plan: ExecutionPlan): Claim[];
  readByIds(corpusId: string, ids: ClaimId[]): Claim[];
}
// createMneme:
read(corpusId, plan)    { catalog.getCorpus(corpusId); return adapter.query({ ...plan, corpusId }); },
readByIds(corpusId, ids){ catalog.getCorpus(corpusId); return ids.map(id => adapter.getClaim(id)).filter((c): c is Claim => c !== undefined); },
```

Both call `catalog.getCorpus(corpusId)` first (unknown corpus throws, like `commit`). `read` forwards the `ExecutionPlan` (incl. the `runIds` filter dreaming uses) to `adapter.query`; it is distinct from the pipeline-based `query(corpusId, pipeline)`. `readByIds` mirrors the gateway's current by-id fetch.

---

## 5. `AppendOp` → `Mneme` write mapping

`apply` maps each op to a `Mneme` write — fixed `BIO_WRITER = "bio"`, `opKey` becomes the Mneme `idempotencyKey`, the gateway's single `corpusId`:

| AppendOp | Mneme call |
|---|---|
| `{kind:"derive", claim}` | `mneme.commit(corpusId, claim, { policy: {kind:"always_accept"}, writer: BIO_WRITER, idempotencyKey: key })` |
| `{kind:"supersede", deprecate, with, reason}` | `mneme.supersede(corpusId, deprecate, with, { writer: BIO_WRITER, idempotencyKey: key })` |
| `{kind:"promote", target, to, reason}` | `mneme.promote(corpusId, target, to, { writer: BIO_WRITER, reason, idempotencyKey: key })` |

- **No `materialize` in the gateway** — `derive`/`supersede` pass the `CandidateClaim` straight to Mneme; `Promoter` assigns id/recorded/DB-seq/hashes and logs the `ClaimEvent`. `promote` forwards `op.reason` into the event.
- **`always_accept` for `derive`** — candidate dreams always land; read-time `⊥` handles conflicts (preserves the dreaming quarantine model).
- **Idempotency** is Mneme's now (`opKey` → `idempotencyKey`, scope `(workspace, "bio", key)`, 24h window). The gateway's own idempotency layer is removed — no double dedup.
- **One gateway = one corpus:** the gateway writes everything to its constructed `corpusId`; the consumer ensures bio claims belong to that corpus, whose schema validates their scope (the validation win).

The append-only invariant now holds *through the substrate* — `commit`/`supersede`/`promote` are the only write paths, all atomic + event-logged, none mutating value/confidence/evidence in place; the gateway's no-`update`/`delete` surface still stands on top.

---

## 6. Result mapping and error handling

`AppendResult` gains a `rejected` channel (additive — existing `res.applied` consumers unaffected):

```ts
interface AppendResult { applied: number; skipped: number; rejected: { key: string; status: string }[]; }
```
| Mneme status | → |
|---|---|
| `committed` / `superseded` / `promoted` | `applied++` |
| `duplicate` | `skipped++` |
| `rejected` / `not_found` / `invalid_transition` | `rejected.push({ key, status })` |

In current bio usage `rejected` is rare-to-impossible (`derive` is `always_accept`, `supersede` never rejects, `promote` isn't exercised yet), but recording beats dropping. Surfacing `rejected` into `CycleReport`/`DreamReport` is deferred (§2).

**Errors:** scope-invalid / unknown-corpus throw from Mneme; the gateway lets them propagate to the cycle/dream pass's existing fail-safe `try/catch` (→ `errors`, nothing further). Atomicity is **per-op** (each Mneme op is its own transaction) — the same granularity the gateway had before (per-op idempotency); no batch-atomicity regression.

---

## 7. Construction

`createBioMemory({ mneme, corpusId, dreamFn?, dream? })`. The consumer builds a `Mneme` (`createMneme` + `createCorpus`) and passes it + the `corpusId`; the gateway, cycle, runner, and dream pass are wired internally exactly as before (only the gateway's construction inputs change). The wave-1 positional/`{gateway}` construction is replaced — this is a breaking construction-signature change for direct callers of `createBioMemory`/`createMnemeGateway`, updated in the bio tests.

---

## 8. Testing

- **`gateway.test.ts` → Mneme-backed.** Build `createMneme()` + a registered corpus, construct the gateway, and assert: `derive`→committed claim in the corpus; `supersede`→old id deprecated + new replacement; `promote`→status change; `opKey`→idempotency dedup (`duplicate`/`skipped`); `read`/`readByIds` round-trip via the real Mneme/adapter; and that an invalid-scope claim surfaces as a thrown error (scope validation now active). The append-only guarantee rides on the substrate (`Promoter`) + the gateway's no-mutate surface.
- **`bio-memory.test.ts`** updated for `{ mneme, corpusId }` construction.
- **Rest of the bio suite** (cycle, dream pass, evidence-update, signals, episode) stays green **unchanged** — the proof that the interface seam held.

---

## 9. Blast radius

Five files: `src/mneme.ts` (two reads), `src/bio/types.ts` (the `rejected` field on `AppendResult`), `src/bio/gateway.ts` (rewrite impl + construction), `src/bio/gateway.test.ts` (Mneme-backed), `src/bio/bio-memory.ts` (construction). Everything else in `src/bio/` is untouched by design.

---

## 10. Out of scope (deferred)

- Surfacing `AppendResult.rejected` into `CycleReport`/`DreamReport` (would touch `cycle.ts`/`dreaming.ts` — deferred to keep the seam clean).
- Read-audit / access-denial logging, authn/authz enforcement, encryption at rest/in transit, the erasure profile — the standing compliance gaps (integrity ≠ compliance), carried over from the substrate spec.
- Multi-corpus bio gateways (one gateway = one corpus here).
