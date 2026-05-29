---
title: Public derive surface (mneme.derive)
created: 2026-05-29
status: design
---

# Public derive surface (`mneme.derive`) — Design

## 1. Goal

Expose deriving a claim on the public API. Today `deriveClaimFrom` / `commitDerived` are
internal, so a consumer cannot create a derived claim — which means the headline
`derive → replay → exact` arc can't be shown on the public surface (the epistemic quickstart
had to stub it as `integrity_unknown` + prose). This closes the gap noted as a follow-up in
`docs/superpowers/specs/2026-05-29-mneme-quickstart-design.md` §5.

## 2. Scope

- Add a `mneme.derive(corpusId, expr, opts)` method (method-only — `deriveClaimFrom` /
  `commitDerived` stay internal; the `ExprNode` constructors are already public).
- Update the epistemic quickstart (`examples/quickstart.ts` + `README.md` step 6) to show a
  real `derive → replay → exact` round-trip, replacing the stub.

Non-goals: no changes to the replay engine, no new operators, no bio-layer changes.

## 3. The method

Add to the `Mneme` interface and the `createMneme` return object, mirroring `mneme.replay`
(threads the instance's own `adapter`, `catalog`, and `promoterFor(corpusId)`):

```ts
derive(
  corpusId: string,
  expr: ExprNode,
  opts: {
    subject: string;
    key: string;
    scope: Scope;
    writer: string;
    evaluationClock?: number;
    combination?: string;
    policy?: ContradictionPolicy;
    idempotencyKey?: string;
  },
): { id: string; status: string };
```

Return shape is `{ id, status }` — consistent with `commit` / `supersede` / `promote`.

Implementation (orchestrates the two existing internal functions):

```ts
derive(corpusId, expr, opts) {
  catalog.getCorpus(corpusId);                          // existence check — throws on unknown corpus
  const candidate = deriveClaimFrom(adapter, catalog, expr, {
    subject: opts.subject, key: opts.key, scope: opts.scope,
    combination: opts.combination, evaluationClock: opts.evaluationClock,
  });
  const df = candidate.provenance!.derivedFrom!;        // deriveClaimFrom always sets this
  return commitDerived(promoterFor(corpusId), candidate, {
    queryExpression: df.queryExpression,                // already serializeExpr(expr)
    corpusState: df.corpusState,                        // already adapter.maxRecordedSeq()
    writer: opts.writer,
    policy: opts.policy,
    idempotencyKey: opts.idempotencyKey,
  });
}
```

No recomputation in the caller: `deriveClaimFrom` already records `queryExpression` and
`corpusState` on the candidate; `derive` reads them back to feed `commitDerived`.

## 4. Reproducible-replay contract (verified)

For `mneme.replay(derivedClaim)` to return `exact`, the recorded query must reproduce the
same representative on re-execution. The robust pattern — verified empirically against the
real library before this spec — is to **derive from source claims under a key the derived
claim does not use**, so re-execution never re-selects the derived claim itself:

- Sources: `subject: "host:web-01", key: "status"` (the probe readings).
- Derive query: `astSigma({ op: "keyEq", value: "status" }, astLeaf(corpus))`.
- Derived target: `key: "status.summary"` (≠ `"status"`).
- Re-execution selects only `status` claims (excludes `status.summary`) → same representative
  → `claimsEquivalent` → `exact`.

This contract is documented in the quickstart prose and the method's doc comment so consumers
choose a non-self-selecting query.

## 5. Files

| File | Change |
|------|--------|
| `src/mneme.ts` | Add `derive` to the `Mneme` interface and the returned object; import `deriveClaimFrom`, `commitDerived`, `ExprNode`. |
| `src/mneme.test.ts` | New tests: `derive` returns `{ id, status: "committed" }`; the derived claim **replays to `exact`**; unknown corpus throws. |
| `examples/quickstart.ts` | Add a `derive → replay → exact` step: derive a `status.summary` from the `status` claims, then `mneme.replay(...)` → `exact`. Add `derivedReplayStatus: string` to `QuickstartResult`. |
| `examples/quickstart.test.ts` | Assert `derivedReplayStatus === "exact"`. |
| `README.md` | Replace step 6's "described in prose" note with the actual derive→replay→exact snippet. |

## 6. Testability

- `src/mneme.test.ts`: seed two `status` claims, `derive` a `status.summary` via the
  key-excluded query, assert `{ status: "committed" }`, then
  `mneme.replay(mneme.readByIds(corpus, [id])[0]).status === "exact"`. Plus an unknown-corpus
  throw test.
- `examples/quickstart.test.ts`: the existing `runQuickstart()` gains `derivedReplayStatus`;
  assert it equals `"exact"`. The existing `replayStatusOfPlainClaim === "integrity_unknown"`
  assertion stays (it still teaches the degraded case).

Real in-memory adapter, no mocks. Full suite green; `tsc --noEmit` clean.

## 7. Acceptance criteria

- `mneme.derive(corpusId, expr, opts)` exists, returns `{ id, status }`, commits a derived
  claim with recorded `queryExpression` + `corpusState`, and throws on unknown corpus.
- A claim produced by `mneme.derive` with a non-self-selecting query replays to `exact`.
- `deriveClaimFrom` / `commitDerived` remain unexported; only the method is public.
- The epistemic quickstart (`examples/quickstart.ts`, its test, and `README.md`) demonstrates
  `derive → replay → exact` with `derivedReplayStatus === "exact"`.
- Full suite green; `tsc --noEmit` clean.

## 8. Out of scope / follow-ups

- `compile` coverage for `combine` / `resolve` / `aggregate` — still tracked, unrelated.
- §5.6 observation-level dedup — still tracked, unrelated.
