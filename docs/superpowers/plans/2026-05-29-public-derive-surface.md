# Public derive surface (`mneme.derive`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a public `mneme.derive(corpusId, expr, opts)` method (returning `{ id, status }`) that commits a derived claim, and update the epistemic quickstart to demonstrate `derive → replay → exact`.

**Architecture:** `derive` orchestrates the existing internal `deriveClaimFrom` (compiles the `ExprNode`, records `queryExpression`/`corpusState`/inputs/versions onto a `CandidateClaim`) and `commitDerived` (commits via the corpus promoter), threading `createMneme`'s own `adapter`, `catalog`, and `promoterFor(corpusId)` — same pattern as `mneme.replay`. The lower-level functions stay internal.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, better-sqlite3.

Driving spec: `docs/superpowers/specs/2026-05-29-public-derive-surface-design.md`. The `derive → replay → exact` behavior (with a key-excluded query) was empirically verified against the real library before this plan.

---

### Task 1: Add `mneme.derive` method (TDD)

**Files:**
- Modify: `src/mneme.ts`
- Test: `src/mneme.test.ts`

- [ ] **Step 1: Write the failing tests** — append to `src/mneme.test.ts` (the file already imports `createMneme`, `createSqliteAdapter`, and defines `corpusDef` for `"workspace:canopy"`; add the ast import at the top of the file):

Add this import near the other imports at the top of `src/mneme.test.ts`:

```ts
import { leaf as astLeaf, sigma as astSigma } from "./algebra/ast.js";
```

Append these tests at the end of the file:

```ts
// ── derive surface ────────────────────────────────────────────────────────────

function statusMemory(value: string, alpha: number) {
  return {
    profile: "profile-1" as any,
    workspace: "workspace:canopy" as any,
    subject: "host",
    key: "status",
    scope: {},
    value,
    confidence: { distribution: "beta", parameters: { alpha, beta: 1 }, raw: alpha / (alpha + 1) },
    valid: { from: 0, to: Infinity },
    source: "manual",
    provenance: {},
    evidence: [],
    tags: [],
    schema: "workspace:canopy@1",
  } as any;
}

it("derive commits a derived claim that replays to exact", () => {
  const adapter = createSqliteAdapter();
  const m = createMneme({ adapter, availableTiers: [{ kind: "core" }] });
  m.createCorpus(corpusDef);

  // Seed two source "status" claims.
  m.commit("workspace:canopy", statusMemory("healthy", 8), { writer: "probe" });
  m.commit("workspace:canopy", statusMemory("degraded", 5), { writer: "probe" });

  // Derive a summary from the "status" claims. The derived key ("status.summary") is NOT
  // selected by the query, so re-execution reproduces the same representative → exact.
  const expr = astSigma({ op: "keyEq", value: "status" }, astLeaf("workspace:canopy"));
  const res = m.derive("workspace:canopy", expr, {
    subject: "host",
    key: "status.summary",
    scope: {},
    writer: "rollup",
    evaluationClock: 1234,
  });

  expect(res.status).toBe("committed");
  expect(typeof res.id).toBe("string");

  const claim = m.readByIds("workspace:canopy", [res.id as any])[0];
  expect(m.replay(claim).status).toBe("exact");
});

it("derive throws on an unknown corpus", () => {
  const m = createMneme({ adapter: createSqliteAdapter(), availableTiers: [{ kind: "core" }] });
  expect(() =>
    m.derive("nonexistent", astLeaf("nonexistent"), {
      subject: "s",
      key: "k",
      scope: {},
      writer: "w",
    }),
  ).toThrow();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/mneme.test.ts -t "derive"`
Expected: FAIL — `m.derive is not a function`.

- [ ] **Step 3: Add the imports to `src/mneme.ts`**

After the existing `import { replayStatus, type ReplayResult } from "./write/replay.js";` line, add:

```ts
import { deriveClaimFrom } from "./write/derive.js";
import { commitDerived } from "./write/derived-write.js";
import type { ExprNode } from "./algebra/ast.js";
import type { Scope } from "./core/scope.js";
```

- [ ] **Step 4: Add `derive` to the `Mneme` interface**

In the `export interface Mneme { ... }` block, immediately after the `replay(claim: Claim): ReplayResult;` line, add:

