---
title: resolve-deprecate-older
created: 2026-06-05
---

```mermaid
flowchart TD
    task-resolution["task-resolution: pairwise resolution engine with honest ties<br/>files: src/algebra/resolution.ts +1 more"]
    task-spec-amendment["task-spec-amendment: canonical spec amendment for §4.8<br/>files: mneme-spec-v0.2-consolidated.md"]
    task-registry["task-registry: registry registration for resolveDeprecateOlder<br/>files: src/algebra/registries.ts +2 more"]
    task-bench["task-bench: bench adoption of the upstreamed resolver<br/>files: bench/longmemeval/answer.ts +2 more"]

    task-resolution --> task-registry
    task-resolution --> task-bench

    classDef done fill:#90ee90,stroke:#333
    classDef ready fill:#fffacd,stroke:#333
    classDef running fill:#87ceeb,stroke:#333
    classDef failed fill:#ffb6c1,stroke:#333
    classDef skipped fill:#d3d3d3,stroke:#333,stroke-dasharray: 5 5
```

## Context

Driven by `docs/superpowers/specs/2026-06-05-resolve-deprecate-older-design.md`
(slice 1 of 4 from the LongMemEval adversarial-probe findings): upstream a
latest-wins pairwise resolver (`resolveDeprecateOlder`) and pin honest tie semantics
(exact tie ⇒ keep both + flag artifact) for BOTH pairwise deprecation resolvers via a
single shared engine. This is a **specification addition** (tie semantics were never
spec-pinned); §4.9's `⊕` tie-breaks and cluster-level tie-breaks are explicitly
untouched; the write path (`src/write/contradiction.ts:enforce()`) is independent and
unaffected.

Confirmed seams (audited; do not re-derive): registry shape
`{ fn, input: "pairs" }` (`src/algebra/registries.ts:29-36`); registry name-list test
(`src/algebra/registries.test.ts:4-10`); compile coverage pattern
(`src/algebra/compile.test.ts:496-569`); artifact construction inline in
`resolveFlagForReview` (`src/algebra/resolution.ts:71-101`, status `"candidate"`);
the lexicographic tie test to rewrite (`src/algebra/resolution.test.ts:48-57`);
`makeClaim` test-stub bug `valid: { start: null, end: null }`
(`src/algebra/resolution.test.ts:~26`); bench-local resolver to delete
(`bench/longmemeval/answer.ts:22-49`).

## Tasks

## Task: pairwise resolution engine with honest ties

```yaml
id: task-resolution
depends_on: []
files:
  - src/algebra/resolution.ts
  - src/algebra/resolution.test.ts
status: pending
```

The slice's core, one cohesive module reshape per spec §1–§3: shared
`deprecatePairwise` engine, `flagArtifactFor` helper + `CONTRADICTION_FLAG_KEY`
constant, new `resolveDeprecateOlder`, and `resolveDeprecateLower` reduced to a
comparator with the new tie semantics. `resolveFlagForReview` refactors onto the
helper with unchanged behavior. Public signatures stay `(pairs) => (corpus) => Corpus`.

## Implementation

```typescript
// src/algebra/resolution.ts (reshaped — load-bearing shapes)
export const CONTRADICTION_FLAG_KEY = "contradiction.flag";

/** Extracted from resolveFlagForReview; one artifact per pair, status "candidate". */
const flagArtifactFor = (p: ContradictionPair): Claim => { /* … key: CONTRADICTION_FLAG_KEY … */ };

/**
 * Engine: partition pairs by loserOf; deprecate losers; for tied pairs whose members
 * BOTH survive this pass, append one flag artifact each. Tied pairs with a member
 * deprecated by a decided pair emit nothing (conflict already resolved).
 */
const deprecatePairwise =
  (pairs: ContradictionPair[], loserOf: (p: ContradictionPair) => string | "tie") =>
  (corpus: Corpus): Corpus => {
    const losers = new Set<string>();
    const tied: ContradictionPair[] = [];
    for (const p of pairs) {
      const l = loserOf(p);
      if (l === "tie") tied.push(p);
      else losers.add(l);
    }
    const artifacts = tied
      .filter((p) => !losers.has(p.left.id) && !losers.has(p.right.id))
      .map(flagArtifactFor);
    const next = deprecate(corpus, losers);
    return artifacts.length ? corpusOf([...next.claims, ...artifacts]) : next;
  };

/** Confidence comparator: lower pointEstimate loses; exact tie ⇒ "tie". */
export const resolveDeprecateLower = (pairs: ContradictionPair[]) =>
  deprecatePairwise(pairs, (p) => {
    const l = pointEstimate(p.left.confidence);
    const r = pointEstimate(p.right.confidence);
    return l < r ? p.left.id : r < l ? p.right.id : "tie";
  });

/** Recency comparator: earlier valid.from loses; exact tie ⇒ "tie". [C] */
export const resolveDeprecateOlder = (pairs: ContradictionPair[]) =>
  deprecatePairwise(pairs, (p) => {
    const l = p.left.valid.from;
    const r = p.right.valid.from;
    return l < r ? p.left.id : r < l ? p.right.id : "tie";
  });

/** Unchanged behavior, now built on flagArtifactFor. */
export const resolveFlagForReview = (pairs: ContradictionPair[]) =>
  (corpus: Corpus): Corpus => corpusOf([...corpus.claims, ...pairs.map(flagArtifactFor)]);
```

