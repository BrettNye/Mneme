# Mneme Bio-Layer Quickstart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a tested, runnable `examples/bio-quickstart.ts` plus a README section that teaches Mneme's bio (cognitive) layer through an AI-agent episodic-memory loop: construct → seed → recall → record success → reinforcement → consolidate.

**Architecture:** `examples/bio-quickstart.ts` is the canonical code — it exports `runBioQuickstart()` (returns a structured summary) and has a guarded script entry that prints a trace. `examples/bio-quickstart.test.ts` runs it and asserts outcomes. The README gains a "Bio layer" section with annotated excerpts. All code uses the public surface (`../src/index.js`). The exact flow below was verified end-to-end against the real library before this plan was written.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, tsx (already a devDep), better-sqlite3 in-memory adapter.

Driving spec: `docs/superpowers/specs/2026-05-29-mneme-bio-quickstart-design.md`. Note: vitest already discovers `examples/**/*.test.ts` and `tsx` is already installed (both from the epistemic-core quickstart) — no config tasks needed.

---

### Task 1: Bio-quickstart example + test (TDD)

**Files:**
- Create: `examples/bio-quickstart.ts`
- Test: `examples/bio-quickstart.test.ts`

- [ ] **Step 1: Write the failing test** — create `examples/bio-quickstart.test.ts`:

```ts
import { runBioQuickstart } from "./bio-quickstart.js";

it("bio quickstart runs the cognitive loop on the public surface", () => {
  const r = runBioQuickstart();

  // recall surfaced at least the seeded memory into the episode
  expect(r.recalledCount).toBeGreaterThanOrEqual(1);

  // the cognitive cycle ran cleanly and applied reinforcement ops
  expect(r.cycleErrors).toBe(0);
  expect(r.opsApplied).toBeGreaterThan(0);

  // a successful outcome strengthened the recalled memory (Beta alpha rose)
  expect(r.reinforcedAlpha).toBeGreaterThan(r.seededAlpha);

  // consolidation ran cleanly on a known episode
  expect(r.consolidationErrors).toBe(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run examples/bio-quickstart.test.ts`
Expected: FAIL — cannot resolve `./bio-quickstart.js` (does not exist yet).

- [ ] **Step 3: Create `examples/bio-quickstart.ts` VERBATIM:**

