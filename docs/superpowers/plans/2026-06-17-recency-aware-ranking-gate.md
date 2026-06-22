# Recency-aware ranking gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bench-only gate experiment that re-ranks the fixed resolved survivor set with a jaccard×recency weighted-sum blend, swept over α × half-life across all benchmark categories, to decide whether recency-aware reading lifts knowledge-update accuracy without regressing temporal-reasoning.

**Architecture:** A pure `rankBlend(survivors, query, {alpha, halfLifeMs, t})` orders survivors by `α·jaccard + (1−α)·exp(−λ·age)`. A sweep driver ingests the oracle set once, computes `resolveOnly` survivors per question once (α-independent), then re-ranks per (α, half-life) cell and scores via the existing `scoreQuestion`. The α=1 cell is a byte-exact identity with arm A and gates against the recorded 0.403.

**Tech Stack:** TypeScript, `tsx`, `vitest`, Mneme session surface. Bench-only; no `src/` change.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-17-recency-aware-ranking-gate-design.md` — binds every task.
- **No `src/` change**, and no change to `answer.ts`/`score.ts`/`run.ts`/`ingest.ts`/`types.ts`/`drift-*` files. Only the four new files below.
- **Blend:** `score = alpha·simJaccard.scoreOne(value,query) + (1−alpha)·exp(−lambda·age)`, `lambda = Math.LN2/halfLifeMs`, `age = max(0, t − valid.from)`, `t = evaluationInstant(q)`.
- **Tie-break = STABLE INPUT ORDER ONLY** (`a.i − b.i`) — this makes `alpha=1` byte-identical to arm A's `rho` (stable score-only sort over the same `resolveOnly` claim order). NO `valid.from`/`recordedSeq` tiebreak.
- **Grid:** `alpha ∈ {1.0,0.75,0.5,0.25,0.0} × halfLifeDays ∈ {30,90,365}`; `alpha=1` is half-life-independent → run once. `KS = [1,3,10]`, `MAX_K = 10`.
- **Knobs off:** every arm-A/resolveOnly call passes `abstainBelowTop:0`, `relevanceFloor:0` (arm A), `evidencePoolingRule: RULE.MAX_MEAN`, `keyCardinality: MANUAL_KEY_CARDINALITY`.
- **Baseline gate (hard abort):** `alpha=1` KU `updateCorrect` == `--expect-update-correct` (default 0.403) AND per-question top-1 claim id under `alpha=1` equals arm A's top-1 on every question (identity check).
- **Abstention is non-discriminating** on oracle (constant 0.0) — logged, NOT in the verdict.
- **`RULE`** imported from `../../../src/distribution/rules.js`. **`TARGET_CATEGORIES`** is a local const (not exported) — declare it locally as the siblings do.
- **Determinism:** measurement clock-free (`new Date()` only in `--append-results`). Imports use `.js` extensions.
- **Commit hold:** strict — do NOT `git commit`/`git add`. Leave changes in the working tree. Per-task commit steps are HELD.

---

### Task 1: The blend ranker (`rank-blend.ts`)

**Files:**
- Create: `bench/longmemeval/manual/rank-blend.ts`
- Test: `bench/longmemeval/manual/rank-blend.test.ts`

**Interfaces:**
- Consumes: `Claim` from `src/core/claim.js` (`value`, `valid.from: number`); `Value` from `src/core/value.js`; `simJaccard` from `src/algebra/similarity.js` (`scoreOne(value, query): number` in [0,1]).
- Produces: `interface BlendOpts { alpha: number; halfLifeMs: number; t: number }` and `rankBlend(survivors: readonly Claim[], query: Value, opts: BlendOpts): Claim[]`.

- [ ] **Step 1: Write the failing test**

Create `bench/longmemeval/manual/rank-blend.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Claim } from "../../../src/core/claim.js";
import { simJaccard } from "../../../src/algebra/similarity.js";
import { rankBlend } from "./rank-blend.js";