```typescript
// src/algebra/resolution.test.ts — failing test anchoring the new tie semantics
it("resolveDeprecateLower with tie keeps both claims and adds one flag artifact", () => {
  const claimA = makeClaim("claim-aaa", 5, 5, "validated"); // equal pointEstimate
  const claimB = makeClaim("claim-bbb", 5, 5, "validated");
  const out = resolveDeprecateLower([{ left: claimA, right: claimB, conflictReason: "value-difference" }])(
    corpusOf([claimA, claimB]),
  );
  const statuses = out.claims.filter((c) => c.key !== CONTRADICTION_FLAG_KEY).map((c) => c.status);
  expect(statuses).toEqual(["validated", "validated"]); // neither deprecated
  expect(out.claims.filter((c) => c.key === CONTRADICTION_FLAG_KEY)).toHaveLength(1);
});
```

PRE-STEP (test infra, same task): fix `makeClaim` to build
`valid: { from: 0, to: Infinity }` with an overridable `from` (the current
`{ start: null, end: null }` stub has wrong Interval field names), so recency tests
exercise real numeric `valid.from`.

## Acceptance criteria

- `resolveDeprecateOlder`: later `valid.from` survives per pair; earlier becomes
  `"deprecated"`; 3-way chain (A<B<C across pairs) leaves only C live.
- Exact `valid.from` tie ⇒ both claims keep their status and exactly one artifact per
  tied-surviving pair is appended (property: artifact count == tied pairs whose
  members both survive).
- Deprecation-beats-tie: when a decided pair deprecates a member of a tied pair, that
  tied pair emits NO artifact.
- `resolveDeprecateLower`: the lexicographic tie test (resolution.test.ts:48–57) is
  rewritten to the new expectation (both live + one artifact); all non-tie tests pass
  unchanged.
- `resolveFlagForReview`: existing tests pass unchanged; asserts now reference
  `CONTRADICTION_FLAG_KEY`.
- Input corpus is not mutated (same claims array reference check on input).
- Artifacts carry `key === CONTRADICTION_FLAG_KEY`, `subject "contradiction"`,
  `status "candidate"`, and both conflicting claim ids.

Test file: `src/algebra/resolution.test.ts`.

## Task: canonical spec amendment for §4.8

```yaml
id: task-spec-amendment
depends_on: []
files:
  - mneme-spec-v0.2-consolidated.md
status: pending
is_wiring_task: true
```

Registers the new operator and the now-pinned tie semantics in the canonical spec, per
design §5. In §4.8's resolution-operator list (~line 752): add
`resolve_deprecate_older : Set<ContradictionPair> × Corpus → Corpus` (unbadged, like
the other pairwise resolvers — implicitly core per §0.2) with recency semantics
(later `valid.from` survives). Add a short tie-semantics paragraph covering BOTH
pairwise deprecation resolvers: exact tie ⇒ keep both + one `contradiction.flag`
artifact; inline rationale (a tie means the ordering criterion cannot decide; a silent
arbitrary pick masquerades as a resolution); note this pins previously-unspecified
semantics; note cluster-level tie-breaks and §4.9 `⊕` tie-breaks are unchanged (the
latter are load-bearing for idempotence/associativity); note a per-corpus
`tieBehavior` override would belong in CorpusDefaults (§3.3) if ever needed. Match the
surrounding section's prose style and operator-listing format exactly.

## Acceptance criteria

- §4.8 lists `resolve_deprecate_older` with the signature above, adjacent to the other
  pairwise resolvers, in matching format.
