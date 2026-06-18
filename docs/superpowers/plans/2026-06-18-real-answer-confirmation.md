# Real-answer confirmation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Confirm (or refute) the recency-aware ranking win on *real answer correctness* — judge whether the served top-k context actually answers each question, for a few ranking cells, defeating the `updateCorrect` session-proxy circularity before any `src` promotion.

**Architecture:** A new `answer-correctness-judge.ts` mirrors `ratify-judge.ts` (raw `fetch` → Anthropic Messages API, `json_schema` structured output) and adds a resume-safe cache with header validation. A new `answer-judge-sweep.ts` reuses `resolveOnly` + `rankBlend` to produce each cell's top-k served context, renders it, and feeds it to an injectable judge (cached). It reports `answerInContext` per (cell, category) and a baseline-relative verdict.

**Tech Stack:** TypeScript, `tsx`, `vitest`, raw `fetch` to the Anthropic API (`claude-sonnet-4-6`). Bench-only; no `src/` change.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-18-real-answer-confirmation-design.md` — binds every task.
- **No `src/` change**, and no change to existing bench files (`ratify-judge.ts`, `ranking-variant-sweep.ts`, `rank-blend.ts`, `drift-resolution-metrics.ts`, `run.ts`, etc.). Only the four new files below.
- **Judge model:** `ANSWER_JUDGE_MODEL = "claude-sonnet-4-6"`, `ANSWER_JUDGE_PROMPT_VERSION = "answer-judge-v1"` (distinct constants). Request shape mirrors `ratify-judge.ts:127-145` verbatim: `fetch("https://api.anthropic.com/v1/messages")`, headers `{x-api-key, anthropic-version: "2023-06-01", content-type: "application/json"}`, body `{model, max_tokens: 300, messages, output_config: {format: {type: "json_schema", schema}}}`. (Confirmed current by the claude-api skill: `output_config.format` is canonical; `claude-sonnet-4-6` valid; raw fetch matches the repo.)
- **NO substring pre-check** — the LLM judges every non-empty item (audit C-2: short/numeric/yes-no golds like `"bike"`/`"four"` would false-positive).
- **Context render:** each top-k claim as `subject.key = value (as of <ISO valid.from>)`, value via `canonicalizeValue` (`Claim.value` is `Value`, not guaranteed string); date included for ALL categories (TR ordering needs it). `new Date(claim.valid.from).toISOString()` is deterministic formatting of a stored timestamp, not a clock read.
- **Gold:** `String(q.answer)` (`LmeQuestion.answer` is `z.unknown().optional()`, verified populated as a literal-answer string on the oracle).
- **Cells:** `alpha ∈ {1.0, 0.25, 0.5, 0.0}` (blends at `halfLife=90d`), categories KU + TR (abstention excluded — non-discriminating). `CONTEXT_K = 5`. `MAX_K_SURVIVORS = 10` (resolveOnly/rankBlend operate on the full survivor set; context is the top-5 of the ranked result).
- **Cache:** resume-safe JSONL, header `{kind:"answer-judge-header", model, promptVersion, contextK}`; record `{cell, questionId, category, correct, reason}`; keyed by `cell + "|" + questionId`; header-mismatch ABORTS; torn-write recovery (last-valid-line). NET-NEW vs `ratify-judge.ts` (which validates neither) — model the validation on the extraction cache.
- **Injectable judge:** the sweep takes `opts.judge` (default = real, bound to `ANTHROPIC_API_KEY`) so the test stubs it without network.
- **Determinism:** the inject/rank/render path is clock-free; the only `Date`/clock use is `--append-results` and the direct-CLI guard. Imports use `.js` extensions.
- **Commit hold:** strict — do NOT `git commit`/`git add`. Leave changes in the working tree. Per-task commit steps are HELD.
- **Work in the worktree:** `C:\Users\brett\source\repos\My_Projects\Mneme-realanswer` (branch `feat/real-answer-confirmation`).

---

### Task 1: The answer-correctness judge + smoke

**Files:**
- Create: `bench/longmemeval/manual/answer-correctness-judge.ts`
- Test: `bench/longmemeval/manual/answer-correctness-judge.test.ts`
- Create: `bench/longmemeval/manual/smoke-answer-judge.ts`

**Interfaces:**
- Consumes: `Claim` from `src/core/claim.js` (`subject`, `key`, `value`, `valid.from`); `canonicalizeValue` from `src/core/value.js`; `readFileSync`/`appendFileSync`/`existsSync` (`node:fs`).
- Produces:
  - `interface JudgeItem { question: string; gold: string; context: string[] }`
  - `interface JudgeVerdict { correct: boolean; reason: string }`
  - `type JudgeFn = (item: JudgeItem) => Promise<JudgeVerdict>`
  - `const ANSWER_JUDGE_MODEL = "claude-sonnet-4-6"`, `const ANSWER_JUDGE_PROMPT_VERSION = "answer-judge-v1"`, `const CONTEXT_K = 5`
  - `renderContextClaim(c: Claim): string`
  - `buildAnswerJudgePrompt(item: JudgeItem): string`
  - `parseAnswerVerdict(text: string): JudgeVerdict | null`
  - `judgeAnswerInContext(apiKey: string, item: JudgeItem): Promise<JudgeVerdict>`
  - `judgeCacheKey(cell: string, questionId: string): string`
  - `interface JudgeRecord { cell: string; questionId: string; category: string; correct: boolean; reason: string }`
  - `loadJudgeCache(path: string, expect: { model: string; promptVersion: string; contextK: number }): Map<string, JudgeRecord>` (validates header, recovers torn writes)
  - `appendJudgeHeaderIfNew(path: string, header: {...}): void`, `appendJudgeRecord(path: string, rec: JudgeRecord): void`

- [ ] **Step 1: Write the failing test**

Create `bench/longmemeval/manual/answer-correctness-judge.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Claim } from "../../../src/core/claim.js";
import {
  renderContextClaim, buildAnswerJudgePrompt, parseAnswerVerdict,
  judgeCacheKey, loadJudgeCache, appendJudgeHeaderIfNew, appendJudgeRecord,
  ANSWER_JUDGE_MODEL, ANSWER_JUDGE_PROMPT_VERSION, CONTEXT_K,
  type JudgeRecord,
} from "./answer-correctness-judge.js";