const DAY = 86_400_000;
// Metrics read only value + valid.from; minimal claim cast.
function claim(id: string, value: string, validFrom: number): Claim {
  return { id, value, valid: { from: validFrom, to: Infinity } } as unknown as Claim;
}
const T = 1_000 * DAY; // evaluation instant
const opts = (alpha: number, halfLifeDays = 90) => ({ alpha, halfLifeMs: halfLifeDays * DAY, t: T });

describe("rankBlend", () => {
  it("alpha=1 orders by jaccard desc with STABLE input order on ties (== rho)", () => {
    const q = "blue widget";
    // c1 high jaccard, c2 & c3 zero jaccard (tie) — c2 before c3 in input must stay.
    const c1 = claim("c1", "blue widget", T - 10 * DAY);
    const c2 = claim("c2", "zzz", T - 1 * DAY);     // newer but irrelevant
    const c3 = claim("c3", "qqq", T - 5 * DAY);
    const out = rankBlend([c1, c2, c3], q, opts(1));
    expect(out.map((c) => c.id)).toEqual(["c1", "c2", "c3"]); // c1 by score; c2,c3 tie → input order
    // sanity: matches a stable jaccard sort
    expect(simJaccard.scoreOne(c1.value, q)).toBeGreaterThan(0);
  });

  it("alpha=0 orders by recency (newest first); age=0 → recency 1", () => {
    const c1 = claim("c1", "a", T - 10 * DAY);
    const c2 = claim("c2", "b", T);           // age 0
    const c3 = claim("c3", "c", T - 3 * DAY);
    const out = rankBlend([c1, c2, c3], "irrelevant", opts(0));
    expect(out.map((c) => c.id)).toEqual(["c2", "c3", "c1"]);
  });

  it("the dial works: relevant-old vs irrelevant-new swap as alpha 1→0", () => {
    const q = "blue widget";
    const relevantOld = claim("old", "blue widget", T - 200 * DAY);
    const irrelevantNew = claim("new", "zzz", T - 1 * DAY);
    const atOne = rankBlend([relevantOld, irrelevantNew], q, opts(1, 30));
    const atZero = rankBlend([relevantOld, irrelevantNew], q, opts(0, 30));
    expect(atOne[0].id).toBe("old");   // relevance wins
    expect(atZero[0].id).toBe("new");  // recency wins
  });

  it("larger half-life flattens recency differences", () => {
    const q = "irrelevant";
    const a = claim("a", "x", T - 100 * DAY);
    const b = claim("b", "y", T - 1 * DAY);
    // pure recency: b always first; but the SCORE gap shrinks with a longer half-life.
    const shortGap = (() => {
      const lambda = Math.LN2 / (30 * DAY);
      return Math.exp(-lambda * 1 * DAY) - Math.exp(-lambda * 100 * DAY);
    })();
    const longGap = (() => {
      const lambda = Math.LN2 / (365 * DAY);
      return Math.exp(-lambda * 1 * DAY) - Math.exp(-lambda * 100 * DAY);
    })();
    expect(longGap).toBeLessThan(shortGap);
    expect(rankBlend([a, b], q, opts(0, 365)).map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("empty input → empty", () => {
    expect(rankBlend([], "q", opts(0.5))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run bench/longmemeval/manual/rank-blend.test.ts`
Expected: FAIL — `Cannot find module './rank-blend.js'`.

- [ ] **Step 3: Write the implementation**

Create `bench/longmemeval/manual/rank-blend.ts`:

```ts
/**
 * Blend ranker for the recency-aware ranking gate (bench-only).
 *
 * score = alpha·jaccard(value,query) + (1-alpha)·exp(-lambda·age),
 *   lambda = ln2/halfLifeMs, age = max(0, t - valid.from).
 * alpha=1 → pure jaccard (byte-identical to arm A's rho: stable score-only
 * sort over the same resolveOnly claim order). alpha=0 → pure age-decay recency.
 *
 * Spec: docs/superpowers/specs/2026-06-17-recency-aware-ranking-gate-design.md
 */
import type { Claim } from "../../../src/core/claim.js";
import type { Value } from "../../../src/core/value.js";
import { simJaccard } from "../../../src/algebra/similarity.js";

export interface BlendOpts { alpha: number; halfLifeMs: number; t: number }

export function rankBlend(survivors: readonly Claim[], query: Value, opts: BlendOpts): Claim[] {
  const lambda = Math.LN2 / opts.halfLifeMs;
  const scored = survivors.map((claim, i) => {
    const rel = simJaccard.scoreOne(claim.value, query);     // [0,1]
    const age = Math.max(0, opts.t - claim.valid.from);      // ≥0 (tauValid guarantees)
    const recency = Math.exp(-lambda * age);                 // (0,1], newest≈1
    const score = opts.alpha * rel + (1 - opts.alpha) * recency;
    return { claim, score, i };
  });
  // Tie-break = stable input order ONLY → alpha=1 is identical to arm A's rho.
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.claim);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run bench/longmemeval/manual/rank-blend.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit** *(HELD)*

```bash
git add bench/longmemeval/manual/rank-blend.ts bench/longmemeval/manual/rank-blend.test.ts
git commit -m "feat(bench): jaccard×recency blend ranker"
```

---

### Task 2: The ranking-variant sweep driver

**Files:**
- Create: `bench/longmemeval/manual/ranking-variant-sweep.ts`
- Test: `bench/longmemeval/manual/ranking-variant-sweep.test.ts`

**Interfaces:**
- Consumes: `rankBlend` (Task 1); `resolveOnly` from `./drift-resolution-metrics.js`; `parseArgs` (`node:util`); `readFileSync`/`appendFileSync`/`mkdtempSync`/`rmSync` (`node:fs`); `tmpdir` (`node:os`); `join` (`node:path`); `openSession` (`src/surface/index.js`); `ingestQuestion`/`claimsFor` (`../ingest.js`); `answerArmA`/`evaluationInstant` (`../answer.js`); `scoreQuestion`/`aggregate`/`type ScoreRow`/`type QuestionScore` (`../score.js`); `LmeQuestion`/`ClaimRecord`/`CacheHeader`/`categoryOf`/`normalizeQuestion`/`type LmeQuestionT`/`type ClaimRecordT`/`type AnswerResult` (`../types.js`); `EXTRACTION_MODEL`/`PROMPT_VERSION` (`../../convert/longmemeval.js`); `MANUAL_KEY_CARDINALITY` (`../run.js`); `RULE` (`../../../src/distribution/rules.js`); `Claim` (`../../../src/core/claim.js`).
- Produces: `export async function main(argv: string[], opts?: { onError?: (m: string) => void }): Promise<number>`.

- [ ] **Step 1: Write the failing test**

Create `bench/longmemeval/manual/ranking-variant-sweep.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { main } from "./ranking-variant-sweep.js";

describe("ranking-variant-sweep CLI", () => {
  it("errors without --file/--claims", async () => {
    const errs: string[] = [];
    const code = await main([], { onError: (m) => errs.push(m) });
    expect(code).toBe(1);
    expect(errs.join(" ")).toMatch(/--file and --claims are required/);
  });

  it("rejects an out-of-range alpha", async () => {
    const errs: string[] = [];
    const code = await main(
      ["--file", "x.json", "--claims", "y.jsonl", "--alphas", "1.5"],
      { onError: (m) => errs.push(m) },
    );
    expect(code).toBe(1);
    expect(errs.join(" ")).toMatch(/alphas/);
  });

  it("runs the fixture end-to-end, passes the baseline+identity gate, renders columns", async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
    try {
      const code = await main([
        "--file", "bench/longmemeval/fixtures/dataset.json",
        "--claims", "bench/longmemeval/fixtures/claims.jsonl",
        "--alphas", "1.0,0.0", "--half-lives", "90",
        "--expect-update-correct", "1.0",
      ]);
      expect(code).toBe(0);
    } finally { console.log = orig; }
    const out = logs.join("\n");
    expect(out).toMatch(/identical to arm A/);   // identity gate line
    expect(out).toMatch(/temporalCorrect/);       // column header
    expect(out).toMatch(/WIN|TRADEOFF|NEUTRAL|LOSS/); // verdict block
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run bench/longmemeval/manual/ranking-variant-sweep.test.ts`
Expected: FAIL — `Cannot find module './ranking-variant-sweep.js'`.

- [ ] **Step 3: Write the implementation**

Create `bench/longmemeval/manual/ranking-variant-sweep.ts`:

```ts
/**
 * Recency-aware ranking gate (bench-only). Holds the resolved survivor set
 * fixed and re-ranks it with rankBlend over alpha × half-life, across all
 * categories. alpha=1 is gated as a byte-exact identity with arm A (== 0.403).
 *
 * Spec: docs/superpowers/specs/2026-06-17-recency-aware-ranking-gate-design.md
 *
 *   tsx bench/longmemeval/manual/ranking-variant-sweep.ts \
 *     --file bench/datasets/longmemeval/longmemeval_oracle_target.json \
 *     --claims bench/datasets/longmemeval/longmemeval-oracle-claims.jsonl \
 *     --raw --expect-update-correct 0.403 [--alphas ...] [--half-lives ...] [--append-results ...]
 */
import { parseArgs } from "node:util";
import { readFileSync, appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "../../../src/surface/index.js";
import type { Claim } from "../../../src/core/claim.js";
import { RULE } from "../../../src/distribution/rules.js";
import { rankBlend } from "./rank-blend.js";
import { resolveOnly } from "./drift-resolution-metrics.js";
import { ingestQuestion, claimsFor } from "../ingest.js";
import { answerArmA, evaluationInstant } from "../answer.js";
import { scoreQuestion, aggregate, type ScoreRow, type QuestionScore } from "../score.js";
import {
  LmeQuestion, ClaimRecord, CacheHeader, categoryOf, normalizeQuestion,
  type LmeQuestionT, type ClaimRecordT, type AnswerResult,
} from "../types.js";
import { EXTRACTION_MODEL, PROMPT_VERSION } from "../../convert/longmemeval.js";
import { MANUAL_KEY_CARDINALITY } from "../run.js";

const TARGET_CATEGORIES = new Set(["knowledge-update", "temporal-reasoning", "abstention"]);
const KS = [1, 3, 10];
const MAX_K = 10;
const DAY_MS = 86_400_000;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

// Headline metric name per category.
const HEADLINE: Record<string, string> = {
  "knowledge-update": "updateCorrect",
  "temporal-reasoning": "temporalCorrect",
  "abstention": "abstentionCorrect",
};

interface Cell { alpha: number; halfLifeDays: number; rows: ScoreRow[] }
interface QState { q: LmeQuestionT; corpusId: string; survivors: readonly Claim[]; t: number; armATop1Id: string | undefined }

const metric = (rows: ScoreRow[], cat: string, m: string): number | undefined =>
  rows.find((r) => r.category === cat && r.metric === m)?.value;

export async function main(argv: string[], opts?: { onError?: (m: string) => void }): Promise<number> {
  const logError = (m: string): void => { console.error(m); opts?.onError?.(m); };

  const { values } = parseArgs({
    args: argv,
    options: {
      file: { type: "string" },
      claims: { type: "string" },
      alphas: { type: "string", default: "1.0,0.75,0.5,0.25,0.0" },
      "half-lives": { type: "string", default: "30,90,365" },
      raw: { type: "boolean", default: false },
      "expect-update-correct": { type: "string" },
      "append-results": { type: "string" },
    },
  });
  if (!values.file || !values.claims) { logError("--file and --claims are required"); return 1; }

  const alphas = String(values.alphas).split(",").map((s) => parseFloat(s.trim()));
  if (alphas.some((a) => Number.isNaN(a) || a < 0 || a > 1) || alphas.length === 0) {
    logError("--alphas must be a comma-separated list in [0,1]"); return 1;
  }
  const halfLives = String(values["half-lives"]).split(",").map((s) => parseFloat(s.trim()));
  if (halfLives.some((h) => Number.isNaN(h) || h <= 0) || halfLives.length === 0) {
    logError("--half-lives must be a comma-separated list of positive days"); return 1;
  }
  const expect = values["expect-update-correct"] !== undefined
    ? parseFloat(String(values["expect-update-correct"])) : undefined;

  // --- load dataset + claims (run.ts discipline) ---
  const datasetRaw = JSON.parse(readFileSync(values.file, "utf-8")) as unknown[];
  const questions: LmeQuestionT[] = datasetRaw
    .map((r) => (values.raw ? normalizeQuestion(r) : LmeQuestion.parse(r)))
    .filter((q) => TARGET_CATEGORIES.has(categoryOf(q)));

  const lines = readFileSync(values.claims, "utf-8").split("\n").filter((l) => l.trim().length > 0);
  const header = CacheHeader.parse(JSON.parse(lines[0]));
  if (header.model !== EXTRACTION_MODEL || header.promptVersion !== PROMPT_VERSION) {
    logError(`Claims cache header mismatch: model=${header.model}, promptVersion=${header.promptVersion}`);
    return 1;
  }
  const allClaims: ClaimRecordT[] = lines.slice(1).map((l) => ClaimRecord.parse(JSON.parse(l)));

  // --- single ingest (no drift → data identical across cells); precompute survivors + arm A top-1 once ---
  const dir = mkdtempSync(join(tmpdir(), "mneme-rank-"));
  const session = openSession({ dbPath: join(dir, "lme.db"), writer: "rank-sweep", source: "imported" });
  try {
    const qstates: QState[] = [];
    for (const q of questions) {
      const corpusId = `lme-${q.question_id}`;
      ingestQuestion(session, q, claimsFor(q, allClaims, { oracle: true }));
      const survivors = resolveOnly(session, corpusId, q, {
        keyCardinality: MANUAL_KEY_CARDINALITY, evidencePoolingRule: RULE.MAX_MEAN,
      });
      const armA = answerArmA(session, corpusId, q, {
        k: MAX_K, keyCardinality: MANUAL_KEY_CARDINALITY,
        abstainBelowTop: 0, relevanceFloor: 0, evidencePoolingRule: RULE.MAX_MEAN,
      });
      qstates.push({ q, corpusId, survivors, t: evaluationInstant(q), armATop1Id: armA.claims[0]?.id });
    }

    // --- cells: alpha × half-life (alpha=1 run once, half-life-independent) ---
    const cells: Cell[] = [];
    let baselineDone = false;
    for (const alpha of alphas) {
      for (const halfLifeDays of halfLives) {
        if (alpha === 1 && baselineDone) continue;
        const halfLifeMs = halfLifeDays * DAY_MS;
        const scores: QuestionScore[] = [];
        let idMismatch = 0;
        for (const s of qstates) {
          const ordered = rankBlend(s.survivors, s.q.question, { alpha, halfLifeMs, t: s.t });
          const result: AnswerResult = { arm: "A", claims: ordered.slice(0, MAX_K), abstained: ordered.length === 0 };
          scores.push(scoreQuestion(s.q, result, KS));
          if (alpha === 1 && ordered[0]?.id !== s.armATop1Id) idMismatch++;
        }
        const rows = aggregate(scores, KS);
        cells.push({ alpha, halfLifeDays: alpha === 1 ? 0 : halfLifeDays, rows });

        if (alpha === 1) {
          baselineDone = true;
          if (idMismatch > 0) {
            logError(`IDENTITY GATE FAILED: rankBlend(alpha=1) top-1 differs from arm A on ${idMismatch}/${qstates.length} questions — not an identity, aborting`);
            return 1;
          }
          const ku = metric(rows, "knowledge-update", "updateCorrect");
          if (expect !== undefined && (ku === undefined || r3(ku) !== r3(expect))) {
            logError(`SANITY GATE FAILED: baseline KU updateCorrect ${ku !== undefined ? r3(ku) : "missing"} !== expected ${r3(expect)} — aborting`);
            return 1;
          }
          console.log(`baseline gate: alpha=1 KU updateCorrect ${ku !== undefined ? r3(ku) : "?"}; top-1 identical to arm A on all ${qstates.length} questions ✓`);
        }
      }
    }

    // --- output table ---
    const out: string[] = [];
    out.push("| alpha | halfLifeDays | category | metric | value | recall@1 | recall@3 | recall@10 | n |");
    out.push("|---|---|---|---|---|---|---|---|---|");
    for (const c of cells) {
      for (const cat of ["knowledge-update", "temporal-reasoning", "abstention"]) {
        const h = metric(c.rows, cat, HEADLINE[cat]);
        const rk = (k: number) => metric(c.rows, cat, `recall@${k}`);
        const n = c.rows.find((r) => r.category === cat && r.metric === HEADLINE[cat])?.n ?? 0;
        out.push(
          `| ${c.alpha} | ${c.alpha === 1 ? "—" : c.halfLifeDays} | ${cat} | ${HEADLINE[cat]} | ` +
          `${h !== undefined ? r3(h) : "—"} | ${rk(1) !== undefined ? r3(rk(1)!) : "—"} | ` +
          `${rk(3) !== undefined ? r3(rk(3)!) : "—"} | ${rk(10) !== undefined ? r3(rk(10)!) : "—"} | ${n} |`,
        );
      }
    }
    const table = out.join("\n");
    console.log(table);

    // --- gate verdict block (abstention excluded — non-discriminating) ---
    const base = cells.find((c) => c.alpha === 1);
    const baseKU = base ? metric(base.rows, "knowledge-update", "updateCorrect") : undefined;
    const baseTR = base ? metric(base.rows, "temporal-reasoning", "temporalCorrect") : undefined;
    console.log(`\nverdict (baseline KU ${baseKU !== undefined ? r3(baseKU) : "?"}, TR ${baseTR !== undefined ? r3(baseTR) : "?"}); abstention logged-only, non-discriminating:`);
    for (const c of cells) {
      if (c.alpha === 1) continue;
      const ku = metric(c.rows, "knowledge-update", "updateCorrect");
      const tr = metric(c.rows, "temporal-reasoning", "temporalCorrect");
      const dKU = ku !== undefined && baseKU !== undefined ? ku - baseKU : NaN;
      const dTR = tr !== undefined && baseTR !== undefined ? tr - baseTR : NaN;
      const label = dKU > 0 && dTR >= 0 ? "WIN" : dKU > 0 && dTR < 0 ? "TRADEOFF" : "NEUTRAL/LOSS";
      console.log(`  alpha=${c.alpha} hl=${c.halfLifeDays}d: dKU ${r3(dKU)} dTR ${r3(dTR)} → ${label}`);
    }

    if (values["append-results"]) {
      appendFileSync(String(values["append-results"]), `\n\n## Ranking-variant sweep (${new Date().toISOString()})\n\n${table}\n`, "utf-8");
    }
    return 0;
  } finally {
    session.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

if (process.argv[1] && process.argv[1].endsWith("ranking-variant-sweep.ts")) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
```

- [ ] **Step 4: Run the fixture test**

Run: `npx vitest run bench/longmemeval/manual/ranking-variant-sweep.test.ts`
Expected: PASS. If the fixture KU `updateCorrect` isn't 1.0, read `bench/longmemeval/run.test.ts:43` and set `--expect-update-correct` to the real value. If the identity gate trips on the fixture, the tie-break is wrong (must be stable input order only) — re-check Task 1.

- [ ] **Step 5: Typecheck + full new-suite**

Run: `npx tsc --noEmit`
Run: `npx vitest run bench/longmemeval/manual/rank-blend.test.ts bench/longmemeval/manual/ranking-variant-sweep.test.ts`
Expected: no type errors; both green.

- [ ] **Step 6: Commit** *(HELD)*

```bash
git add bench/longmemeval/manual/ranking-variant-sweep.ts bench/longmemeval/manual/ranking-variant-sweep.test.ts
git commit -m "feat(bench): recency-aware ranking gate sweep (alpha × half-life, all categories)"
```

---

## Post-implementation: run the oracle gate

After both tasks pass, run the gate (records the verdict that selects the fork):

```bash
npx tsx bench/longmemeval/manual/ranking-variant-sweep.ts \
  --file bench/datasets/longmemeval/longmemeval_oracle_target.json \
  --claims bench/datasets/longmemeval/longmemeval-oracle-claims.jsonl \
  --raw --expect-update-correct 0.403 \
  --append-results bench/RESULTS.md
```

Read the verdict block per spec §1/§7: WIN cells (ΔKU>0 ∧ ΔTR≥0) → outcome A (proceed to real-answer confirmation, then src promotion); only-TRADEOFF cells → outcome B (intent-routing / explicit-as-of fork); no ΔKU>0 → outcome C. Record the table + selected outcome in `bench/RESULTS.md` and update memory `drift-injection-null-result`.

## Commit policy (this run)

All commits HELD per the user. Implement + verify each task leaving the tree staged-but-uncommitted; commit steps run only on release. Spec and plan likewise uncommitted.

---

## Self-Review

**Spec coverage:**
- §3 four files → Task 1 (`rank-blend.ts` + test), Task 2 (`ranking-variant-sweep.ts` + test). ✓
- §4 blend math + stable-input tiebreak → Task 1. ✓
- §5 grid (alpha×halfLife, alpha=1 once), metrics (KS=[1,3,10], headline per category), baseline gate (0.403 + top-1 identity), output table + dose-response/verdict, abstention excluded → Task 2. ✓
- §6 unit tests (alpha=1 identity/stable-tie, alpha=0 recency, dial, half-life flatten, empty) + harness fixture test → Tasks 1 & 2. ✓
- §2 abstention non-gating / knobs off / detectability → honored (abstention excluded from verdict; arm A knobs 0; resolveOnly reused). ✓
- §7 forks → Post-implementation reads the verdict to select the fork. ✓
- §8 out-of-scope (no src, no LLM, jaccard only, oracle only) → honored. ✓

**Placeholder scan:** none. The `as unknown as Claim` casts in Task 1 tests are deliberate minimal fixtures (rankBlend reads only `value`/`valid.from`/`id`). Step 4 names the fixture-value fallback.

**Type consistency:** `rankBlend`/`BlendOpts` named identically in Task 1 (def), Task 1 tests, Task 2 (consumption). `resolveOnly` opts (`keyCardinality`,`evidencePoolingRule`) match its signature. `AnswerResult` `{arm,claims,abstained}` matches `types.ts`. `scoreQuestion(q,result,KS)`/`aggregate(scores,KS)`/`ScoreRow` match `score.ts`. `evaluationInstant`/`answerArmA` from `answer.ts`. The α=1 dedupe (`baselineDone`) + `halfLifeDays:0` marker is consistent between the cell loop and the table/verdict (which key on `c.alpha === 1`).