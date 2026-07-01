# Operations-Layer Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relocate the domain operations `recall`/`keyCensus`/`remember`/`ensureCorpus`/`listCorpora` (and their types + `EmbeddingState`) out of the transport module `src/mcp/tools.ts` into `src/surface`, making `src/mcp` a thin transport, with `mneme/mcp` re-exporting for back-compat.

**Architecture:** Three coordinated tasks: (1) move the bodies into `src/surface/recall.ts` + `src/surface/remember.ts` and leave `tools.ts` as a temporary re-export shim so nothing breaks; (2) repoint every internal importer to surface, move the tests + test-support, re-point the `mcp/index.ts` barrel; (3) delete the shim and lock the result with a back-compat test and a layering-invariant test. Every task ends green.

**Tech Stack:** TypeScript (ESM, NodeNext), Bun/Node, vitest, better-sqlite3. Run tests with `npx vitest run <path>`, typecheck with `npx tsc --noEmit`.

## Global Constraints

- **Behavior-preserving.** Signatures byte-identical (`recall(session, args, deps)` etc.); no logic changes. Every pre-existing test must pass unchanged.
- **Layering.** After this migration, no file under `src/surface/` or `src/retrieval/` may import from `src/mcp/`. (`src/surface` and `src/mcp` are both `src/<x>/`, so `../algebra/*`, `../retrieval/*`, `../core/*`, `../distribution/*`, `../index.js` relative paths are IDENTICAL from either — only `../surface/*` ⇄ `./*` and `./embeddings.js` paths change.)
- **Back-compat.** `recall`/`remember`/`keyCensus`/`listCorpora`/`ensureCorpus` remain importable from `mneme/mcp` (barrel re-export), so `integrations/openclaw/memory-mneme/*` is never edited.
- **Full-suite gate each task:** `npx vitest run src/mcp/ src/surface/ && npx tsc --noEmit`.

---

### Task 1: Move operations into `src/surface`; leave `tools.ts` as a shim

**Files:**
- Create: `src/surface/recall.ts`, `src/surface/remember.ts`
- Modify: `src/surface/index.ts`, `src/mcp/embeddings.ts`, `src/mcp/tools.ts`
- Test: none new (existing suite is the gate)

**Interfaces:**
- Produces: `src/surface/recall.ts` exports `recall`, `keyCensus`, `parseAsOf`, and types `EmbeddingState`, `RecallDeps`, `RecallArgs`, `RecallMatch`, `RecallResult`, `CensusArgs`, `CensusResult`. `src/surface/remember.ts` exports `remember`, `ensureCorpus`, `listCorpora`, and types `RememberArgs`, `RememberResult`, `ListResult`. All signatures identical to their current `tools.ts` definitions.

- [ ] **Step 1: Create `src/surface/recall.ts`** — move VERBATIM from `src/mcp/tools.ts`: the symbols `RecallDeps`, `parseAsOf`, `RecallArgs`, `RecallMatch`, `RecallResult`, `CensusArgs`, `CensusResult`, `recall`, `keyCensus`; and move the `EmbeddingState` interface VERBATIM from `src/mcp/embeddings.ts`. Adjust ONLY these import lines (all other imports are unchanged — same `../` depth):
  - Delete `import type { EmbeddingState } from "./embeddings.js";` (now defined locally in this file).
  - Replace `import { pipe, leaf, sigma, rho } from "../surface/index.js";` → `import { pipe, leaf, sigma, rho } from "../index.js";`
  - Replace `import type { Session } from "../surface/index.js";` → `import type { Session } from "./types.js";`
  - Replace `import { pointEstimate } from "../surface/index.js";` → `import { pointEstimate } from "../core/confidence.js";`

- [ ] **Step 2: Create `src/surface/remember.ts`** — move VERBATIM from `src/mcp/tools.ts`: `RememberArgs`, `RememberResult`, `remember`, `ensureCorpus`, `ListResult`, `listCorpora`. Adjust ONLY: `import type { Session } from "../surface/index.js";` → `import type { Session } from "./types.js";` (keep all other imports as-is). If `remember`/`ensureCorpus` reference no other `../surface/*` import, no further changes.

- [ ] **Step 3: Re-export from `src/surface/index.ts`** — append:

```ts
export { recall, keyCensus, parseAsOf } from "./recall.js";
export type {
  EmbeddingState, RecallDeps, RecallArgs, RecallMatch, RecallResult, CensusArgs, CensusResult,
} from "./recall.js";
export { remember, ensureCorpus, listCorpora } from "./remember.js";
export type { RememberArgs, RememberResult, ListResult } from "./remember.js";
```