```ts
/**
 * Mneme bio-layer quickstart — an AI agent's episodic memory.
 *
 * In a real project you would import from the published package:
 *     import { createMneme, createSqliteAdapter, createBioMemory } from "mneme";
 * Here we import the package-root module directly so the example runs in-repo.
 *
 * The bio layer is a cognitive overlay on the claim store: it recalls relevant
 * memories for a task (an "episode"), reinforces the ones that led to success,
 * and consolidates. It does not replace claims — it learns which ones matter.
 */
import { fileURLToPath } from "node:url";
import { createMneme, createSqliteAdapter, createBioMemory } from "../src/index.js";
import type { CorpusDef, RetrievalContext, Claim } from "../src/index.js";

export interface BioQuickstartResult {
  recalledCount: number;
  cycleErrors: number;
  opsApplied: number;
  seededAlpha: number;
  reinforcedAlpha: number;
  consolidationErrors: number;
}

const CORPUS = "agent:memory";
const SEEDED_ALPHA = 3;

const corpusDef: CorpusDef = {
  id: CORPUS,
  displayName: "Agent Memory",
  schema: {
    version: "1",
    subjects: ["project"],
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

// A memory the agent has learned about the project. Beta {alpha:3, beta:1} = some evidence.
function memory(key: string, value: string) {
  return {
    profile: "agent",
    workspace: CORPUS,
    subject: "project",
    key,
    scope: {},
    value,
    confidence: {
      distribution: "beta",
      parameters: { alpha: SEEDED_ALPHA, beta: 1 },
      raw: SEEDED_ALPHA / (SEEDED_ALPHA + 1),
    },
    valid: { from: 0, to: Infinity },
    source: "manual",
    provenance: {},
    evidence: [],
    tags: [],
    schema: `${CORPUS}@1`,
  } as never;
}

export function runBioQuickstart(): BioQuickstartResult {
  // 1. Construct the claim store, then the bio (cognitive) layer over it.
  const adapter = createSqliteAdapter(":memory:");
  const mneme = createMneme({ adapter, availableTiers: [{ kind: "core" }] });
  mneme.createCorpus(corpusDef);
  const bio = createBioMemory({ mneme, corpusId: CORPUS });

  // 2. Seed memories the agent already knows.
  mneme.commit(CORPUS, memory("build.cmd", "npm run build"), { writer: "agent" });
  mneme.commit(CORPUS, memory("tests.dir", "src/"), { writer: "agent" });

  // 3. Open an episode (one task / session).
  const ep = bio.openEpisode();

  // 4. Recall memories into the episode — passing ep.id records them as "surfaced".
  const ctx: RetrievalContext = { now: Date.now(), decay: () => 1 };
  const recalled = bio.recall({ corpusId: CORPUS } as never, [], ctx, ep.id);

  // 5. Report a successful outcome. The inline cognitive cycle (evidence-update) gives
  //    credit only to the surfaced memories, superseding each with a higher-alpha Beta.
  const report = bio.recordOutcome(ep.id, "success");

  // 6. Observe reinforcement: the seeded memory was superseded; read the active replacement
  //    and check its alpha rose above the seeded value.
  const active = mneme
    .read(CORPUS, { corpusId: CORPUS })
    .filter(
      (c: Claim) => c.subject === "project" && c.key === "build.cmd" && c.status !== "deprecated",
    );
  const reinforcedAlpha =
    (active[0]?.confidence as { parameters?: { alpha: number } })?.parameters?.alpha ?? SEEDED_ALPHA;

  // 7. Consolidate the episode (model-free: fold/promote/deprecate per policy).
  const consolidation = bio.consolidate(ep.id);

  return {
    recalledCount: recalled.length,
    cycleErrors: report.errors.length,
    opsApplied: report.opsApplied,
    seededAlpha: SEEDED_ALPHA,
    reinforcedAlpha,
    consolidationErrors: consolidation.errors.length,
  };
}

// Script entry: `npx tsx examples/bio-quickstart.ts` (or `npm run example:bio`).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = runBioQuickstart();
  console.log("Mneme bio-layer quickstart — an AI agent's episodic memory\n");
  console.log(`  memories recalled into the episode:   ${r.recalledCount}`);
  console.log(`  cognitive cycle errors:               ${r.cycleErrors}`);
  console.log(`  reinforcement ops applied:            ${r.opsApplied}`);
  console.log(`  seeded memory alpha:                  ${r.seededAlpha}`);
  console.log(`  reinforced memory alpha (after win):  ${r.reinforcedAlpha}`);
  console.log(`  consolidation errors:                 ${r.consolidationErrors}`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run examples/bio-quickstart.test.ts`
Expected: PASS.

If it FAILS, the code above is API-verified, so suspect an environment issue — read the error, fix only within these two files (never modify `src/`), re-run. If a genuine API mismatch blocks you that you cannot fix within these two files, STOP and report BLOCKED with the exact error.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (one more test than before — 823).

- [ ] **Step 6: Commit (EXPLICIT paths; `git status` first; never `git add -A`):**

```bash
git add examples/bio-quickstart.ts examples/bio-quickstart.test.ts
git commit -m "feat(examples): tested runnable bio-layer quickstart (agent memory)"
```

---

### Task 2: README bio-layer section

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Insert a new section before `## Where to go next`**

The README currently ends with:

```markdown
## Where to go next

- Replay re-execution engine: `docs/superpowers/specs/2026-05-28-replay-reexecution-engine-design.md`
- The bio (cognitive) layer ships with its own quickstart (coming next).
```

Make two edits:

(a) Insert this entire section immediately BEFORE the `## Where to go next` line:

````markdown
## Bio layer (cognitive memory)

The **bio layer** is a cognitive overlay on the claim store. It doesn't replace claims — it
learns *which* claims matter from how episodes (tasks) turn out: it **recalls** relevant
memories, **reinforces** the ones that led to success, and **consolidates** them. The full
runnable version is in [`examples/bio-quickstart.ts`](examples/bio-quickstart.ts)
(`npm run example:bio`).

