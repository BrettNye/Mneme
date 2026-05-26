# Design: Substrate Unified Write API + Write-Event Log

**Date:** 2026-05-26
**Status:** Approved design (brainstorm complete). Next step: DAG implementation plan via `writing-dag-plans`.
**Type:** Substrate change (`src/write/*`, `src/mneme.ts`, `src/adapters/*`).

---

## 1. Context and relationship

This is the **substrate half** of the bio↔substrate write-path reconciliation flagged during the wave-2 Dreaming audit. The bio gateway writes straight to the `StorageAdapter`, bypassing the substrate's write pipeline (scope validation, contradiction policy, monotonic seq, atomicity). The agreed fix is to route the bio layer through the substrate write API — but that API can't express the bio op set today, so we extend the substrate **first** (this spec). **Routing the bio gateway through this API is a separate follow-on spec.**

What exists today (`src/mneme.ts`, `src/write/pipeline.ts`):
- `Mneme.commit(corpusId, candidate, { policy?, writer, idempotencyKey? })` → backed by a per-corpus cached `Promoter`.
- `Promoter.commit` does scope validation (`validateScope`), contradiction enforcement (`enforce`), and assigns `recorded`/`recordedSeq` from an **in-memory** counter.

Three gaps this spec closes: (a) `commit` can't express `supersede` (deprecate a *known* id + insert replacement) or `promote` (status transition); (b) `Promoter` is **not atomic** (deprecate + insert + idempotency aren't transactional) and `StorageAdapter` exposes no `transaction`; (c) `recordedSeq` is in-memory (resets to 0 on restart). Plus a compliance-adjacent addition surfaced during the brainstorm: a **write-event log** (the substrate has none today).

---

## 2. Scope

**In scope (substrate):**
- Add discrete write methods `supersede` and `promote` beside the existing `commit`, on `Promoter` and `Mneme`.
- A shared atomic write core in `Promoter` (transaction-wrapped, DB-derived seq).
- `StorageAdapter` additions: `transaction`, `maxRecordedSeq`, `appendEvent`, `readEvents`.
- An append-only **write-event log** written atomically with each successful write.

**Out of scope (deferred — see §10):** the bio gateway routing through this API (the other half of the reconciliation); read-audit and access-denial logging; authn/authz enforcement; encryption at rest/in transit; the erasure profile. This spec improves the *integrity / processing-integrity* dimension; it is **not** a compliance deliverable (HIPAA/SOC 2 are organizational regimes, not properties of a library).

---

## 3. Architecture & the shared atomic write core

**`StorageAdapter` gains (all small):**
```ts
transaction<T>(fn: () => T): T;                 // run fn in a DB transaction; roll back on throw
maxRecordedSeq(): number;                        // current max recorded_seq (0 if empty)
appendEvent(e: ClaimEvent): void;                // append to the events table (called inside a transaction)
readEvents(filter?: { corpusId?: string; claimId?: string; since?: number }): ClaimEvent[];
```
The SQLite adapter already uses `db.transaction` internally for `insertBatch`, so `transaction` is a thin wrap (`return db.transaction(fn)()`); `maxRecordedSeq` is `SELECT MAX(recorded_seq)`; `appendEvent`/`readEvents` back onto a new append-only `claim_events` table.

**`Promoter` gets a private atomic core** every op routes through:
```ts
private write<T>(
  idem: { scope: string; key?: string } | undefined,
  body: (recorded: number, seq: number) => { result: T; id?: string; event: ClaimEvent }
): T {
  if (idem?.key) { const prior = checkIdempotent(this.adapter, idem.scope, idem.key, Date.now());
                   if (prior) return <duplicate result with prior id>; }      // dedup BEFORE the transaction
  return this.adapter.transaction(() => {
    const recorded = Date.now();
    const seq = this.adapter.maxRecordedSeq() + 1;          // DB-derived → survives restart, monotonic across instances
    const { result, id, event } = body(recorded, seq);
    this.adapter.appendEvent(event);                         // event is atomic with the write
    if (idem?.key && id) recordIdempotent(this.adapter, idem.scope, idem.key, id, Date.now()); // record INSIDE txn
    return result;
  });
}
```
This fixes **atomicity** (deprecate + insert + event + idempotency in one transaction; any throw rolls all back) and **monotonic seq** (DB-derived, replacing `Promoter`'s in-memory `seq`/`lastRecorded`) for all three ops at once. `Promoter` is now constructed with its `corpusId` (`new Promoter(adapter, schema, corpusId)`) so it can stamp events.

**`(recorded, seq)` semantics:** the core's computed `(recorded, seq)` always stamps the **event**. `commit` and `supersede` also apply it to the **new claim row** they insert; `promote` does **not** — its target claim keeps its original `recorded`/`recordedSeq` (only `status` changes), and the fresh stamp lives only on the transition event. (Note also: `maxRecordedSeq()` coalesces empty → 0, and each op derives its idempotency scope from the claim's `workspace`+`writer`+`key` per the existing `idempotencyScope` helper.)