- [ ] **Step 4: Update `src/mcp/embeddings.ts`** — delete the local `EmbeddingState` interface definition and re-export it from surface so its own consumers (e.g. `embeddings.test.ts`) keep resolving:

```ts
export type { EmbeddingState } from "../surface/recall.js";
```

- [ ] **Step 5: Turn `src/mcp/tools.ts` into a re-export shim** — replace its ENTIRE contents with:

```ts
// TEMPORARY back-compat shim during the operations migration (deleted in Task 3).
export { recall, keyCensus, parseAsOf } from "../surface/recall.js";
export type {
  EmbeddingState, RecallDeps, RecallArgs, RecallMatch, RecallResult, CensusArgs, CensusResult,
} from "../surface/recall.js";
export { remember, ensureCorpus, listCorpora } from "../surface/remember.js";
export type { RememberArgs, RememberResult, ListResult } from "../surface/remember.js";
```

- [ ] **Step 6: Run the gate**

Run: `npx vitest run src/mcp/ src/surface/ && npx tsc --noEmit`
Expected: all tests PASS (identical behavior — everything still resolves through the shim), tsc clean.

- [ ] **Step 7: Commit**

```bash
git add src/surface/recall.ts src/surface/remember.ts src/surface/index.ts src/mcp/embeddings.ts src/mcp/tools.ts
git commit -m "refactor(surface): move recall/remember/keyCensus bodies into surface; tools.ts is a shim"
```

---

### Task 2: Repoint internal importers to surface; move tests + barrel

**Files:**
- Modify: `src/mcp/index.ts`, `src/mcp/server.ts`, `src/mcp/embeddings.test.ts`, `src/mcp/engine.test.ts`
- Move: `src/mcp/test-support.ts` → `src/surface/test-support.ts`; `src/mcp/tools.test.ts` → `src/surface/recall.test.ts` + `src/surface/remember.test.ts`

**Interfaces:**
- Consumes: the surface operations from Task 1.
- Produces: `src/surface/test-support.ts` exporting `freshSession`, `jaccardDeps`, `makeFakeHybridDeps` (moved verbatim).

- [ ] **Step 1: Move `test-support.ts` to surface** — `git mv src/mcp/test-support.ts src/surface/test-support.ts`. In the moved file, change any `from "./tools.js"` → `from "./recall.js"` (for `RecallDeps`) and any `from "./embeddings.js"` → `from "./recall.js"` (for `EmbeddingState`); leave `openSession`/algebra imports (same `../`/`./` depth — `freshSession` uses `openSession` from `./session.js` or `./index.js`, adjust to `./session.js`).

- [ ] **Step 2: Repoint the `mneme/mcp` barrel** — in `src/mcp/index.ts`, change the two operation-export lines to source from surface:

```ts
export { remember, recall, listCorpora, ensureCorpus, keyCensus } from "../surface/index.js";
export type {
  RememberArgs, RememberResult, RecallArgs, RecallMatch, RecallResult, ListResult,
} from "../surface/index.js";
```
(Leave the `server.js` and `engine.js` exports untouched.)

- [ ] **Step 3: Repoint `server.ts`** — change `import { remember, recall, listCorpora, keyCensus } from "./tools.js";` → `from "../surface/index.js";`. Everything else in `server.ts` stays (transport, `appendRecallLog`, `initEmbeddings`).

- [ ] **Step 4: Repoint the remaining test importers** — in `src/mcp/embeddings.test.ts` and `src/mcp/engine.test.ts`, change any `from "./tools.js"` → `from "../surface/index.js"`, any `from "./test-support.js"` → `from "../surface/test-support.js"`, and any `EmbeddingState` import from `./embeddings.js` → `../surface/index.js`.

- [ ] **Step 5: Move the operation tests** — `git mv src/mcp/tools.test.ts src/surface/recall.test.ts`. Split the `remember`/`ensureCorpus`/`listCorpora` describe-blocks into a new `src/surface/remember.test.ts` (recall/keyCensus stay in `recall.test.ts`). In both, change imports from `./tools.js` → `./recall.js` / `./remember.js` and `./test-support.js` → `./test-support.js` (now co-located in surface).

- [ ] **Step 6: Run the gate**

Run: `npx vitest run src/mcp/ src/surface/ && npx tsc --noEmit`
Expected: all tests PASS (same count, same behavior; tests now live in surface), tsc clean.

- [ ] **Step 7: Commit**

