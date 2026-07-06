# Read-path predicate pushdown — design spec (2026-07-06)

Status: **DRAFT / audited.** Owner: algebra read path. Prompted by the 2026-07-06 repo
review: the storage layer compiles `subject`/`key`/`status`/`scopeHash`/`recordedAtMost`/
`runIds` predicates into indexed SQL (`src/adapters/sqlite.ts` `executeQuery`,
`src/adapters/postgres/sql.ts` `buildQuery`), but the algebra read path never exercises it —
`leaf(corpusId)` loads the **entire corpus** (`src/algebra/expression.ts:34-39`, async twin
`src/algebra/async-expression.ts:81-86`) and all σ filtering happens in JS
(`src/algebra/selection.ts:5-6`).

Adversarially audited 2026-07-06 by three parallel lenses (code-reality/repo-pattern,
DRY/SRP/API, domain-correctness). Findings folded throughout; provenance in §12.

## 1. Problem

Every surface read materializes the whole corpus, however narrow the query:

- **`recall`** runs **two** full-corpus pipelines per call: the main ranked query
  (`src/surface/recall.ts:283-292`) and the cardinality-safety query
  (`src/surface/recall.ts:309-313`). A recall scoped to one `(subject, key)` still hydrates
  **every claim in the corpus — including deprecated ones** (`executeQuery` applies no
  status condition) — twice. The warm-up path `warmRecallValues` and the alias load
  `loadAliasContext` already use `mneme.read` with subject/key pushdown
  (`recall.ts:198-203`, `recall.ts:73-77`), but for a key-only recall (no subject) even
  those hit the missing-index gap §7 closes — pushed-down is not yet index-backed there.
- **`explainRecall`** runs **five** full-corpus pipelines per call
  (`src/surface/explain.ts:107-111`) — the σ-prefix re-derivation of each canonical stage.
- The write path is fine: contradiction detection reads via
  `idx_claims_corpus_identity(corpus_id, subject, key, scope_hash)` (added precisely to
  avoid O(n²) writes — `src/adapters/sqlite.ts:233-236`).

This is invisible at dogfood scale and linear-degrading as corpora accrete — and accretion
is the product thesis. The gap is purely physical: the `ExecutionPlan` fields exist, both
adapters compile them, and `mneme.read` uses them; only the algebra `leaf` never populates
them.

## 2. Design resolution: explicit leaf hints, belt-and-braces

Two shapes were considered:

- **(A) Explicit hints on `leaf`** — `leaf(corpusId, hints?)`; callers pass the plan
  fragment they already know. Small diff, no introspection, covers the hot paths
  (recall, explain).
- **(B) An automatic σ-fold optimizer** — tag σ/leaf stage closures with metadata and have
  `evaluate()` fold leading σ predicates into the leaf's plan. Covers every pipeline
  (DSL, replay/compile, user-authored) with zero caller changes, but introduces an
  optimizer seam and function-property metadata across four builder sites
  (`src/mneme.ts` `sigma`, `src/algebra/async-expression.ts` `asyncSigma`,
  `src/algebra/compile.ts:44` `liftOp(sigma(...))`, `leaf`/`leafAsync`), against the
  explicit note "No optimizer reordering in the MVP" (`expression.ts:72`).

**Resolution: (A).** The hot paths are exactly two files (`recall.ts`, `explain.ts`); the
cold paths (replay via `compile.ts`, DSL, census) either cannot benefit (census is
corpus-wide by nature) or are low-traffic. (B) is documented as deferred with a trigger
(§10). This follows composition-first: no new algebra, no new operator — `leaf` gains an
optional physical-plan argument, and the σ stages **stay in the pipeline unchanged**, so
the logical semantics are untouched by construction.

**The belt-and-braces invariant.** Hints are a *pre-filter*, never a replacement: every σ
stage still runs in memory over the hinted result. Therefore an overly **broad** hint is
harmless (σ re-filters), and correctness only requires that hints never be **narrower**
than the σ conjunction. To make that structural rather than discretionary, the σ stages
and the hints are produced by **one call from one predicate list** (§4, amendment A1) —
a caller cannot build them from divergent inputs.

## 3. Public surface