- The tie-semantics paragraph covers both pairwise deprecation resolvers, the
  rationale, the spec-addition framing, and the explicit §4.9/cluster non-changes.
- No other normative text altered (diff touches only the §4.8 vicinity).

Test file: none new — verified by reading the diff (`git diff -- mneme-spec-v0.2-consolidated.md`) and `npm test` staying green (no code referenced).

## Task: registry registration for resolveDeprecateOlder

```yaml
id: task-registry
depends_on: [task-resolution]
files:
  - src/algebra/registries.ts
  - src/algebra/registries.test.ts
  - src/algebra/compile.test.ts
status: pending
```

Wire the new resolver into the name-keyed registry that replay/serialization consume,
plus coverage in both test surfaces.

## Implementation

```typescript
// src/algebra/registries.ts — one import + one entry
import { resolveDeprecateOlder /* … existing … */ } from "./resolution.js";

const RESOLUTIONS: Record<string, ResolutionEntry> = {
  /* … existing six … */
  resolveDeprecateOlder: { fn: resolveDeprecateOlder, input: "pairs" },
};
```

```typescript
// src/algebra/registries.test.ts — failing test
it("resolutionRegistry resolves resolveDeprecateOlder as a pairs resolver", () => {
  expect(resolutionRegistry("resolveDeprecateOlder").input).toBe("pairs");
});
// and add "resolveDeprecateOlder" to the names validation list (lines 4–10).
```

Compile/replay coverage: add a `resolveDeprecateOlder` case in
`src/algebra/compile.test.ts` following the existing resolver-coverage shape at
lines 496–569 (serialize → compile → execute on a corpus with a superseding pair;
assert the older claim is deprecated after the round trip).

## Acceptance criteria

- `resolutionRegistry("resolveDeprecateOlder")` returns `{ fn, input: "pairs" }`.
- The registry name-list test includes the new name (7 resolvers).
- Compile/replay round trip executes the new resolver and deprecates the older claim.

Test file: `src/algebra/registries.test.ts` (plus the case in `src/algebra/compile.test.ts`).

## Task: bench adoption of the upstreamed resolver

```yaml
id: task-bench
depends_on: [task-resolution]
files:
  - bench/longmemeval/answer.ts
  - bench/longmemeval/answer.test.ts
  - bench/longmemeval/manual/adversarial-probe.ts
status: pending
```

Pay down the documented bench-local debt: delete the local copy, import the upstreamed
resolver and key constant, and align tests/probe with the new tie semantics.

## Implementation

```typescript
// bench/longmemeval/answer.ts
import { resolveDeprecateOlder, CONTRADICTION_FLAG_KEY } from "../../src/algebra/resolution.js";
// DELETE the local resolveDeprecateOlder (lines ~22–49) and its JSDoc.

// arm A post-resolve filter gains the artifact exclusion:
(c: Corpus) => filterCorpus(c, (cl) => cl.status !== "deprecated" && cl.key !== CONTRADICTION_FLAG_KEY),
```

```typescript
// bench/longmemeval/answer.test.ts — the tie test's NEW expectation (failing first)
it("breaks ties by keeping both claims and flagging, not by lexicographic deprecation", () => {
  // same-valid.from conflicting pair seeded as before (former lines ~111+)
  const out = resolveDeprecateOlder([pair])(corpusOf([claimAlpha, claimBeta]));
  expect(out.claims.filter((c) => c.key !== CONTRADICTION_FLAG_KEY).every((c) => c.status !== "deprecated")).toBe(true);
  expect(out.claims.some((c) => c.key === CONTRADICTION_FLAG_KEY)).toBe(true);
});
```

Probe text: `bench/longmemeval/manual/adversarial-probe.ts` case 5's `expectation`
string becomes "tie ⇒ both values returned + flagged for review (no arbitrary
winner)" — and verify by running the probe that arm A now returns both coffee values.

## Acceptance criteria

- No local `resolveDeprecateOlder` remains in bench (grep clean); imports come from
  `src/algebra/resolution.js`.
- Arm A results never contain `contradiction.flag` artifacts (tie case asserted in
  answer.test.ts).
- The former lexicographic tie test is rewritten to the keep-both+flag expectation.
- Probe 5 run output shows arm A returning both tied values; expectation text updated.
- `npm run eval:lme:fixture` still exits 0 (no fixture data has ties — regression
  guard).

Test file: `bench/longmemeval/answer.test.ts`.