function claim(subject: string, key: string, value: unknown, validFrom: number): Claim {
  return { subject, key, value, valid: { from: validFrom, to: Infinity } } as unknown as Claim;
}

describe("renderContextClaim", () => {
  it("renders subject.key = value (as of ISO), value canonicalized", () => {
    const s = renderContextClaim(claim("alice", "employer", "Globex", Date.UTC(2023, 5, 1)));
    expect(s).toContain("alice.employer = ");
    expect(s).toContain("Globex");
    expect(s).toContain("2023-06-01");
    expect(s).toMatch(/as of/);
  });
});

describe("buildAnswerJudgePrompt", () => {
  it("includes the question, the gold answer, and every context line", () => {
    const p = buildAnswerJudgePrompt({
      question: "Where does alice work now?",
      gold: "Globex",
      context: ["alice.employer = Globex (as of 2023-06-01T00:00:00.000Z)"],
    });
    expect(p).toContain("Where does alice work now?");
    expect(p).toContain("Globex");
    expect(p).toContain("alice.employer = Globex");
    expect(p).toMatch(/JSON/);
  });
});

describe("parseAnswerVerdict", () => {
  it("parses a valid verdict", () => {
    expect(parseAnswerVerdict('{"correct": true, "reason": "x"}')).toEqual({ correct: true, reason: "x" });
  });
  it("returns null on non-boolean correct or unparseable text", () => {
    expect(parseAnswerVerdict('{"correct": "yes"}')).toBeNull();
    expect(parseAnswerVerdict("not json")).toBeNull();
  });
});