### 3.1 `ExecutionPlan.keys` (new field)

```ts
// src/adapters/adapter-types.ts
export interface ExecutionPlan {
  corpusId: string;
  subject?: string;
  key?: string;
  keys?: string[];     // NEW — match claims whose key is in this set (SQL: key IN (...))
  status?: string[];
  scopeHash?: string;
  recordedAtMost?: number;
  runIds?: string[];
}
```

Needed because recall's key filter is a **family** after alias expansion
(`keyFamilyOf` → `keyIn` predicate, `recall.ts:254`, `buildFilterSigmas` at
`recall.ts:170-176`).

Semantics, stated precisely (amendments A4, A5, A11):

- **Conjunction contract.** All plan fields AND together, exactly like the existing
  conditions. `leafHintsOf` **may legally set both `key` and `keys`** — a conjunction
  containing `keyEq` and a multi-element `keyIn` folds to both fields, and the adapter's
  AND of the two conditions equals the σ conjunction precisely. (The `status`/`runIds`
  array branches are precedent for the mechanical shape, not the semantics; the real
  justification is: hints are a conjunction, and AND is the conjunction.)
- **Empty-array divergence — documented on the field.** An empty `keys` emits no SQL
  condition (mirrors `plan.status !== undefined && plan.status.length > 0` at
  `sqlite.ts:349`, `sql.ts:59`) and therefore matches *everything*; the σ predicate
  `keyIn([])` matches *nothing* (`predicate.ts:51-52`). This is harmless for hints
  (broader-only; σ corrects) but a footgun for direct `mneme.read` callers — the field's
  doc comment must state it, and `leafHintsOf` **omits the field** for an empty `keyIn`
  rather than emitting `keys: []`.
- **`plan.corpusId` is advisory/dead in both adapters.** Neither `executeQuery` nor
  `buildQuery` compiles it; isolation comes solely from `scoped()`'s forced scope
  (`sqlite.ts` scoped force, `sql.ts:34-41`), which hints can only AND-narrow — no
  widening or bypass path exists.

Adapter changes:

- `src/adapters/sqlite.ts` `executeQuery`: add the `key IN (...)` branch after the `key`
  branch, using the same dynamic-placeholder pattern as `status`.
- `src/adapters/postgres/sql.ts` `buildQuery`: same branch **in the same position**, so
  the documented sqlite↔pg condition ordering stays aligned (the builder's doc comment
  enumerates the ordering — update it).
- `ORDER BY recorded_seq ASC, id ASC` is untouched — the determinism contract
  (`sqlite.ts:361-366`) already guarantees a filtered subset arrives in the same total
  order as the full corpus would (`id` is PRIMARY KEY in both adapters, so the tie-break
  is total), which is what makes pushdown order-transparent to the IEEE-754-sensitive
  folds downstream.

### 3.2 `leaf` / `leafAsync` optional hints

```ts
// src/algebra/expression.ts
import type { LeafHints } from "./pushdown.js";

export function leaf(corpusId: string, hints?: LeafHints): Stage<void, Corpus> {
  return (_input, ctx) => {
    ctx.catalog.getCorpus(corpusId); // throws for unknown corpus (unchanged)
    return corpusOf(ctx.adapter.query({ corpusId, ...hints }));
  };
}
```

`leafAsync` in `src/algebra/async-expression.ts` gets the identical optional parameter.
The parameter is optional and additive — every existing call site, test, and the
AST/replay path (`astLeaf` and `compile.ts`, untouched) behaves byte-identically.
`status`/`scopeHash`/`recordedAtMost` are deliberately **excluded** from `LeafHints`: no
hot caller filters on them at the σ level, and status pre-filtering interacts with the
canonical pipeline's own status handling (deprecation happens *inside* ⊥ then drops at
`canonicalReadStages` stage 4) — keep the hint surface exactly as small as the need.

### 3.3 `src/algebra/pushdown.ts` — `LeafHints` + `leafHintsOf` (single derivation point)

```ts
// src/algebra/pushdown.ts (new module, pure, unit-tested)
export type LeafHints = Pick<ExecutionPlan, "subject" | "key" | "keys">;
export function leafHintsOf(preds: Predicate[]): LeafHints;
```