```ts
  /**
   * Derive and commit a claim from an algebra expression, recording the serialized query
   * as provenance so it can later be re-executed via `replay`. Threads this instance's
   * adapter / catalog / corpus promoter.
   *
   * For `replay` to return `exact`, choose a query that does NOT re-select the derived
   * claim itself (e.g. derive under a `key` the query's predicate excludes) — otherwise
   * re-execution includes the derived claim and the comparison may mismatch.
   */
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

- [ ] **Step 5: Add the `derive` implementation to the `createMneme` return object**

Immediately after the `replay(claim: Claim): ReplayResult { ... }` method in the returned object, add:

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
    ): { id: string; status: string } {
      catalog.getCorpus(corpusId); // existence check — throws for unknown corpus
      const candidate = deriveClaimFrom(adapter, catalog, expr, {
        subject: opts.subject,
        key: opts.key,
        scope: opts.scope,
        combination: opts.combination,
        evaluationClock: opts.evaluationClock,
      });
      const df = candidate.provenance!.derivedFrom!; // deriveClaimFrom always sets this
      return commitDerived(promoterFor(corpusId), candidate, {
        queryExpression: df.queryExpression,
        corpusState: df.corpusState,
        writer: opts.writer,
        policy: opts.policy,
        idempotencyKey: opts.idempotencyKey,
      });
    },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/mneme.test.ts -t "derive"`
Expected: PASS (both derive tests).

- [ ] **Step 7: Run the full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: suite PASS (two more tests than before); `tsc` clean.

- [ ] **Step 8: Commit (EXPLICIT paths; `git status` first; never `git add -A`):**

```bash
git add src/mneme.ts src/mneme.test.ts
git commit -m "feat(mneme): add derive() — commit a derived claim from an ExprNode"
```

---

### Task 2: Show derive → replay → exact in the quickstart example

**Files:**
- Modify: `examples/quickstart.ts`
- Test: `examples/quickstart.test.ts`

- [ ] **Step 1: Add the failing assertion** — in `examples/quickstart.test.ts`, add this line inside the existing `it("quickstart runs end-to-end on the public surface", ...)` block, after the existing `replayStatusOfPlainClaim` assertion:

```ts
  // step 7: a derived claim re-executes to exact
  expect(r.derivedReplayStatus).toBe("exact");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run examples/quickstart.test.ts`
Expected: FAIL — `r.derivedReplayStatus` is `undefined` (not `"exact"`).

- [ ] **Step 3: Add `astLeaf` and `astSigma` to the quickstart imports**

In `examples/quickstart.ts`, the value import from `../src/index.js` currently lists `createMneme, createSqliteAdapter, pipe, leaf, sigma, rho, kappa, delta`. Add `astLeaf, astSigma` to that list:

```ts
import {
  createMneme,
  createSqliteAdapter,
  pipe,
  leaf,
  sigma,
  rho,
  kappa,
  delta,
  astLeaf,
  astSigma,
} from "../src/index.js";
```

- [ ] **Step 4: Add `derivedReplayStatus` to the result interface**

In the `QuickstartResult` interface, after `replayStatusOfPlainClaim: string;` add:

```ts
  derivedReplayStatus: string;
```

- [ ] **Step 5: Add the derive→replay step and return the new field**

Replace this block:

```ts
  // 6. Reproducibility / replay. A normal committed claim has no recorded query, so replay
  //    reports integrity_unknown. Claims DERIVED from a recorded query re-execute to
  //    exact / mismatch (see the replay-engine design doc).
  const replayStatusOfPlainClaim = mneme.replay(web02).status;

  return {
    committedId: committed.id,
    contextIncludesValue,
    supersededOldStatus,
    replacementValue,
    rawConfidence,
    effectiveAfterDecay,
    replayStatusOfPlainClaim,
  };
}
```

with:

