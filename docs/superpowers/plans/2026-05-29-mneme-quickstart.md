# Mneme Quickstart (Epistemic Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a getting-started `README.md` plus a tested, runnable `examples/quickstart.ts` that drives Mneme's public surface through the service/host-monitoring scenario (commit → query → Beta confidence → contradiction via supersede → decay → replay).

**Architecture:** `examples/quickstart.ts` is the canonical code — it exports a deterministic-assertion `runQuickstart()` and has a guarded script entry that prints a trace. `examples/quickstart.test.ts` runs `runQuickstart()` and asserts outcomes so the example can't rot. `README.md` shows annotated excerpts of the same code. The example imports the public surface via `../src/index.js` (the package-root module).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, tsx (added for `npm run example`), better-sqlite3 in-memory adapter.

Driving spec: `docs/superpowers/specs/2026-05-29-mneme-quickstart-design.md`.

---

### Task 1: Enable example-test discovery

**Files:**
- Modify: `vitest.config.ts`

- [ ] **Step 1: Add the examples glob to the vitest include list**

Edit `vitest.config.ts` so `include` reads:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts", "test/**/*.test.ts", "examples/**/*.test.ts"],
  },
});
```

- [ ] **Step 2: Verify the suite still passes (no example test exists yet)**

Run: `npx vitest run`
Expected: PASS — same green suite as before (the new glob matches nothing yet).

- [ ] **Step 3: Commit**

```bash
git add vitest.config.ts
git commit -m "test: discover example tests under examples/"
```

---

### Task 2: Quickstart example + test (TDD)

**Files:**
- Create: `examples/quickstart.ts`
- Test: `examples/quickstart.test.ts`

- [ ] **Step 1: Write the failing test**

Create `examples/quickstart.test.ts`:

```ts
import { runQuickstart } from "./quickstart.js";