```ts
import { createMneme, createSqliteAdapter, createBioMemory } from "mneme";

const mneme = createMneme({
  adapter: createSqliteAdapter(":memory:"),
  availableTiers: [{ kind: "core" }],
});
mneme.createCorpus(corpusDef); // see examples/bio-quickstart.ts for the full definition
const bio = createBioMemory({ mneme, corpusId: "agent:memory" });

// Recall the agent's memories for a task (an "episode"), then report how the task went.
const ep = bio.openEpisode();
bio.recall({ corpusId: "agent:memory" }, [], { now: Date.now(), decay: () => 1 }, ep.id);

// A successful outcome reinforces the recalled memories — their Beta alpha rises.
const report = bio.recordOutcome(ep.id, "success");
// report.opsApplied > 0 — the cognitive cycle strengthened the surfaced memories

bio.consolidate(ep.id); // fold / promote consolidated memories
```

`summarize` and `dream` are deeper bio processes that take an injected model function — see
the bio-layer design docs.

````

(b) Replace the stale bullet:

```markdown
- The bio (cognitive) layer ships with its own quickstart (coming next).
```

with:

```markdown
- Bio layer: see [Bio layer (cognitive memory)](#bio-layer-cognitive-memory) above and [`examples/bio-quickstart.ts`](examples/bio-quickstart.ts).
```

- [ ] **Step 2: Sanity-check the README**

Run: `node -e "const fs=require('fs'); const t=fs.readFileSync('README.md','utf8'); if(!t.includes('## Bio layer (cognitive memory)')||t.includes('(coming next)')) throw new Error('bio section missing or stale line remains'); console.log('README ok');"`
Expected: prints `README ok`.

- [ ] **Step 3: Commit:**

```bash
git add README.md
git commit -m "docs: add bio-layer (cognitive memory) section to README"
```

---

### Task 3: Wire `npm run example:bio`

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the script**

The `scripts` block currently reads:

```json
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "example": "tsx examples/quickstart.ts"
  },
```

Change it to (add the `example:bio` line; note the comma after the `example` line):

```json
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "example": "tsx examples/quickstart.ts",
    "example:bio": "tsx examples/bio-quickstart.ts"
  },
```

- [ ] **Step 2: Run the bio example and read the trace**

Run: `npm run example:bio`
Expected output (alpha values are deterministic for a fresh in-memory store; a success bumps the seeded alpha):

```
Mneme bio-layer quickstart — an AI agent's episodic memory

  memories recalled into the episode:   2
  cognitive cycle errors:               0
  reinforcement ops applied:            2
  seeded memory alpha:                  3
  reinforced memory alpha (after win):  5
  consolidation errors:                 0
```

(`reinforced memory alpha` may differ if the default bio policy's outcome weight changes; the
test only asserts it is greater than the seeded alpha.)

- [ ] **Step 3: Confirm the full suite and typecheck are clean**

Run: `npx vitest run && npx tsc --noEmit`
Expected: suite PASS; `tsc` prints nothing. (`examples/` is outside the `tsconfig` `include`, so `tsc` ignores it — expected.)

- [ ] **Step 4: Commit:**

```bash
git add package.json
git commit -m "chore: add npm run example:bio script"
```

---

## Notes for the implementer

- **Public surface only.** Import from `../src/index.js`. Do NOT import internal modules, and do NOT use the `makeBioMneme` test helper (it is not public) — wire the mneme via `createMneme` + `createSqliteAdapter` + `createCorpus` as shown.
- **`as never` casts** on the `memory()` candidate and the `recall` query mirror `src/mneme.test.ts`'s `as any` usage to avoid the verbose full types in teaching code. Keep them.
- **Determinism.** For a fresh `:memory:` store the alpha values are stable (seeded 3 → reinforced 5 under the default policy), but the test asserts only `reinforcedAlpha > seededAlpha` — do not assert an exact reinforced value.
- This flow was verified end-to-end before the plan was written (recall surfaced 2, opsApplied 2, alpha 3→5, all reports error-free), so it should drop in cleanly.