Both live here (amendment A8): the module imports `predicate.ts` + adapter types only, and
`expression.ts` imports `LeafHints` from it. `Pick<ExecutionPlan, ...>` is a deliberate
first use of the idiom in this repo (no `Pick<` exists in `src/` today): a hand-copied
interface would be a silent drift channel if a plan field's semantics ever change, whereas
the `Pick` makes divergence a compile error. `ExecutionPlan` itself is not barrel-exported
today (despite `mneme.read(corpusId, plan)` being public API); exporting it is optional
and out of scope here — `LeafHints` is exported and structural, which suffices.

Fold rules for the top-level conjunction: `subjectEq` → `subject`, `keyEq` → `key`,
`keyIn` → `keys` (a one-element `keyIn` folds to `key`; an **empty** `keyIn` contributes
nothing — see §3.1), `and` → recurse into conjuncts. Every other predicate op (`or`,
`not`, value predicates, `tagIn`, `scopeEq`, `confidenceGt`, temporal ops) contributes
**nothing** — it stays σ-only. If two conjuncts would bind the same field with different
values (a self-contradictory query), the first wins and σ still yields the correct
(empty) result; cross-field double-binding (`keyEq` ∧ `keyIn`) sets both fields and the
adapter ANDs them (§3.1). The hint is broader or exactly equal, never narrower.

Placement note (layering contract, `read-pipeline.ts:4`): algebra already imports adapter
types in four modules (`expression.ts`, `predicate.ts`, `value-routing.ts`,
`async-expression.ts`) — no new dependency direction. (`predicate.ts`'s
`VALUE_PREDICATE_KIND` is precedent for logical→physical mapping living in algebra.)

## 4. Call-site changes

**Sealed pair (amendment A1 — binding).** The σ stages and the hints must be derivable
only *together*, from one predicate list, so a future edit cannot pass a different
`family` to one of two calls and produce a hint narrower than σ. Replace
`buildFilterSigmas` (not barrel-exported — `src/index.ts` has no export of it, so the two
internal call sites migrate freely, no compat alias):

```ts
// src/surface/recall.ts
export function buildFilterPlan(
  args: RecallArgs, family?: string[],
): { sigmas: Stage<Corpus, Corpus>[]; hints: LeafHints } {
  const preds: Predicate[] = [];
  if (args.subject) preds.push({ op: "subjectEq", value: args.subject });
  if (family && family.length > 1) preds.push({ op: "keyIn", values: family });
  else if (args.key) preds.push({ op: "keyEq", value: args.key });
  return { sigmas: preds.map((p) => sigma(p)), hints: leafHintsOf(preds) };
}
```

Then thread `hints` into every `leaf(args.corpus)` on the hot paths:

| Site | Queries | Change |
|---|---|---|
| `recall.ts:283-292` (main ranked query) | 1 | `leaf(args.corpus, hints)` |
| `recall.ts:309-313` (cardinality-safety query) | 1 | `leaf(args.corpus, hints)` |
| `explain.ts:107-111` (stage re-derivation) | 5 | `leaf(args.corpus, hints)` ×5 |

**`warmRecallValues` unification (amendment A9).** The warm path hand-rolls the family
fan-out `keys` now expresses: N per-key `mneme.read` calls plus manual id-dedup
(`recall.ts:196-204`). Collapse it to one read —
`mneme.read(args.corpus, { corpusId: args.corpus, subject: args.subject, keys: family })`
(or `key: args.key` when no family) — one query, no dedup loop, and it removes a second
hand-written "family → physical plan" site.

Unchanged: `census.ts:135` (corpus-wide by nature — no predicate exists to push),
`dsl.ts:34` (deferred, §10), `compile.ts` (replay — untouched, §6), `loadAliasContext`
(already pushed down via `mneme.read`).

### Why this is semantics-preserving (not just plausibly so)