it("quickstart runs end-to-end on the public surface", () => {
  const r = runQuickstart();

  // step 2: a claim was committed
  expect(typeof r.committedId).toBe("string");
  expect(r.committedId.length).toBeGreaterThan(0);

  // step 3: the composed context contains the claim value
  expect(r.contextIncludesValue).toBe(true);

  // step 4: contradiction resolved via supersede
  expect(r.supersededOldStatus).toBe("deprecated");
  expect(r.replacementValue).toBe("degraded");

  // step 5: decay lowered effective confidence below raw
  expect(r.effectiveAfterDecay).toBeLessThan(r.rawConfidence);

  // step 6: replay of a plain (non-derived) claim
  expect(r.replayStatusOfPlainClaim).toBe("integrity_unknown");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run examples/quickstart.test.ts`
Expected: FAIL — cannot resolve `./quickstart.js` (module does not exist yet).

- [ ] **Step 3: Write the example implementation**

Create `examples/quickstart.ts`:

```ts
/**
 * Mneme quickstart — service/host status monitoring.
 *
 * In a real project you would import from the published package:
 *     import { createMneme, createSqliteAdapter, pipe, leaf, sigma, rho, kappa, delta } from "mneme";
 * Here we import the package-root module directly so the example runs in-repo.
 */
import { fileURLToPath } from "node:url";
import {
  createMneme,
  createSqliteAdapter,
  pipe,
  leaf,
  sigma,
  rho,
  kappa,
  delta,
} from "../src/index.js";
// index.ts exports the catalog corpus as `CorpusDef` and the algebra corpus as `Corpus`.
import type { CorpusDef, ComposedContext, Corpus } from "../src/index.js";

export interface QuickstartResult {
  committedId: string;
  contextIncludesValue: boolean;
  supersededOldStatus: string;
  replacementValue: string;
  rawConfidence: number;
  effectiveAfterDecay: number;
  replayStatusOfPlainClaim: string;
}

const CORPUS = "infra:prod";

const corpusDef: CorpusDef = {
  id: CORPUS,
  displayName: "Production Infrastructure",
  schema: {
    version: "1",
    subjects: ["host:web-01", "host:web-02"],
    scopeFields: {},
    required: [],
    scalarPseudocount: {},
  },
  defaults: {
    decayPolicy: { kind: "none" },
    confidenceThreshold: 0,
    contradictionPolicy: { kind: "always_accept" },
    defaultStatus: ["validated"],
  },
  requiredTiers: [{ kind: "core" }],
  metadata: {},
  createdAt: 0,
  updatedAt: 0,
};

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function runQuickstart(): QuickstartResult {
  // 1. Construct: an in-memory store + a corpus (a namespaced claim store).
  const adapter = createSqliteAdapter(":memory:");
  const mneme = createMneme({ adapter, availableTiers: [{ kind: "core" }] });
  mneme.createCorpus(corpusDef);

  // 2. Commit a claim. confidence is a Beta distribution {alpha, beta}: 8 of 9
  //    recent probes saw host:web-01 healthy, so we have strong-but-not-certain evidence.
  const committed = mneme.commit(
    CORPUS,
    {
      profile: "ops",
      workspace: CORPUS,
      subject: "host:web-01",
      key: "status",
      scope: {},
      value: "healthy",
      confidence: { distribution: "beta", parameters: { alpha: 8, beta: 1 }, raw: 8 / 9 },
      valid: { from: 0, to: Infinity },
      source: "manual",
      provenance: {},
      evidence: [],
      tags: [],
      schema: `${CORPUS}@1`,
    } as never,
    { writer: "healthcheck" },
  );

  // 3. Query it back as an LLM/report-ready, token-bounded context (select → rank → compose).
  const ctx = mneme.query<ComposedContext>(
    CORPUS,
    pipe(
      leaf(CORPUS),
      sigma({ op: "subjectEq", value: "host:web-01" }),
      rho.jaccard("web-01 status"),
      kappa.markdown(2000),
    ),
  );
  const contextIncludesValue = ctx.content.includes("healthy");

  // 4. Contradiction → resolve. Fresh probes flip web-01 to "degraded". supersede deprecates
  //    the old claim and commits the replacement — belief change is explicit and auditable.
  const sup = mneme.supersede(
    CORPUS,
    committed.id,
    {
      profile: "ops",
      workspace: CORPUS,
      subject: "host:web-01",
      key: "status",
      scope: {},
      value: "degraded",
      confidence: { distribution: "beta", parameters: { alpha: 5, beta: 4 }, raw: 5 / 9 },
      valid: { from: 0, to: Infinity },
      source: "manual",
      provenance: {},
      evidence: [],
      tags: [],
      schema: `${CORPUS}@1`,
    } as never,
    { writer: "healthcheck" },
  );
  const oldClaim = mneme.readByIds(CORPUS, [committed.id as never])[0];
  const supersededOldStatus = oldClaim.status; // "deprecated"
  const replacement = mneme.readByIds(CORPUS, [sup.id as never])[0];
  const replacementValue = replacement.value as string; // "degraded"

  // 5. Decay over time. Commit a second host's status, then query it under an exponential
  //    decay policy at a clock 30 days after it was recorded — effective confidence drops as
  //    the reading goes stale. The pinned evaluationClock makes this deterministic.
  const c2 = mneme.commit(
    CORPUS,
    {
      profile: "ops",
      workspace: CORPUS,
      subject: "host:web-02",
      key: "status",
      scope: {},
      value: "healthy",
      confidence: { distribution: "beta", parameters: { alpha: 9, beta: 1 }, raw: 0.9 },
      valid: { from: 0, to: Infinity },
      source: "manual",
      provenance: {},
      evidence: [],
      tags: [],
      schema: `${CORPUS}@1`,
    } as never,
    { writer: "healthcheck" },
  );
  const web02 = mneme.readByIds(CORPUS, [c2.id as never])[0];
  const decayed = mneme.query<Corpus>(
    CORPUS,
    pipe(leaf(CORPUS), sigma({ op: "subjectEq", value: "host:web-02" }), delta.exponential(7)),
    { evaluationClock: web02.recorded + THIRTY_DAYS_MS },
  );
  const decayedClaim = decayed.claims[0];
  const rawConfidence = decayedClaim.confidence.raw;
  const effectiveAfterDecay = decayedClaim.confidence.effective ?? rawConfidence;

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

// Script entry: `npx tsx examples/quickstart.ts` (or `npm run example`).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = runQuickstart();
  console.log("Mneme quickstart — service/host status monitoring\n");
  console.log(`  committed web-01 status claim:        ${r.committedId}`);
  console.log(`  composed context mentions "healthy":  ${r.contextIncludesValue}`);
  console.log(`  old claim status after supersede:     ${r.supersededOldStatus}`);
  console.log(`  web-01 current status:                ${r.replacementValue}`);
  console.log(`  web-02 raw confidence:                ${r.rawConfidence.toFixed(4)}`);
  console.log(`  web-02 effective after 30d decay:     ${r.effectiveAfterDecay.toFixed(4)}`);
  console.log(`  replay(plain claim) status:           ${r.replayStatusOfPlainClaim}`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run examples/quickstart.test.ts`
Expected: PASS — all assertions green.

- [ ] **Step 5: Run the full suite to confirm nothing else broke**

Run: `npx vitest run`
Expected: PASS — full suite green (822 → 823 tests).

- [ ] **Step 6: Commit**

```bash
git add examples/quickstart.ts examples/quickstart.test.ts
git commit -m "feat(examples): tested runnable quickstart (host-monitoring scenario)"
```

---

### Task 3: Getting-started README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write the README**

Create `README.md` at the repo root:

````markdown
# Mneme

Mneme is an **epistemic store**: it records *claims* (facts with provenance and
uncertainty) instead of plain rows. Confidence is a Beta distribution, not a scalar —
so Mneme tracks *how much evidence* backs a belief. Contradictions are resolved
explicitly, beliefs decay as they go stale, and derived results can be re-executed and
verified.

This quickstart uses a **service/host status monitoring** scenario.

## Install

```bash
npm install
```

## Quickstart

The full, runnable version of the code below lives in
[`examples/quickstart.ts`](examples/quickstart.ts) (run it with `npm run example`).

### 1. Construct a store and a corpus

A *corpus* is a namespaced claim store with a schema and defaults.

```ts
import { createMneme, createSqliteAdapter } from "mneme";

const adapter = createSqliteAdapter(":memory:");
const mneme = createMneme({ adapter, availableTiers: [{ kind: "core" }] });
mneme.createCorpus(corpusDef); // see examples/quickstart.ts for the full definition
```

### 2. Commit a claim (confidence is a distribution)

`confidence` is a Beta `{ alpha, beta }` — here 8 of 9 probes saw the host healthy.

```ts
const committed = mneme.commit("infra:prod", {
  subject: "host:web-01",
  key: "status",
  value: "healthy",
  confidence: { distribution: "beta", parameters: { alpha: 8, beta: 1 }, raw: 8 / 9 },
  // ...profile/workspace/valid/source/provenance/evidence/tags/schema
} as never, { writer: "healthcheck" });
```

### 3. Query it back as a token-bounded context

```ts
import { pipe, leaf, sigma, rho, kappa } from "mneme";

const ctx = mneme.query("infra:prod", pipe(
  leaf("infra:prod"),
  sigma({ op: "subjectEq", value: "host:web-01" }),
  rho.jaccard("web-01 status"),
  kappa.markdown(2000),
));
console.log(ctx.content); // markdown summary, capped at 2000 tokens
```

### 4. Resolve a contradiction with `supersede`

Fresh probes flip the host to `degraded`. The old claim becomes `deprecated`; the
replacement is committed — belief change is explicit and auditable.

```ts
mneme.supersede("infra:prod", committed.id, {
  subject: "host:web-01",
  key: "status",
  value: "degraded",
  confidence: { distribution: "beta", parameters: { alpha: 5, beta: 4 }, raw: 5 / 9 },
  // ...
} as never, { writer: "healthcheck" });
```

### 5. Let stale beliefs decay

Query under an exponential decay policy at a pinned `evaluationClock` — effective
confidence drops as the reading ages. The pinned clock makes the result deterministic.

```ts
import { delta } from "mneme";

const decayed = mneme.query("infra:prod", pipe(
  leaf("infra:prod"),
  sigma({ op: "subjectEq", value: "host:web-02" }),
  delta.exponential(7), // 7-day half-life
), { evaluationClock: recordedAt + THIRTY_DAYS_MS });

const c = decayed.claims[0].confidence;
console.log(c.raw, c.effective); // effective < raw
```

### 6. Verify reproducibility with replay

```ts
mneme.replay(claim).status;
// A plain committed claim has no recorded query → "integrity_unknown".
// Claims derived from a recorded query re-execute to "exact" / "mismatch".
```

## Where to go next

- Replay re-execution engine: `docs/superpowers/specs/2026-05-28-replay-reexecution-engine-design.md`
- The bio (cognitive) layer ships with its own quickstart (coming next).
````

- [ ] **Step 2: Sanity-check the README renders and links resolve**

Run: `node -e "const fs=require('fs'); const t=fs.readFileSync('README.md','utf8'); if(!t.includes('## Quickstart')||!t.includes('examples/quickstart.ts')) throw new Error('README missing key sections'); console.log('README ok');"`
Expected: prints `README ok`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add getting-started README with host-monitoring quickstart"
```

---

### Task 4: Wire `npm run example` (tsx)

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add tsx as a devDependency and an example script**

In `package.json`, add `"example": "tsx examples/quickstart.ts"` to `scripts`, and add `"tsx": "^4.19.0"` to `devDependencies` (create the `devDependencies` block if absent; keep existing entries).

- [ ] **Step 2: Install**

Run: `npm install`
Expected: completes; `node_modules/.bin/tsx` now exists.

- [ ] **Step 3: Run the example and read the trace**

Run: `npm run example`
Expected output (the effective-decay number will vary slightly run-to-run; everything else is fixed):

```
Mneme quickstart — service/host status monitoring

  committed web-01 status claim:        <uuid>
  composed context mentions "healthy":  true
  old claim status after supersede:     deprecated
  web-01 current status:                degraded
  web-02 raw confidence:                0.9000
  web-02 effective after 30d decay:     0.0xxx
  replay(plain claim) status:           integrity_unknown
```

- [ ] **Step 4: Confirm the full suite and typecheck are clean**

Run: `npx vitest run && npx tsc --noEmit`
Expected: suite PASS; `tsc` prints nothing (clean). Note: `examples/` is outside the
`tsconfig` `include` (`src/**`), so the example is validated by execution under vitest/tsx,
not by `tsc`; `tsc --noEmit` stays clean because it ignores `examples/`.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add tsx devDep and npm run example script"
```

---

## Notes for the implementer

- **Public surface only.** The example imports from `../src/index.js` (the package-root module that `index.ts` defines). Do not import internal modules (`../src/catalog/...`, `../src/write/...`) — if something needed isn't exported from `index.ts`, STOP and report it (it's a public-surface gap, not something to work around by reaching inside).
- **`as never` casts** on the commit/supersede candidate objects sidestep the verbose full-`CandidateClaim` shape in example code; this mirrors how `src/mneme.test.ts` uses `as any`. Keep them — the example is teaching the API shape, not the exact type.
- **Determinism.** Only `effectiveAfterDecay` varies run-to-run (claim `recorded` is wall-clock); the test asserts only `effectiveAfterDecay < rawConfidence`, which is always true for a positive age. Do not assert an exact effective value.
- If `mneme.replay` is missing, you are on a branch that predates PR #4 — rebase onto current `main` before implementing.