```ts
  // 6. Reproducibility / replay. A normal committed claim has no recorded query, so replay
  //    reports integrity_unknown.
  const replayStatusOfPlainClaim = mneme.replay(web02).status;

  // 7. Derive a claim from a recorded query, then verify it re-executes to "exact".
  //    The query selects host:web-02's "status"; the derived key is "status.summary", so
  //    re-execution never re-selects the derived claim itself (which would pollute the check).
  const derived = mneme.derive(
    CORPUS,
    astSigma(
      { op: "and", preds: [{ op: "subjectEq", value: "host:web-02" }, { op: "keyEq", value: "status" }] },
      astLeaf(CORPUS),
    ),
    { subject: "host:web-02", key: "status.summary", scope: {}, writer: "rollup", evaluationClock: 1234 },
  );
  const derivedReplayStatus = mneme.replay(
    mneme.readByIds(CORPUS, [derived.id as never])[0],
  ).status;

  return {
    committedId: committed.id,
    contextIncludesValue,
    supersededOldStatus,
    replacementValue,
    rawConfidence,
    effectiveAfterDecay,
    replayStatusOfPlainClaim,
    derivedReplayStatus,
  };
}
```

- [ ] **Step 6: Add the new field to the printed trace**

Replace this line:

```ts
  console.log(`  replay(plain claim) status:           ${r.replayStatusOfPlainClaim}`);
```

with:

```ts
  console.log(`  replay(plain claim) status:           ${r.replayStatusOfPlainClaim}`);
  console.log(`  replay(derived claim) status:         ${r.derivedReplayStatus}`);
```

- [ ] **Step 7: Run the test, then the example, then the full suite**

Run: `npx vitest run examples/quickstart.test.ts`
Expected: PASS.

Run: `npm run example`
Expected: the trace now ends with a line `replay(derived claim) status:         exact`.

Run: `npx vitest run && npx tsc --noEmit`
Expected: suite PASS; `tsc` clean.

- [ ] **Step 8: Commit:**

```bash
git add examples/quickstart.ts examples/quickstart.test.ts
git commit -m "docs(examples): show derive -> replay -> exact in the quickstart"
```

---

### Task 3: Update README step 6 to show derive → replay → exact

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace the step-6 block**

Find this section in `README.md`:

````markdown
### 6. Verify reproducibility with replay

```ts
mneme.replay(claim).status;
// A plain committed claim has no recorded query → "integrity_unknown".
// Claims derived from a recorded query re-execute to "exact" / "mismatch".
```
````

Replace it with:

````markdown
### 6. Verify reproducibility with replay

A plain committed claim has no recorded query, so `replay` reports `integrity_unknown`:

```ts
mneme.replay(claim).status; // "integrity_unknown"
```

A claim produced by `mneme.derive` records its query, so it re-executes and is verified —
`exact` if it reproduces, `mismatch` if the inputs changed. Pick a query that doesn't
re-select the derived claim itself (here the derived `status.summary` is excluded by the
`status` filter):

```ts
import { astLeaf, astSigma } from "mneme";

const { id } = mneme.derive(
  "infra:prod",
  astSigma(
    { op: "and", preds: [{ op: "subjectEq", value: "host:web-02" }, { op: "keyEq", value: "status" }] },
    astLeaf("infra:prod"),
  ),
  { subject: "host:web-02", key: "status.summary", scope: {}, writer: "rollup" },
);

const derived = mneme.readByIds("infra:prod", [id])[0];
mneme.replay(derived).status; // "exact"
```
````

- [ ] **Step 2: Sanity-check**

Run: `node -e "const fs=require('fs'); const t=fs.readFileSync('README.md','utf8'); if(!t.includes('mneme.derive')||!t.includes('\"exact\"')) throw new Error('derive section missing'); console.log('README ok');"`
Expected: prints `README ok`.

- [ ] **Step 3: Commit:**

```bash
git add README.md
git commit -m "docs: show derive -> replay -> exact in README step 6"
```

---

## Notes for the implementer

- **Public surface.** The example and README import only from the package root (`../src/index.js` / `"mneme"`). `astLeaf` / `astSigma` are the already-exported AST constructors (aliased because `leaf`/`sigma` are taken by the stage-builders). Internal tests in `src/mneme.test.ts` import the ast constructors from `./algebra/ast.js` directly.
- **`as never` / `as any` casts** on candidate objects mirror existing test/example conventions — keep them.
- **Why the derived claim replays to `exact`:** `deriveClaimFrom` copies the representative (last claim of the evaluated corpus) into the derived claim; re-execution reproduces that same representative because the query excludes the derived key. This was verified empirically before the plan. If a derive test/example reports `mismatch` instead of `exact`, the query is re-selecting the derived claim — STOP and report rather than weakening the assertion.
- `mneme.replay` and the existing quickstart already exist on this branch (it is off post-#5/#6 `main`).