σ already runs **before** the canonical stages in every current pipeline
(`pipe(leaf, ...sigmas, ...canon, ranker)`) — the complete non-test `leaf` inventory is
recall ×2, explain ×5, census, dsl — so τ_valid/⊕_dedupe/⊥/drop already operate on the
σ-filtered subset today. Pushdown changes *where* that same subset boundary is computed
(SQL vs JS), not what crosses it. Cluster integrity holds: ⊕_dedupe merges within
`(subject, key, scope)` and ⊥ groups within `(subject, canonical-key-family, scopeHash)`
(`contradiction.ts:62-67`) — a `subject` + `keys`(family) hint keeps whole clusters intact
because it is derived from the same family-expanded predicate σ uses. Alias infrastructure
claims cannot leak into a family: `aliasMapOf` drops meta-aliases
(`key-alias.ts:119-155`), so `keyFamilyOf` never emits `alias-of` via the map.

**Equality semantics, stated in the only form that must hold (amendment A12):** the hint
must match **at least** every claim σ matches. For SQLite this is exact — TEXT columns,
BINARY collation, `toRow` writes plain strings, and lone-surrogate replacement is
symmetric on write and bind. For Postgres, `subject`/`key` are `text` under the
*deployment's default collation* (`schema.ts` — only `id` is `COLLATE "C"`), so "exact"
would be config-dependent; but byte-identical strings compare equal under **every**
collation, so SQL `=` can never match *fewer* rows than JS `===`. Narrower is impossible;
σ corrects any broader match; byte-parity never depends on collation.

## 5. Phase 2 — recall single-materialization (same spec, separate task)

After pushdown, recall's two queries still hydrate the same rows twice and run
τ_valid + ⊕_dedupe twice. Restructure to evaluate the shared prefix once:

```
preContra = query( pipe(leaf(corpus, hints), ...sigmas, canon[0], canon[1]) )   // one I/O pass
safety    = try { cardinalitySafetyWarnings(preContra, ...) } catch → warning    // read-only, FIRST, own try/catch
ranked    = query( pipe(fromCorpus(preContra), canon[2], canon[3], ranker) )     // no I/O
```

Requirements (amendments A2, A6, A7 — A2 is binding):

- **Warnings order is pinned.** `RecallResult.warnings` today accretes
  alias (`recall.ts:249`) → coverage (`recall.ts:300-302`) → cardinality
  (`recall.ts:314`). The safety warnings are *computed* early but **buffered and appended
  at their current position** (after the coverage warning), so the array is byte-identical
  to today. A golden `RecallResult` regression test (including `warnings` order) is
  captured **before** the restructure and pinned.
- **Error contract preserved.** `cardinalitySafetyWarnings` stays inside its own
  try/catch, so a safety-check-only failure still degrades to a warning. A throw in the
  shared prefix fails the whole recall — but the main query runs the identical stages
  today and would have thrown identically; no observable change *single-threaded*.
- **Snapshot consistency (intended change).** Today the safety check is a second DB read;
  a concurrent writer between the two reads can make the warnings reflect newer store
  state than the ranked result. Phase 2 collapses both onto one snapshot — a determinism
  *improvement*, documented here as intended (the single-threaded differential test will
  not witness it).