---

## 4. The three op methods (all via the `write` core)

```ts
commit(candidate, { policy, writer, idempotencyKey? }): { id, status: "committed"|"rejected"|"duplicate" }
supersede(deprecateId, replacement, { writer, idempotencyKey? }): { id, status: "superseded"|"duplicate" }
promote(targetId, to, { writer, reason?, idempotencyKey? }): { id, status: "promoted"|"not_found"|"invalid_transition"|"duplicate" }
```

- **`commit`** — refactored onto `write`; same external behavior (materialize → `validateScope` → contradiction `enforce` → deprecate conflicts + insert), now atomic + DB-seq'd + event-logged. Unchanged status contract.
- **`supersede(deprecateId, replacement)`** — `validateScope(replacement.scope)`; materialize the replacement with a **fresh id**; `deleteClaim(deprecateId)` (soft-deprecate — **best-effort**: a missing id is a no-op, the replacement still lands) + `insertClaim(replacement)`. **No contradiction `enforce`** (explicit, caller-identified replacement; reinforcement/outcome-reweighting must always apply). The old version persists as `deprecated` (append-only preserved).
- **`promote(targetId, to)`** — fetch target; missing → `not_found`. **Forward-only lifecycle**: allow `candidate→provisional`, `candidate→validated`, `provisional→validated`, and `any→deprecated`; a backward move → `invalid_transition`. On success re-insert `{ ...target, status: to }` (same id; value/confidence/evidence **and `recorded`/`recordedSeq`** untouched). The transition is recorded as an event carrying the core's fresh `recorded`/`recordedSeq` and `reason` (§7).

---

## 5. The `Mneme` facade surface

```ts
interface Mneme {
  commit(corpusId, candidate, { policy?, writer, idempotencyKey? }): { id, status };   // existing
  supersede(corpusId, deprecateId, replacement, { writer, idempotencyKey? }): { id, status };  // NEW
  promote(corpusId, targetId, to, { writer, reason?, idempotencyKey? }): { id, status };        // NEW
  createCorpus / query                                                                 // unchanged
}
```
Both new methods delegate to the cached `promoterFor(corpusId)` (the cache is what makes DB-derived seq monotonic per corpus). **No policy resolution** for either — `supersede` bypasses contradiction, `promote` is status-only. Corpus existence is enforced via `promoterFor` → `catalog.getCorpusSchema(corpusId)` (throws for unknown corpus, same as `commit`).

The payoff: the follow-on bio-routing spec maps its `AppendOp` union directly — `derive`→`commit`, `supersede`→`supersede`, `promote`→`promote`.

---

## 6. Error handling