```bash
git add -A src/mcp src/surface
git commit -m "refactor(mcp): repoint importers + barrel to surface; move ops tests + test-support"
```

---

### Task 3: Move embeddings loader to surface; delete the shim; lock with back-compat + layering tests

**SPEC AMENDMENT (during execution):** the spec said `initEmbeddings` stays in `src/mcp/embeddings.ts`, but `surface`'s `recall` + its test helpers depend on it — so `embeddings.ts` moves to `src/surface` too, completing the consolidation and resolving the temporary surface→mcp exception introduced in Task 2. See `.superpowers/sdd/task-3-brief.md` for the expanded, authoritative step list.

**Files:**
- Move: `src/mcp/embeddings.ts` → `src/surface/embeddings.ts` (+ its test); repoint `server.ts`/`engine.ts`/`test-support.ts`/`recall.test.ts` embeddings imports.
- Delete: `src/mcp/tools.ts`
- Create: `src/mcp/backcompat.test.ts`, `src/surface/layering.test.ts`

**Interfaces:**
- Consumes: the `mneme/mcp` barrel (`src/mcp/index.ts`) and surface operations.

- [ ] **Step 1: Write the back-compat failing test** — `src/mcp/backcompat.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recall, remember } from "./index.js";           // the mneme/mcp barrel
import { openSession } from "../surface/index.js";
import { jaccardDeps } from "../surface/test-support.js";

it("recall/remember re-exported from the mcp barrel still round-trip", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "mneme-bc-")), "store.db");
  const session = openSession({ dbPath, writer: "test" });
  remember(session, { subject: "project:x", key: "status", value: "green", corpus: "c" });
  const r = await recall(session, { about: "project:x status", corpus: "c" }, jaccardDeps);
  expect(r.content).toContain("green");
  session.close();
});
```

- [ ] **Step 2: Run it — expect PASS already** (the barrel re-exports from surface after Task 2).

Run: `npx vitest run src/mcp/backcompat.test.ts`
Expected: PASS. (This test is a regression guard, green from the start — if it ever fails, the barrel contract broke.)

- [ ] **Step 3: Write the layering-invariant test** — `src/surface/layering.test.ts`:

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

it("no file under src/surface or src/retrieval imports from src/mcp", () => {
  const offenders: string[] = [];
  for (const dir of ["src/surface", "src/retrieval"]) {
    for (const f of tsFiles(dir)) {
      if (/from\s+["'][^"']*\/mcp\//.test(readFileSync(f, "utf8"))) offenders.push(f);
    }
  }
  expect(offenders, `these import from mcp: ${offenders.join(", ")}`).toEqual([]);
});
```

- [ ] **Step 4: Run it — expect PASS.**

Run: `npx vitest run src/surface/layering.test.ts`
Expected: PASS (Task 1/2 removed the only surface→mcp path: `EmbeddingState`).

- [ ] **Step 5: Delete the shim** — `git rm src/mcp/tools.ts`. Confirm nothing imports it:

Run: `grep -rn "from \"\./tools\|/mcp/tools" src/ bench/ integrations/`
Expected: no matches.

- [ ] **Step 6: Run the full gate**

Run: `npx vitest run src/mcp/ src/surface/ && npx tsc --noEmit`
Expected: all PASS, tsc clean, `src/mcp/tools.ts` gone.

- [ ] **Step 7: Commit**

```bash
git add -A src/mcp src/surface
git commit -m "refactor(mcp): delete tools.ts shim; lock with back-compat + layering tests"
```

---

## Self-Review

- **Spec coverage:** Inventory (recall/keyCensus/parseAsOf/remember/ensureCorpus/listCorpora + types + EmbeddingState) — moved in Task 1. `mcp` thin transport — Task 2 (barrel + server). Back-compat — Task 3 test. Layering invariant — Task 3 test. `tools.ts` deleted — Task 3. Behavior-preserving — full-suite gate each task. All five success criteria covered.
- **Placeholder scan:** none — moves are precise symbol lists + exact import-path edits; both new tests carry full code.
- **Type consistency:** the surface exports in Task 1 Step 3, the shim in Task 1 Step 5, and the barrel in Task 2 Step 2 list the identical symbol set (`recall`/`keyCensus`/`parseAsOf`/`remember`/`ensureCorpus`/`listCorpora` + `EmbeddingState`/`RecallDeps`/`RecallArgs`/`RecallMatch`/`RecallResult`/`CensusArgs`/`CensusResult`/`RememberArgs`/`RememberResult`/`ListResult`).