describe("cache", () => {
  function tmp(): string { return join(mkdtempSync(join(tmpdir(), "ans-judge-")), "j.jsonl"); }
  const header = { model: ANSWER_JUDGE_MODEL, promptVersion: ANSWER_JUDGE_PROMPT_VERSION, contextK: CONTEXT_K };

  it("round-trips records keyed by cell|questionId", () => {
    const path = tmp();
    appendJudgeHeaderIfNew(path, header);
    const rec: JudgeRecord = { cell: "a0.5", questionId: "q1", category: "knowledge-update", correct: true, reason: "ok" };
    appendJudgeRecord(path, rec);
    const cache = loadJudgeCache(path, header);
    expect(cache.get(judgeCacheKey("a0.5", "q1"))).toEqual(rec);
  });

  it("aborts on header mismatch", () => {
    const path = tmp();
    writeFileSync(path, JSON.stringify({ kind: "answer-judge-header", model: "other", promptVersion: "x", contextK: 5 }) + "\n", "utf8");
    expect(() => loadJudgeCache(path, header)).toThrow(/header/i);
  });

  it("recovers a torn final line (drops it, keeps valid records)", () => {
    const path = tmp();
    appendJudgeHeaderIfNew(path, header);
    appendJudgeRecord(path, { cell: "a1", questionId: "q1", category: "knowledge-update", correct: false, reason: "r" });
    writeFileSync(path, readFileSync(path, "utf8") + '{"cell":"a1","questionId":"q2","corr', "utf8"); // torn
    const cache = loadJudgeCache(path, header);
    expect(cache.size).toBe(1);
    expect(cache.has(judgeCacheKey("a1", "q1"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run bench/longmemeval/manual/answer-correctness-judge.test.ts`
Expected: FAIL — `Cannot find module './answer-correctness-judge.js'`.

- [ ] **Step 3: Write the implementation**

Create `bench/longmemeval/manual/answer-correctness-judge.ts`:

```ts
/**
 * LLM judge: does the served top-k context actually answer the question?
 * Mirrors ratify-judge.ts (raw fetch → Anthropic Messages API, json_schema
 * structured output) and adds a resume-safe cache with header validation +
 * torn-write recovery (NET-NEW vs ratify-judge, modeled on the extraction cache).
 *
 * Spec: docs/superpowers/specs/2026-06-18-real-answer-confirmation-design.md
 */
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import type { Claim } from "../../../src/core/claim.js";
import { canonicalizeValue } from "../../../src/core/value.js";

export const ANSWER_JUDGE_MODEL = "claude-sonnet-4-6";
export const ANSWER_JUDGE_PROMPT_VERSION = "answer-judge-v1";
export const CONTEXT_K = 5;

export interface JudgeItem { question: string; gold: string; context: string[] }
export interface JudgeVerdict { correct: boolean; reason: string }
export type JudgeFn = (item: JudgeItem) => Promise<JudgeVerdict>;

export interface JudgeRecord {
  cell: string;
  questionId: string;
  category: string;
  correct: boolean;
  reason: string;
}

/** "subject.key = value (as of <ISO valid.from>)". Date format is deterministic (no clock read). */
export function renderContextClaim(c: Claim): string {
  const iso = new Date(c.valid.from).toISOString();
  return `${c.subject}.${c.key} = ${canonicalizeValue(c.value)} (as of ${iso})`;
}

export function buildAnswerJudgePrompt(item: JudgeItem): string {
  const ctx = item.context.length > 0 ? item.context.map((l) => `- ${l}`).join("\n") : "(empty)";
  return [
    "You are judging a memory system's retrieval. A question was asked, and the system",
    "served the context below (the top retrieved facts). Decide whether that context",
    "CONTAINS OR SUPPORTS the gold answer to the question. Be strict: facts that are",
    "adjacent or partially relevant but do not actually answer the question are NOT correct.",
    "",
    `Question: ${item.question}`,
    `Gold answer: ${item.gold}`,
    "Served context:",
    ctx,
    "",
    'Respond with JSON: { "correct": boolean, "reason": "<one short sentence>" }',
  ].join("\n");
}

export function parseAnswerVerdict(text: string): JudgeVerdict | null {
  try {
    const obj = JSON.parse(text) as { correct?: unknown; reason?: unknown };
    if (typeof obj.correct !== "boolean") return null;
    return { correct: obj.correct, reason: typeof obj.reason === "string" ? obj.reason : "" };
  } catch {
    return null;
  }
}

export async function judgeAnswerInContext(apiKey: string, item: JudgeItem): Promise<JudgeVerdict> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: ANSWER_JUDGE_MODEL,
      max_tokens: 300,
      messages: [{ role: "user", content: buildAnswerJudgePrompt(item) }],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { correct: { type: "boolean" }, reason: { type: "string" } },
            required: ["correct", "reason"],
            additionalProperties: false,
          },
        },
      },
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${body.slice(0, 200)}`);
  }
  const data = (await response.json()) as { content: Array<{ type: string; text?: string }> };
  const text = data.content.find((b) => b.type === "text")?.text ?? "";
  const parsed = parseAnswerVerdict(text);
  if (!parsed) throw new Error(`parseAnswerVerdict failed on: ${text.slice(0, 200)}`);
  return parsed;
}

export function judgeCacheKey(cell: string, questionId: string): string {
  return `${cell}|${questionId}`;
}

interface JudgeHeader { model: string; promptVersion: string; contextK: number }

export function appendJudgeHeaderIfNew(path: string, header: JudgeHeader): void {
  if (existsSync(path)) return;
  appendFileSync(path, JSON.stringify({ kind: "answer-judge-header", ...header }) + "\n", "utf8");
}

export function appendJudgeRecord(path: string, rec: JudgeRecord): void {
  appendFileSync(path, JSON.stringify(rec) + "\n", "utf8");
}

/** Validates the header (mismatch → throw) and recovers a torn final line (drops it). */
export function loadJudgeCache(path: string, expect: JudgeHeader): Map<string, JudgeRecord> {
  const cache = new Map<string, JudgeRecord>();
  if (!existsSync(path)) return cache;
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return cache;
  const header = JSON.parse(lines[0]) as { kind?: string } & Partial<JudgeHeader>;
  if (header.kind !== "answer-judge-header" || header.model !== expect.model
    || header.promptVersion !== expect.promptVersion || header.contextK !== expect.contextK) {
    throw new Error(`answer-judge cache header mismatch at ${path}: got ${JSON.stringify(header)}, expected ${JSON.stringify(expect)}`);
  }
  for (const line of lines.slice(1)) {
    let rec: JudgeRecord;
    try { rec = JSON.parse(line) as JudgeRecord; } catch { continue; } // torn final line — drop
    if (rec && typeof rec.correct === "boolean" && rec.cell && rec.questionId) {
      cache.set(judgeCacheKey(rec.cell, rec.questionId), rec);
    }
  }
  return cache;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run bench/longmemeval/manual/answer-correctness-judge.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the smoke script**

Create `bench/longmemeval/manual/smoke-answer-judge.ts`:

```ts
// Smoke test: ONE real answer-correctness judge call through the production
// request shape + parser. Run this (≈1 cent) BEFORE any bulk judge run.
//   npx tsx bench/longmemeval/manual/smoke-answer-judge.ts
// Prints an explicit VERDICT line; do not launch the bulk run unless it says OK.
import { judgeAnswerInContext } from "./answer-correctness-judge.js";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

const item = {
  question: "Where does Rachel live now?",
  gold: "the suburbs",
  context: [
    "rachel.residence = the suburbs (as of 2023-06-01T00:00:00.000Z)",
    "rachel.residence = downtown (as of 2023-01-01T00:00:00.000Z)",
  ],
};
try {
  const v = await judgeAnswerInContext(apiKey, item);
  console.log("verdict:", JSON.stringify(v));
  console.log(`VERDICT: OK — judge returned correct=${v.correct}. Safe to launch bulk run.`);
} catch (err) {
  console.log("VERDICT: FAILED —", (err as Error).message, "— do NOT launch the bulk run");
  process.exit(1);
}
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. NOTE: `tsconfig.json` scopes to `src/**` only — it does NOT compile `bench/**`, so this catches `src` regressions but NOT type errors in the new bench file. The real type/runtime gate for bench files is the vitest run in Step 4 (esbuild transpile). Lean on the tests, not tsc, to validate this file.

- [ ] **Step 7: Commit** *(HELD)*

```bash
git add bench/longmemeval/manual/answer-correctness-judge.ts bench/longmemeval/manual/answer-correctness-judge.test.ts bench/longmemeval/manual/smoke-answer-judge.ts
git commit -m "feat(bench): answer-correctness LLM judge + cache + smoke"
```

---

### Task 2: The answer-judge sweep driver

**Files:**
- Create: `bench/longmemeval/manual/answer-judge-sweep.ts`
- Test: `bench/longmemeval/manual/answer-judge-sweep.test.ts`

**Interfaces:**
- Consumes (Task 1): `judgeAnswerInContext`, `renderContextClaim`, `judgeCacheKey`, `loadJudgeCache`, `appendJudgeHeaderIfNew`, `appendJudgeRecord`, `ANSWER_JUDGE_MODEL`, `ANSWER_JUDGE_PROMPT_VERSION`, `CONTEXT_K`, `type JudgeFn`, `type JudgeRecord`. From the bench branch: `resolveOnly` (`./drift-resolution-metrics.js`), `rankBlend` (`./rank-blend.js`). Plus `openSession` (`src/surface/index.js`), `claimsFor`/`ingestQuestion`/`corpusIdFor` (`../ingest.js`), `evaluationInstant` (`../answer.js`), `RULE` (`../../../src/distribution/rules.js`), `MANUAL_KEY_CARDINALITY` (`../run.js`), `LmeQuestion`/`ClaimRecord`/`CacheHeader`/`categoryOf`/`normalizeQuestion`/`type LmeQuestionT`/`type ClaimRecordT` (`../types.js`), `EXTRACTION_MODEL`/`PROMPT_VERSION` (`../../convert/longmemeval.js`), `parseArgs`/fs/os/path.
- Produces: `export async function main(argv: string[], opts?: { onError?: (m: string) => void; judge?: JudgeFn }): Promise<number>`.

- [ ] **Step 1: Write the failing test**

Create `bench/longmemeval/manual/answer-judge-sweep.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./answer-judge-sweep.js";
import type { JudgeFn } from "./answer-correctness-judge.js";

// Deterministic stub judge — no network. "correct" iff the gold appears in any
// context line. (This is only a wiring stub; the real run uses the LLM judge.)
const stubJudge: JudgeFn = async (item) => ({
  correct: item.context.some((c) => c.includes(item.gold)),
  reason: "stub",
});

describe("answer-judge-sweep CLI", () => {
  it("errors without --file/--claims", async () => {
    const errs: string[] = [];
    const code = await main([], { onError: (m) => errs.push(m), judge: stubJudge });
    expect(code).toBe(1);
    expect(errs.join(" ")).toMatch(/--file and --claims are required/);
  });

  it("runs the fixture end-to-end with a stub judge: columns + verdict render", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "ajs-")), "judgments.jsonl");
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
    try {
      const code = await main(
        // NO --raw: the fixture is already normalized (Zod) form; --raw would route
        // through normalizeQuestion (raw-HF fields) and crash. --raw is for the oracle only.
        ["--file", "bench/longmemeval/fixtures/dataset.json",
         "--claims", "bench/longmemeval/fixtures/claims.jsonl",
         "--alphas", "1.0,0.0", "--out", out],
        { judge: stubJudge },
      );
      expect(code).toBe(0);
    } finally { console.log = orig; }
    const text = logs.join("\n");
    expect(text).toMatch(/answerInContext/);
    expect(text).toMatch(/CONFIRMED|REFUTED|NEUTRAL/);
  });

  it("resumes from cache without re-judging (second run reports 0 new)", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "ajs-")), "judgments.jsonl");
    const args = ["--file", "bench/longmemeval/fixtures/dataset.json",
      "--claims", "bench/longmemeval/fixtures/claims.jsonl",
      "--alphas", "1.0", "--out", out]; // no --raw: fixture is normalized (see above)
    await main(args, { judge: stubJudge });
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
    try { await main(args, { judge: stubJudge }); } finally { console.log = orig; }
    expect(logs.join("\n")).toMatch(/0 new|cached/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run bench/longmemeval/manual/answer-judge-sweep.test.ts`
Expected: FAIL — `Cannot find module './answer-judge-sweep.js'`.

- [ ] **Step 3: Write the implementation**

Create `bench/longmemeval/manual/answer-judge-sweep.ts`:

```ts
/**
 * Real-answer confirmation sweep (bench-only). For a few ranking cells, render
 * the served top-CONTEXT_K context (resolveOnly + rankBlend) and ask the LLM
 * judge whether it answers the question. Reports answerInContext per (cell,
 * category) vs the alpha=1 baseline. Judgments are cached + resume-safe.
 *
 * Spec: docs/superpowers/specs/2026-06-18-real-answer-confirmation-design.md
 *
 *   tsx bench/longmemeval/manual/answer-judge-sweep.ts \
 *     --file bench/datasets/longmemeval/longmemeval_oracle_target.json \
 *     --claims bench/datasets/longmemeval/longmemeval-oracle-claims.jsonl \
 *     --out bench/longmemeval/manual/data/answer-judgments.jsonl --raw [--limit N] [--alphas ...]
 */
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "../../../src/surface/index.js";
import { RULE } from "../../../src/distribution/rules.js";
import { resolveOnly } from "./drift-resolution-metrics.js";
import { rankBlend } from "./rank-blend.js";
import {
  judgeAnswerInContext, renderContextClaim, judgeCacheKey, loadJudgeCache,
  appendJudgeHeaderIfNew, appendJudgeRecord,
  ANSWER_JUDGE_MODEL, ANSWER_JUDGE_PROMPT_VERSION, CONTEXT_K,
  type JudgeFn, type JudgeRecord,
} from "./answer-correctness-judge.js";
import { claimsFor, ingestQuestion, corpusIdFor } from "../ingest.js";
import { evaluationInstant } from "../answer.js";
import {
  LmeQuestion, ClaimRecord, CacheHeader, categoryOf, normalizeQuestion,
  type LmeQuestionT, type ClaimRecordT,
} from "../types.js";
import { EXTRACTION_MODEL, PROMPT_VERSION } from "../../convert/longmemeval.js";
import { MANUAL_KEY_CARDINALITY } from "../run.js";

const TARGET_CATEGORIES = new Set(["knowledge-update", "temporal-reasoning"]); // abstention excluded
const DAY_MS = 86_400_000;
const MAX_K_SURVIVORS = 10;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const cellLabel = (alpha: number): string => `a${alpha}`;

interface QState { q: LmeQuestionT; category: string; corpusId: string; survivors: readonly import("../../../src/core/claim.js").Claim[]; t: number; gold: string }

export async function main(
  argv: string[],
  opts?: { onError?: (m: string) => void; judge?: JudgeFn },
): Promise<number> {
  const logError = (m: string): void => { console.error(m); opts?.onError?.(m); };

  const { values } = parseArgs({
    args: argv,
    options: {
      file: { type: "string" },
      claims: { type: "string" },
      out: { type: "string", default: "bench/longmemeval/manual/data/answer-judgments.jsonl" },
      alphas: { type: "string", default: "1.0,0.25,0.5,0.0" },
      "half-life-days": { type: "string", default: "90" },
      limit: { type: "string" },
      raw: { type: "boolean", default: false },
    },
  });
  if (!values.file || !values.claims) { logError("--file and --claims are required"); return 1; }

  const alphas = String(values.alphas).split(",").map((s) => parseFloat(s.trim()));
  if (alphas.some((a) => Number.isNaN(a) || a < 0 || a > 1)) { logError("--alphas must be in [0,1]"); return 1; }
  const halfLifeMs = parseFloat(String(values["half-life-days"])) * DAY_MS;
  const limit = values.limit !== undefined ? parseInt(String(values.limit), 10) : Infinity;
  const outPath = String(values.out);

  // judge: injected stub (tests) or the real LLM judge bound to the env key.
  let judge = opts?.judge;
  if (!judge) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) { logError("ANTHROPIC_API_KEY not set (and no judge injected)"); return 1; }
    judge = (item) => judgeAnswerInContext(apiKey, item);
  }

  // --- load dataset + claims (run.ts discipline) ---
  const datasetRaw = JSON.parse(readFileSync(values.file, "utf-8")) as unknown[];
  const questions: LmeQuestionT[] = datasetRaw
    .map((r) => (values.raw ? normalizeQuestion(r) : LmeQuestion.parse(r)))
    .filter((q) => TARGET_CATEGORIES.has(categoryOf(q)));
  const lines = readFileSync(values.claims, "utf-8").split("\n").filter((l) => l.trim().length > 0);
  const header = CacheHeader.parse(JSON.parse(lines[0]));
  if (header.model !== EXTRACTION_MODEL || header.promptVersion !== PROMPT_VERSION) {
    logError(`Claims cache header mismatch: model=${header.model}, promptVersion=${header.promptVersion}`); return 1;
  }
  const allClaims: ClaimRecordT[] = lines.slice(1).map((l) => ClaimRecord.parse(JSON.parse(l)));

  // --- single ingest; precompute survivors + gold per question ---
  const dir = mkdtempSync(join(tmpdir(), "mneme-ajudge-"));
  const session = openSession({ dbPath: join(dir, "lme.db"), writer: "answer-judge", source: "imported" });
  try {
    const qstates: QState[] = [];
    for (const q of questions) {
      const corpusId = corpusIdFor(q.question_id);
      ingestQuestion(session, q, claimsFor(q, allClaims, { oracle: true }));
      const survivors = resolveOnly(session, corpusId, q, {
        keyCardinality: MANUAL_KEY_CARDINALITY, evidencePoolingRule: RULE.MAX_MEAN,
      });
      qstates.push({ q, category: categoryOf(q), corpusId, survivors, t: evaluationInstant(q), gold: String(q.answer) });
    }
    console.log(`questions: ${qstates.length} (` +
      `KU ${qstates.filter((s) => s.category === "knowledge-update").length}, ` +
      `TR ${qstates.filter((s) => s.category === "temporal-reasoning").length})`);

    // --- cache ---
    const cacheHeader = { model: ANSWER_JUDGE_MODEL, promptVersion: ANSWER_JUDGE_PROMPT_VERSION, contextK: CONTEXT_K };
    appendJudgeHeaderIfNew(outPath, cacheHeader);
    const cache = loadJudgeCache(outPath, cacheHeader);
    console.log(`cached judgments: ${cache.size}`);

    // --- judge each (cell, question), reusing cache ---
    let newCount = 0;
    const records: JudgeRecord[] = [...cache.values()];
    outer: for (const alpha of alphas) {
      const cell = cellLabel(alpha);
      for (const s of qstates) {
        const key = judgeCacheKey(cell, s.q.question_id);
        if (cache.has(key)) continue;
        if (newCount >= limit) { console.log(`--limit ${limit} reached; stopping`); break outer; }
        const ordered = rankBlend(s.survivors, s.q.question, { alpha, halfLifeMs, t: s.t });
        const context = ordered.slice(0, CONTEXT_K).map(renderContextClaim);
        // Empty context (no survivors) → false, no API call (spec §4).
        const verdict = context.length === 0
          ? { correct: false, reason: "empty context" }
          : await judge({ question: s.q.question, gold: s.gold, context });
        const rec: JudgeRecord = { cell, questionId: s.q.question_id, category: s.category, correct: verdict.correct, reason: verdict.reason };
        appendJudgeRecord(outPath, rec);
        cache.set(key, rec);
        records.push(rec);
        newCount++;
      }
    }
    console.log(`judged this run: ${newCount} new (rest cached)`);

    // --- aggregate answerInContext per (cell, category) ---
    const rate = (cell: string, cat: string): { v: number; n: number } => {
      const rs = records.filter((r) => r.cell === cell && r.category === cat);
      const n = rs.length;
      return { v: n ? rs.filter((r) => r.correct).length / n : 0, n };
    };
    console.log("| alpha | category | answerInContext | n |");
    console.log("|---|---|---|---|");
    for (const alpha of alphas) {
      for (const cat of ["knowledge-update", "temporal-reasoning"]) {
        const { v, n } = rate(cellLabel(alpha), cat);
        console.log(`| ${alpha} | ${cat} | ${r3(v)} | ${n} |`);
      }
    }

    // --- verdict vs alpha=1 baseline ---
    const baseKU = rate(cellLabel(1.0), "knowledge-update").v;
    const baseTR = rate(cellLabel(1.0), "temporal-reasoning").v;
    console.log(`\nverdict (baseline KU ${r3(baseKU)}, TR ${r3(baseTR)}):`);
    for (const alpha of alphas) {
      if (alpha === 1.0) continue;
      const dKU = rate(cellLabel(alpha), "knowledge-update").v - baseKU;
      const dTR = rate(cellLabel(alpha), "temporal-reasoning").v - baseTR;
      const label = dKU > 0 && dTR >= 0 ? "CONFIRMED" : dKU <= 0 ? "REFUTED-KU" : "REFUTED-TR";
      console.log(`  alpha=${alpha}: dKU ${r3(dKU)} dTR ${r3(dTR)} → ${label}`);
    }
    return 0;
  } finally {
    session.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

if (process.argv[1] && process.argv[1].endsWith("answer-judge-sweep.ts")) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
```

- [ ] **Step 4: Run the fixture test**

Run: `npx vitest run bench/longmemeval/manual/answer-judge-sweep.test.ts`
Expected: PASS. The fixture has a KU and a TR question (`fx-ku-1`, `fx-tr-1`); abstention (`fx-abs-1_abs`) is filtered out by `TARGET_CATEGORIES`. If the dataset/claims path or `--raw` handling diverges, align to `ranking-variant-sweep.ts`'s loader (it uses the same idiom). The fixture `q.answer` values are present (verified) so `String(q.answer)` is non-empty.

- [ ] **Step 5: Typecheck + full new-suite**

Run: `npx tsc --noEmit` (catches `src` regressions only — `bench/**` is outside tsconfig `include`, so it does NOT validate the new bench files; the vitest run below is their real gate).
Run: `npx vitest run bench/longmemeval/manual/answer-correctness-judge.test.ts bench/longmemeval/manual/answer-judge-sweep.test.ts`
Expected: tsc clean for src; both test files green (this is the authoritative check for the bench files).

- [ ] **Step 6: Commit** *(HELD)*

```bash
git add bench/longmemeval/manual/answer-judge-sweep.ts bench/longmemeval/manual/answer-judge-sweep.test.ts
git commit -m "feat(bench): answer-judge sweep — answerInContext per cell, cached + injectable judge"
```

---

## Post-implementation: smoke, then the real judged run

1. **Smoke** (≈1¢): `npx tsx bench/longmemeval/manual/smoke-answer-judge.ts` — must print `VERDICT: OK`.
2. **Cost estimate + approval:** ~4 cells × (72 KU + ~127 TR) ≈ 800 sonnet judgments (~$2–3). Confirm before the bulk run. Use `--limit 20` for a partial first pass and inspect the cache.
3. **Real run:**
   ```bash
   npx tsx bench/longmemeval/manual/answer-judge-sweep.ts \
     --file bench/datasets/longmemeval/longmemeval_oracle_target.json \
     --claims bench/datasets/longmemeval/longmemeval-oracle-claims.jsonl \
     --out bench/longmemeval/manual/data/answer-judgments.jsonl --raw
   ```
4. Read the verdict per spec §1/§7: CONFIRMED (a blend lifts KU answerInContext, holds TR) → proceed to the `src`-promotion cycle; REFUTED-KU / REFUTED-TR → the proxy misled / recall tradeoff bites. Record the table + verdict in `bench/RESULTS.md`, commit the judgments JSONL (deterministic replay), and update memory `drift-injection-null-result`.
5. **Judge-error bound:** run a stratified human spot-check (~50 judgments) per the `spot-check-sheet.md` pattern; report the judge-error rate alongside the verdict.

## Commit policy (this run)

All commits HELD per the user. Implement + verify each task leaving the tree staged-but-uncommitted; commit steps run only on release. Spec and plan likewise uncommitted (on `feat/real-answer-confirmation` in the `Mneme-realanswer` worktree).

---

## Self-Review

**Spec coverage:**
- §3 files → Task 1 (`answer-correctness-judge.ts` + test + `smoke-answer-judge.ts`), Task 2 (`answer-judge-sweep.ts` + test). ✓
- §4 judge (render with date for all categories, gold stringify, no substring pre-check, json_schema mirroring ratify-judge, cache header+torn-write NET-NEW) → Task 1. ✓
- §5 driver (4 cells, KU+TR, k=5, answerInContext, verdict CONFIRMED/REFUTED-KU/REFUTED-TR, runtime counts, --limit, cost note) → Task 2 + Post-implementation. ✓
- §2 injectable judge, bench-only, no src → honored (opts.judge, only new files). ✓
- §6 validation (spot-check) + determinism (cache, clock-free path) → Post-implementation + constraints. ✓
- §7 forks → Post-implementation step 4. ✓
- §8 out-of-scope (no src, no opus, no top-1, abstention excluded, 4 cells) → honored. ✓

**Placeholder scan:** none. `as unknown as Claim`/`as unknown as LmeQuestionT` casts are deliberate minimal test fixtures (the code reads only the named fields). Step 4 of each task names the real-schema fallback.

**Type consistency:** `JudgeItem`/`JudgeVerdict`/`JudgeFn`/`JudgeRecord`/`judgeCacheKey`/`loadJudgeCache`/`renderContextClaim`/`ANSWER_JUDGE_MODEL`/`CONTEXT_K` named identically across Task 1 (def), Task 1 tests, and Task 2 (consumption). `resolveOnly(session, corpusId, q, {keyCardinality, evidencePoolingRule})` and `rankBlend(survivors, query, {alpha, halfLifeMs, t})` match the bench-branch signatures. `corpusIdFor`/`evaluationInstant`/`claimsFor`/`ingestQuestion`/`categoryOf`/`normalizeQuestion`/`MANUAL_KEY_CARDINALITY`/`RULE` match their modules. Request shape matches `ratify-judge.ts:127-145` and is confirmed-current by the claude-api skill.