- **`fromCorpus` lives in algebra.** `fromCorpus(c): Stage<void, Corpus>` (`() => c`) is
  defined in `src/algebra/expression.ts` next to `leaf`, unit-tested there — not minted
  inline in `recall.ts` (a surface module must not own an algebra primitive, and
  `explain.ts`'s five pipelines are the obvious second consumer).
- **Purity: verified, pinned, not gated.** The audit confirmed on today's source that the
  canon stages do not mutate inputs: `resolveDeprecateOlder` → `mapCorpus` spreads
  (`resolution.ts:14-17, 106-111`), `dedupeGroups` copies before sorting and spreads
  survivors (`combination.ts:48-64, 128-139`), `tauValid` is `filterCorpus`. The §8.6
  deep-freeze test is a **regression pin**, and it must freeze the **claim objects
  themselves** — outputs share claim references with inputs and `corpusOf` freezes only
  the array (`types.ts:22-24`). The mandatory invariant is the ordering discipline above
  (warnings read before the suffix runs), which neutralizes suffix-stage mutation
  categorically; the previous draft's "or drop Phase 2" branch is deleted as incoherent.
- Nondeterminism note (pre-existing, unchanged): `flagArtifactFor` mints
  `newClaimId()`/`Date.now()` inside canon[2] (`resolution.ts:33-49`) but the artifacts
  are dropped at canon[3] and never served.

## 6. Determinism, replay, and parity invariants

- **Replay untouched.** The AST (`ast.ts`), wire format (`serialize.ts`), and `compile.ts`
  are not modified; `compile` maps `leaf` → `leafStage(node.corpusId)` with no hints
  (`compile.ts:40-41`) and `replayStatus` evaluates the compiled AST directly. Derive's
  recorded `corpusState` is `adapter.maxRecordedSeq()` (`derive.ts:197`) — a store-wide
  scalar independent of any plan. Pushdown never appears in provenance because it never
  changes results.
- **Byte-identical results.** With σ retained, `recall`/`explainRecall` outputs are
  byte-equal with hints on vs. off — enforced by a differential property test (§8.3)
  with a **pinned `asOf`** (amendment A3: two invocations without `asOf` each take their
  own `Date.now()` at `recall.ts:246`, which anchors both τ_valid and the recency blend —
  an unpinned differential is flaky by construction).
- **Order-sensitivity.** The adapter's total order (`recorded_seq, id` — `id` is a PK) is
  the same for a filtered query as for the full-corpus query restricted to the same
  subset, so non-associative confidence folds see identical operand order.
- **sqlite↔pg parity.** The `keys` branch is added to both builders in the same ordering
  position; the sqlite↔pg mirroring is deliberate duplication (`sql.ts:1-4` says so) — no
  shared builder; the parity suite guards it.
- **Warnings drift: none on hot paths.** σ's `routeValuePredicates` inspects only value
  predicates (`value-routing.ts`), and recall's σ predicates are only
  `subjectEq`/`keyEq`/`keyIn` — no warning behavior changes. Hints are opt-in, so no
  existing pipeline changes behavior.

## 7. Index support

The pushed key-only query (recall with `key`, no `subject` — common in MCP usage) has no
covering index: `idx_claims_corpus_identity(corpus_id, subject, key, scope_hash)` needs
`subject` to seek past its second column, and `idx_claims_pks(profile, key, scope_hash)`
is not corpus-first. Add:

- SQLite: `CREATE INDEX IF NOT EXISTS idx_claims_corpus_key ON claims(corpus_id, key)` —
  idempotent, alongside the existing index creations at open (`sqlite.ts:232-236`).
- Postgres: `idx_claims_tenant_corpus_key ON ${p}claims(tenant_id, corpus_id, key)` — as a
  new versioned entry in `MIGRATIONS` (`src/adapters/postgres/schema.ts`,
  `{version, up(prefix)}` entries with idempotent `IF NOT EXISTS` DDL), tenant-first to
  match the row-level query shape (`tenant_id` is always the first condition,
  `sql.ts:31-32`).

This index also makes the already-pushed-down warm-up and alias reads index-backed for
key-only recalls (§1). Subject-only and subject+key queries are already covered by
`idx_claims_corpus_identity` (sqlite) / `idx_claims_tenant_identity` (pg). The new index
cannot affect served order under any plan choice — `ORDER BY recorded_seq, id` is total.

## 8. Testing plan

1. **Unit — `leafHintsOf`** (`src/algebra/pushdown.test.ts`): each foldable op; `and`
   recursion; non-foldable ops contribute nothing; one-element `keyIn` → `key`;
   **empty `keyIn` → field omitted** (A5); **`keyEq` ∧ `keyIn` → both `key` and `keys`
   set** (A4); same-field conflicting conjuncts → first wins; empty input → `{}`.
2. **Adapter tests — `keys`**: the shared backend-agnostic contract in
   `src/adapters/adapter-contract.ts` (which `conformance.pg.test.ts` merely invokes)
   gains the cases; the pg builder branch is unit-tested in the existing
   `src/adapters/postgres/sql.test.ts`; sqlite unit + `parity.pg.test.ts` extended.
   Cases: `query({corpusId, keys})` ≡ in-memory `keyIn` filter of `query({corpusId})`
   **for non-empty `keys`** (the empty case is carved out: plan-level `keys: []` = no
   condition, per §3.1), order preserved; `keys` composes with `subject`, with `key`
   (both-set ANDing), and with forced scope.
3. **Differential property test** (`*.property.test.ts`, fast-check — precedent:
   `src/distribution/beta.property.test.ts` / `scalar.property.test.ts`, the repo's only
   property suites): for random corpora and random `RecallArgs` (subject/key/alias-family
   combinations) with **`asOf` pinned** and deterministic seeding, `recall` with hints ≡
   `recall` with a hint-stripped `leaf` — byte-equal `RecallResult` including `warnings`
   and `coverage`. Same for `explainRecall`.
4. **Integration**: `src/mcp/server.integration.test.ts` recall/explain cases pass
   unchanged (they should — results are identical); one new case asserting a
   subject+key-scoped recall against a corpus seeded with other-subject claims returns
   the same result as before the change (regression pin).
5. **Hydration-count smoke**: wrap an adapter with a counting `query()` and assert a
   `(subject, key)`-scoped recall hydrates only the matching rows, not the corpus — this
   is the actual point of the change, pinned as a test.
6. **Phase 2 pins**: (a) golden `RecallResult` (including `warnings` array order)
   captured pre-restructure and asserted post-restructure; (b) deep-freeze purity pin —
   freeze the **claim objects**, not just the corpus array, and run the canonical stages
   + `cardinalitySafetyWarnings` over the frozen corpus.

## 9. Dials & defaults

None. Pushdown has no threshold, no configuration, and no observable behavior — it is
either correct and always-on (hints derived from predicates) or absent (no hints). This is
deliberate (knobs-off principle): a "pushdown on/off" dial would double the test matrix
for zero user value; the differential property test is the safety net instead.

## 10. Out of scope / deferred

- **(B) Automatic σ-fold optimizer** (tagged stages, `evaluate()` folding). Trigger:
  user-authored pipelines or the DSL path become a measured hot path, or a third surface
  op needs hints and the call-site pattern starts to smell like duplication.
- **DSL `where` folding** (`dsl.ts`) — mechanical once (B) or a DSL-local fold exists;
  not a hot path today.
- **`subjects?: string[]` plan field** (`subjectIn` pushdown) — same mechanics as `keys`;
  add when a caller exists.
- **Status/scope/recordedAtMost hints** — excluded from `LeafHints` until a hot caller
  filters on them at σ level (§3.2).
- **Barrel-exporting `ExecutionPlan`** — arguably overdue (`mneme.read` takes it as
  public API) but orthogonal; `LeafHints` is exported and structural.
- **jsonb value-predicate pushdown** — separate ROADMAP item (spec §10.2), orthogonal:
  that is *value* predicates inside the adapter; this spec is *identity* predicates into
  the existing plan.
- **Census pushdown** — census is definitionally corpus-wide; nothing to push.

## 11. Delivery

Branch `feat/read-path-pushdown` off `main`. Suggested task cut (DAG plan to follow after
spec ratification):

1. `ExecutionPlan.keys` + sqlite branch + pg branch + tests in `adapter-contract.ts`,
   `postgres/sql.test.ts`, sqlite unit, parity.
2. `src/algebra/pushdown.ts` (`LeafHints` + `leafHintsOf`) + unit tests.
3. `leaf`/`leafAsync` optional hints + barrel export of `LeafHints`.
4. `buildFilterPlan` sealed pair + recall/explain call sites + `warmRecallValues`
   single-read migration + differential property test (pinned `asOf`) + integration pin
   + hydration-count smoke.
5. Indexes (sqlite idempotent + pg migration) + migration test.
6. Phase 2 (`fromCorpus` in algebra + shared prefix + pinned warnings order) with its
   golden-result and deep-freeze pins — separately mergeable.

Each of 1–5 is independently green; 4 depends on 1–3; 5 is independent; 6 depends on 4.

## 12. Audit amendments (2026-07-06)

Three parallel adversarial audits (code-reality/repo-pattern; DRY/SRP/API;
domain-correctness). All findings below are folded into the sections cited.

**Binding**

- **A1 — Sealed `{sigmas, hints}` pair** (DRY, domain): the draft's two-invocation
  surface (`buildFilterSigmas` + separate `leafHintsOf(buildFilterPredicates(...))`)
  reintroduced the drift channel it claimed to close — divergent `family` arguments could
  produce a hint narrower than σ with no error. Folded: §4 `buildFilterPlan` returns both
  from one predicate list; `buildFilterSigmas` retired (not barrel-exported, free to
  migrate).
- **A2 — Phase 2 warnings order** (all three lenses, independently): computing the safety
  warnings before the ranked suffix would reorder `RecallResult.warnings`
  (alias → cardinality → coverage instead of today's alias → coverage → cardinality) — a
  byte-visible diff the §8.3 differential cannot catch once both sides are restructured.
  Folded: §5 buffer-and-append-at-current-position mandate + golden pre-restructure
  regression test + safety check keeps its own try/catch.
- **A3 — Differential test must pin `asOf`** (domain): unpinned, each side takes its own
  `Date.now()` (anchoring τ_valid and the recency blend) — flaky by construction. Folded:
  §6, §8.3.

**Minor**

- **A4 — `key`+`keys` both-set is reachable** (all three): "callers never set both" was
  false under the spec's own fold (`keyEq` ∧ `keyIn` → both fields). Folded: §3.1
  AND-intersection contract; §8.1/§8.2 both-set cases.
- **A5 — Empty-`keys` boundary** (domain): plan-level `keys: []` matches everything;
  σ `keyIn([])` matches nothing — the §8.2 equivalence was false at the boundary. Folded:
  §3.1 (leafHintsOf omits the field; divergence documented), §8.2 carve-out.
- **A6 — Purity gate retargeted** (DRY, code-reality, domain): the draft gated Phase 2 on
  `oplusDedupe` purity (irrelevant — it runs once inside the prefix) with a fallback
  identical to the proposal ("gate decided nothing"); the audit verified purity on
  today's source. Folded: §5 — purity is a verified fact with a deep-freeze *pin*
  (freezing claim objects, not just the array); ordering discipline is the mandatory
  invariant; "or drop it" deleted.
- **A7 — `fromCorpus` home** (DRY): no prebuilt-corpus stage exists anywhere; define it
  in `src/algebra/expression.ts`, not inline in `recall.ts`. Folded: §5.
- **A8 — `LeafHints` placement + idiom** (DRY, code-reality): the draft defined it in
  `expression.ts` while claiming `pushdown.ts` imports only predicate/adapter types
  (self-inconsistent); repo has no `Pick<` and doesn't export `ExecutionPlan`. Folded:
  §3.3 — both live in `pushdown.ts`; the `Pick` is kept deliberately (hand-copied
  interface = drift channel) and the choice is documented.
- **A9 — `warmRecallValues` unification** (DRY): the warm path hand-rolls the family
  fan-out `keys` expresses; the draft marked it "unchanged" without noting the
  simplification. Folded: §4.
- **A10 — Problem framing understated** (code-reality): unhinted leaf hydrates *all*
  claims including deprecated (no status condition), not just "live"; and the warm/alias
  reads are pushed-down but not index-backed for key-only recalls until §7 lands. Folded:
  §1, §7.
- **A11 — `plan.corpusId` is dead** (domain): neither adapter compiles it; isolation is
  `scoped()`-enforced and hints can only AND-narrow. Folded: §3.1.
- **A12 — pg equality restated broader-only** (domain): "SQL `TEXT =` matches JS `===`
  exactly" is collation-fragile on pg; the config-independent invariant is byte-identical
  strings compare equal under every collation ⇒ SQL never matches fewer rows ⇒ hints never
  narrower. Folded: §4.
- Citation/precedent fixes (code-reality): `expression.ts:72` (was :73); fast-check
  precedent is `src/distribution/*.property.test.ts` (not the algebra suite); `keys`
  conformance lives in the shared `src/adapters/adapter-contract.ts` (invoked by
  `conformance.pg.test.ts`), pg builder unit tests in `postgres/sql.test.ts`. Folded:
  §2, §8.
- Phase 2 snapshot-consistency under concurrency documented as an intended improvement
  (domain). Folded: §5.