| Failure | Handling |
|---|---|
| Transaction body throws (insert/deprecate/append fails) | `transaction` **rolls back the whole op** — no partial write, no event, no idempotency record. Error propagates. |
| Invalid scope (`commit`/`supersede`) | `validateScope` throws inside the body → rollback → throw (same as today's `commit`). Not a status code. |
| Contradiction reject (`commit` only) | `{ status: "rejected" }`, no throw, nothing written. |
| Idempotency hit | `{ status: "duplicate" }` with the prior id — returned **before** opening a transaction. |
| `supersede` target missing | Best-effort: deprecate is a no-op, replacement still inserted → `superseded`. |
| `promote` target missing / backward | `not_found` / `invalid_transition`, nothing written. |
| Empty table | `maxRecordedSeq()` → 0, so first `recordedSeq` = 1. |

**Idempotency ordering rule:** the idempotency **check** runs before the transaction (cheap dedup); the idempotency **record is written inside** the transaction, so a rolled-back write leaves no record and is safely retryable. **Principle:** a failed write leaves the corpus (and the event log) exactly as before — atomic all-or-nothing per op, idempotent on retry.

---

## 7. Write-event log

Every **successful** write records an immutable event **inside the same transaction** as the claim change.

```ts
interface ClaimEvent {
  op: "commit" | "supersede" | "promote";
  corpusId: string;
  writer: string;
  claimId: string;          // resulting / affected claim id
  deprecatedId?: string;    // supersede: the deprecated id
  toStatus?: string;        // promote: target status
  reason?: string;          // promote.reason's home
  recorded: number;
  recordedSeq: number;
}
```
Backed by an append-only `claim_events` table. Because `appendEvent` runs inside `Promoter.write`'s `transaction`, **the event commits iff the write commits** — a trustworthy trail, not a best-effort side-log. This closes the `promote.reason` gap and gives the integrity/audit story a real artifact.

**Deliberately scoped:** logs **successful writes** (the change-integrity trail). It does **not** cover read-audit, access-*denial* logging, authn, or encryption — those remain the separately-tracked compliance gaps (§10). A solid write-integrity log beats a half-built everything-log.

---

## 8. Testing

- **Atomicity (centerpiece):** force the insert to throw mid-`supersede` → assert full rollback (named id NOT deprecated, no replacement, **no event**).
- **`commit` regression:** existing `pipeline.test.ts` behaviors pass (committed/rejected/duplicate, enforce, scope validation) — now atomic + DB-seq.
- **`supersede`:** deprecates named id (persists `deprecated`) + inserts fresh-id replacement; scope-validated; missing target → no-op deprecate + replacement lands; a strict policy does NOT reject it; idempotency duplicate.
- **`promote`:** valid forward transitions succeed in place (same id, value/confidence/evidence unchanged); backward → `invalid_transition` (nothing written); missing → `not_found`; `reason` lands in the event.
- **Monotonic seq:** increments across ops; a **new `Promoter` on the same adapter** continues from `maxRecordedSeq` (not 0) — restart/cross-instance fix.
- **Idempotency:** duplicate key → prior id; **rolled-back write leaves no idempotency record** (retry succeeds).
- **Event log:** each op appends the correct `ClaimEvent`; `readEvents` filters; events atomic with writes.
- **Adapter unit:** `transaction(fn)` rolls back on throw; `maxRecordedSeq()` (incl. empty → 0); `appendEvent`/`readEvents` round-trip.

Tests follow the Mneme convention (colocated `*.test.ts`, vitest globals).

---

## 9. Components and isolation

| Unit | Responsibility | Depends on |
|---|---|---|
| `StorageAdapter` additions (`transaction`, `maxRecordedSeq`, `appendEvent`, `readEvents`) + `claim_events` table | atomic execution, seq source, event persistence | better-sqlite3 |
| `Promoter.write` core | one transaction-wrapped path: seq, event, idempotency | StorageAdapter |
| `Promoter.commit/supersede/promote` | per-op bodies (validate / enforce / deprecate / status-transition) | `write` core, `validateScope`, `enforce` |
| `Mneme.supersede/promote` | corpus resolution + delegation | `promoterFor` |
| `ClaimEvent` type | the audit-trail contract | core types |

Write *semantics* stay in `Promoter`; the adapter only gains a general transaction primitive + event storage (no write rules leak into the storage layer).

---

## 10. Dependencies, sequencing, and out of scope

**Sequencing:** the `StorageAdapter` additions land first (other tasks consume them); `Promoter.write` core before the op methods; `Mneme` surface + event-log wiring after.

**Out of scope / deferred:**
- **Bio gateway routing through this API** — the other half of the reconciliation; its own follow-on spec. (Maps `AppendOp` → `commit`/`supersede`/`promote`; retires the bio gateway's direct-adapter writes.)
- **Compliance-supporting controls beyond write-integrity:** read-audit log, access-*denial* logging, authn/authz enforcement (the `AccessPolicy`/authorization adapter, §3.4/§9 of the spec, are still delegated/unbuilt), encryption at rest/in transit. HIPAA/SOC 2 are organizational regimes; this spec only strengthens integrity/processing-integrity.
- **Erasure profile** (`[Prof]`, Appendix H) — real deletion remains in tension with the append-only model; "suppression ≠ deletion."
- **Forward-only lifecycle as a shared validator** — `promote`'s transition check is local here; promoting it to a reusable status state-machine is a later refinement.
