# Drift arm refinement: resolution-vs-served recovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure the "ranking tax" in the drift-injection arm — resolution wins that aliasing produces but the jaccard-ranked served answer fails to surface — by adding a ranking-free resolution-layer measurement alongside the existing served-layer `updateCorrect`.

**Architecture:** A pure helper module (`drift-resolution-metrics.ts`) provides a `resolveOnly` runner (canonical read core, no ranking tail) plus KU-only metrics over the ≥2-answer-session subset. The existing `drift-injection-sweep.ts` calls it per question alongside arm A and reports the resolution metrics, a fragmentation-count denominator, and a per-question ranking-tax conjunction.

**Tech Stack:** TypeScript, `tsx`, `vitest`, Mneme session surface. Bench-only; no `src/` change.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-17-drift-resolution-vs-served-design.md` — binds every task.
- **No modification** to any `src/` file, nor to `bench/longmemeval/score.ts`, `answer.ts`, `ingest.ts`, `types.ts`, `run.ts`, or `drift-injector.ts`. Only the two files named below.
- **Resolution metrics are scorable only when** `categoryOf(q) === "knowledge-update"` AND `q.answer_session_ids.length >= 2`; otherwise the metric is `undefined` (excluded from the denominator).
- **`resolveOnly` mirrors `answerArmA` minus the ranking tail** — same opts (`keyCardinality`, `keyAliases`, `evidencePoolingRule`), same `evaluationInstant(q)`; it omits `conflictThreshold`/`dedupeCutoff` because the sweep's arm A also omits them (defaults match).
- **`latestAnswerSessionId` must match `score.ts:53-75` exactly:** iterate `answer_session_ids` in order, key dates via `q.sessions[].sessionId → parseLmeInstant(date)`, keep candidate with `ms >= latestMs` (last-on-tie).
- **Ranking-tax is a per-question conjunction**, not a difference of aggregate deltas: `dropped(q) = staleDeprec(q) === true && updateCorrect(q) === false`, headline = `rate(dropped) on − rate(dropped) off`.
- **`recencyTop1` is a negative control** — expected ≈0 on−off; report, don't weight.
- **Determinism:** measurement loop stays clock-free (`new Date()` only in `--append-results` output).
- **Imports use `.js` extensions** (NodeNext).
- **Test runner:** `npx vitest run <path>`; typecheck `npx tsc --noEmit`.
- **Commit hold:** this run is under a strict commit hold — do NOT run `git commit`/`git add`. Leave changes in the working tree. (Per-task "Commit" steps are HELD; run only when the user releases the hold.)

---

### Task 1: Resolution-layer runner + metrics module

**Files:**
- Create: `bench/longmemeval/manual/drift-resolution-metrics.ts`
- Test: `bench/longmemeval/manual/drift-resolution-metrics.test.ts`

**Interfaces:**
- Consumes: `leaf`, `pipe` from `src/index.js`; `Corpus` from `src/algebra/types.js`; `Claim` from `src/core/claim.js` (fields used: `key`, `tags: string[]`, `valid.from: number`, `recordedSeq: number`); `canonicalReadStages` from `src/retrieval/read-pipeline.js`; `Session` from `src/surface/index.js`; `LmeQuestionT`, `categoryOf`, `parseLmeInstant` from `bench/longmemeval/types.js`; `evaluationInstant` from `bench/longmemeval/answer.js`.
- Produces:
  - `interface ResolveOnlyOpts { keyCardinality?: Record<string,"single"|"multi">; keyAliases?: Record<string,string>; evidencePoolingRule?: string }`
  - `resolveOnly(session: Session, corpusId: string, q: LmeQuestionT, opts: ResolveOnlyOpts): readonly Claim[]`
  - `latestAnswerSessionId(q: LmeQuestionT): string | null`
  - `sessionTagOf(c: Claim): string | null`
  - `isResolutionScorable(q: LmeQuestionT): boolean`
  - `staleDeprecationCorrect(q: LmeQuestionT, survivors: readonly Claim[]): boolean | undefined`
  - `recencyTop1Correct(q: LmeQuestionT, survivors: readonly Claim[]): boolean | undefined`
  - `droppedByRanking(q: LmeQuestionT, survivors: readonly Claim[], updateCorrect: boolean | undefined): boolean | undefined`
  - `lineageFragmented(q: LmeQuestionT, questionClaims: readonly Claim[], aliasMap: Record<string,string>): boolean | undefined`

- [ ] **Step 1: Write the failing unit tests (pure metrics)**

Create `bench/longmemeval/manual/drift-resolution-metrics.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Claim } from "../../../src/core/claim.js";
import type { LmeQuestionT } from "../types.js";
import {
  latestAnswerSessionId, sessionTagOf, isResolutionScorable,
  staleDeprecationCorrect, recencyTop1Correct, droppedByRanking, lineageFragmented,
} from "./drift-resolution-metrics.js";

// Minimal claim — metrics read only key, tags, valid.from, recordedSeq.
function claim(key: string, session: string, validFrom: number, recordedSeq = 0): Claim {
  return { key, tags: [`session:${session}`, "turn:0"], valid: { from: validFrom, to: Infinity }, recordedSeq } as unknown as Claim;
}

// KU question, sessions s-old (May) < s-new (Jun), both answer sessions.
const Q: LmeQuestionT = {
  question_id: "ku_1", question_type: "knowledge-update",
  question: "?", question_date: "2023/07/01 (Sat) 10:00", answer: "Y",
  sessions: [
    { sessionId: "s-old", date: "2023/05/01 (Mon) 10:00", turns: [] },
    { sessionId: "s-mid", date: "2023/05/15 (Mon) 10:00", turns: [] },
    { sessionId: "s-new", date: "2023/06/01 (Thu) 10:00", turns: [] },
  ],
  answer_session_ids: ["s-old", "s-new"],
} as unknown as LmeQuestionT;

const Q1: LmeQuestionT = { ...Q, answer_session_ids: ["s-new"] } as LmeQuestionT; // single answer session
const QNON: LmeQuestionT = { ...Q, question_type: "single-session-user" } as unknown as LmeQuestionT;

describe("latestAnswerSessionId", () => {
  it("returns the latest-dated answer session", () => {
    expect(latestAnswerSessionId(Q)).toBe("s-new");
  });
  it("null when no answer sessions", () => {
    expect(latestAnswerSessionId({ ...Q, answer_session_ids: [] } as LmeQuestionT)).toBeNull();
  });
});

describe("sessionTagOf", () => {
  it("extracts the session id", () => {
    expect(sessionTagOf(claim("employer", "s-new", 2))).toBe("s-new");
  });
});

describe("isResolutionScorable", () => {
  it("true for KU with >=2 answer sessions", () => expect(isResolutionScorable(Q)).toBe(true));
  it("false for KU with 1 answer session", () => expect(isResolutionScorable(Q1)).toBe(false));
  it("false for non-KU", () => expect(isResolutionScorable(QNON)).toBe(false));
});

describe("staleDeprecationCorrect", () => {
  it("false when a stale (non-latest) answer-session claim survives", () => {
    const survivors = [claim("employer", "s-old", 1), claim("current_employer", "s-new", 2)];
    expect(staleDeprecationCorrect(Q, survivors)).toBe(false);
  });
  it("true when only the latest answer-session claim survives", () => {
    expect(staleDeprecationCorrect(Q, [claim("employer", "s-new", 2)])).toBe(true);
  });
  it("true with multiple latest-session claims (no non-latest survivor)", () => {
    expect(staleDeprecationCorrect(Q, [claim("employer", "s-new", 2), claim("city", "s-new", 3)])).toBe(true);
  });
  it("3-session lineage: middle survivor (only oldest deprecated) → false (complete-collapse bar)", () => {
    // pairwise resolve left s-mid alive alongside s-new
    const survivors = [claim("employer", "s-mid", 2), claim("preferred_employer", "s-new", 3)];
    const Q3 = { ...Q, answer_session_ids: ["s-old", "s-mid", "s-new"] } as LmeQuestionT;
    expect(staleDeprecationCorrect(Q3, survivors)).toBe(false);
  });
  it("undefined for single-answer-session and non-KU", () => {
    expect(staleDeprecationCorrect(Q1, [])).toBeUndefined();
    expect(staleDeprecationCorrect(QNON, [])).toBeUndefined();
  });
});

describe("recencyTop1Correct (negative control)", () => {
  it("true when the newest survivor is on the latest session", () => {
    const survivors = [claim("employer", "s-old", 1000), claim("current_employer", "s-new", 2000)];
    expect(recencyTop1Correct(Q, survivors)).toBe(true);
  });
  it("false when the newest survivor is on a stale session", () => {
    const survivors = [claim("employer", "s-new", 1000), claim("x", "s-old", 5000)];
    // s-old claim has larger validFrom here → newest-by-validFrom is the stale one
    expect(recencyTop1Correct(Q, survivors)).toBe(false);
  });
  it("valid.from tie broken by recordedSeq then last-in-array (deterministic)", () => {
    const a = claim("a", "s-old", 1000, 1);
    const b = claim("b", "s-new", 1000, 2);
    expect(recencyTop1Correct(Q, [a, b])).toBe(true);  // b wins tie (higher recordedSeq, on latest)
  });
  it("false on empty survivors", () => expect(recencyTop1Correct(Q, [])).toBe(false));
});

describe("droppedByRanking", () => {
  it("true iff resolution succeeded but served (top-1) failed", () => {
    const collapsed = [claim("employer", "s-new", 2)]; // staleDeprec true
    expect(droppedByRanking(Q, collapsed, false)).toBe(true);
    expect(droppedByRanking(Q, collapsed, true)).toBe(false);
    const notCollapsed = [claim("employer", "s-old", 1), claim("v", "s-new", 2)]; // staleDeprec false
    expect(droppedByRanking(Q, notCollapsed, false)).toBe(false);
  });
  it("undefined when not scorable", () => expect(droppedByRanking(Q1, [], false)).toBeUndefined());
});

describe("lineageFragmented", () => {
  it("true when answer-session claims split a canonical group across keys", () => {
    const qClaims = [claim("employer", "s-old", 1), claim("current_employer", "s-new", 2)];
    expect(lineageFragmented(Q, qClaims, { current_employer: "employer" })).toBe(true);
  });
  it("false when answer-session claims share one key (no split)", () => {
    const qClaims = [claim("employer", "s-old", 1), claim("employer", "s-new", 2)];
    expect(lineageFragmented(Q, qClaims, {})).toBe(false);
  });
  it("undefined when not scorable", () => expect(lineageFragmented(Q1, [], {})).toBeUndefined());
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run bench/longmemeval/manual/drift-resolution-metrics.test.ts`
Expected: FAIL — `Cannot find module './drift-resolution-metrics.js'`.

- [ ] **Step 3: Write the implementation**

Create `bench/longmemeval/manual/drift-resolution-metrics.ts`:

```ts
/**
 * Resolution-layer measurement for the drift-injection arm (bench-only).
 *
 * resolveOnly = answerArmA minus the ranking tail (canonicalReadStages only),
 * so its survivors isolate RESOLUTION from RANKING. The metrics quantify the
 * "ranking tax": resolution wins (stale claim deprecated) that the jaccard
 * served top-1 fails to surface.
 *
 * Spec: docs/superpowers/specs/2026-06-17-drift-resolution-vs-served-design.md
 */
import { leaf, pipe } from "../../../src/index.js";
import type { Corpus } from "../../../src/algebra/types.js";
import type { Claim } from "../../../src/core/claim.js";
import { canonicalReadStages } from "../../../src/retrieval/read-pipeline.js";
import type { Session } from "../../../src/surface/index.js";
import { categoryOf, parseLmeInstant, type LmeQuestionT } from "../types.js";
import { evaluationInstant } from "../answer.js";

export interface ResolveOnlyOpts {
  keyCardinality?: Record<string, "single" | "multi">;
  keyAliases?: Record<string, string>;
  evidencePoolingRule?: string;
}

/** Canonical read core with NO ranking tail — answerArmA minus rankedTailStages. */
export function resolveOnly(
  session: Session, corpusId: string, q: LmeQuestionT, opts: ResolveOnlyOpts,
): readonly Claim[] {
  const t = evaluationInstant(q);
  const stages = pipe(
    leaf(corpusId),
    ...canonicalReadStages({
      evaluationInstant: t,
      keyCardinality: opts.keyCardinality,
      keyAliases: opts.keyAliases,
      evidencePoolingRule: opts.evidencePoolingRule,
    }),
  );
  return session.mneme.query<Corpus>(corpusId, stages, { evaluationClock: t }).claims;
}

/** Latest answer session by date; ties → last in answer_session_ids. Mirrors score.ts:53-75. */
export function latestAnswerSessionId(q: LmeQuestionT): string | null {
  if (q.answer_session_ids.length === 0) return null;
  const dateMap = new Map<string, number>();
  for (const s of q.sessions) dateMap.set(s.sessionId, parseLmeInstant(s.date));
  let latestId: string | null = null;
  let latestMs = -Infinity;
  for (const sid of q.answer_session_ids) {
    const ms = dateMap.get(sid);
    if (ms === undefined) continue;
    if (ms >= latestMs) { latestMs = ms; latestId = sid; }
  }
  return latestId;
}

export function sessionTagOf(c: Claim): string | null {
  const tag = c.tags.find((t) => t.startsWith("session:"));
  return tag ? tag.slice("session:".length) : null;
}

/** Scorable ⇔ KU and a lineage exists to fragment/collapse (≥2 answer sessions). */
export function isResolutionScorable(q: LmeQuestionT): boolean {
  return categoryOf(q) === "knowledge-update" && q.answer_session_ids.length >= 2;
}

/** True ⇔ no surviving claim traces to a NON-latest answer session (complete collapse). */
export function staleDeprecationCorrect(q: LmeQuestionT, survivors: readonly Claim[]): boolean | undefined {
  if (!isResolutionScorable(q)) return undefined;
  const latest = latestAnswerSessionId(q);
  if (latest === null) return undefined;
  const answerIds = new Set(q.answer_session_ids);
  for (const c of survivors) {
    const s = sessionTagOf(c);
    if (s !== null && answerIds.has(s) && s !== latest) return false;
  }
  return true;
}

/** Negative control: newest-by-valid.from survivor is on the latest session. */
export function recencyTop1Correct(q: LmeQuestionT, survivors: readonly Claim[]): boolean | undefined {
  if (!isResolutionScorable(q)) return undefined;
  const latest = latestAnswerSessionId(q);
  if (latest === null) return undefined;
  if (survivors.length === 0) return false;
  let best = survivors[0];
  for (const c of survivors) {
    if (c.valid.from > best.valid.from) best = c;
    else if (c.valid.from === best.valid.from && c.recordedSeq >= best.recordedSeq) best = c;
  }
  return sessionTagOf(best) === latest;
}

/** Per-question ranking tax: resolution succeeded but served top-1 failed. */
export function droppedByRanking(
  q: LmeQuestionT, survivors: readonly Claim[], updateCorrect: boolean | undefined,
): boolean | undefined {
  const sd = staleDeprecationCorrect(q, survivors);
  if (sd === undefined) return undefined;
  return sd === true && updateCorrect === false;
}

/** Did drift split a canonical group across keys among this question's answer-session claims? */
export function lineageFragmented(
  q: LmeQuestionT, questionClaims: readonly Claim[], aliasMap: Record<string, string>,
): boolean | undefined {
  if (!isResolutionScorable(q)) return undefined;
  const answerIds = new Set(q.answer_session_ids);
  const byCanonical = new Map<string, Set<string>>();
  for (const c of questionClaims) {
    const s = sessionTagOf(c);
    if (s === null || !answerIds.has(s)) continue;
    const canonical = aliasMap[c.key] ?? c.key;
    const set = byCanonical.get(canonical) ?? new Set<string>();
    set.add(c.key);
    byCanonical.set(canonical, set);
  }
  for (const set of byCanonical.values()) if (set.size >= 2) return true;
  return false;
}
```

- [ ] **Step 4: Run unit tests to verify they pass**

Run: `npx vitest run bench/longmemeval/manual/drift-resolution-metrics.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Add the `resolveOnly` integration test**

Append to `bench/longmemeval/manual/drift-resolution-metrics.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "../../../src/surface/index.js";
import { ingestQuestion } from "../ingest.js";
import { MANUAL_KEY_CARDINALITY } from "../run.js";
import { RULE } from "../../../src/distribution/rules.js";
import { resolveOnly } from "./drift-resolution-metrics.js";
import type { ClaimRecordT } from "../types.js";

describe("resolveOnly (integration)", () => {
  // alice employer Initech (s-old) → Globex (s-new); a stale claim under a drifted key.
  const QI = {
    question_id: "ro_1", question_type: "knowledge-update", question: "?",
    question_date: "2023/07/01 (Sat) 10:00", answer: "Globex",
    sessions: [
      { sessionId: "s-old", date: "2023/05/01 (Mon) 10:00", turns: [] },
      { sessionId: "s-new", date: "2023/06/01 (Thu) 10:00", turns: [] },
    ],
    answer_session_ids: ["s-old", "s-new"],
  } as unknown as LmeQuestionT;

  const records: ClaimRecordT[] = [
    { subject: "alice", key: "preferred_employer", value: "Initech", validFrom: Date.UTC(2023,4,1), tags: ["session:s-old","turn:0"] },
    { subject: "alice", key: "employer", value: "Globex", validFrom: Date.UTC(2023,5,1), tags: ["session:s-new","turn:0"] },
  ];

  function run(aliased: boolean): readonly Claim[] {
    const dir = mkdtempSync(join(tmpdir(), "drift-ro-"));
    const session = openSession({ dbPath: join(dir, "lme.db"), writer: "drift-ro", source: "imported" });
    try {
      ingestQuestion(session, QI, records);
      return resolveOnly(session, `lme-${QI.question_id}`, QI, {
        keyCardinality: MANUAL_KEY_CARDINALITY,
        keyAliases: aliased ? { preferred_employer: "employer" } : undefined,
        evidencePoolingRule: RULE.MAX_MEAN,
      });
    } finally {
      session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("WITHOUT aliases: stale claim survives (no ranking applied) → staleDeprec false", () => {
    const survivors = run(false);
    expect(staleDeprecationCorrect(QI, survivors)).toBe(false);
  });
  it("WITH oracle alias map: stale deprecated → staleDeprec true", () => {
    const survivors = run(true);
    expect(staleDeprecationCorrect(QI, survivors)).toBe(true);
  });
});
```

- [ ] **Step 6: Run the full test file + typecheck**

Run: `npx vitest run bench/longmemeval/manual/drift-resolution-metrics.test.ts`
Expected: PASS (units + integration).
Run: `npx tsc --noEmit`
Expected: no errors. (If `Q`/`QI` literals miss a required `LmeQuestionT` field, align to `bench/longmemeval/types.ts` — the `as unknown as` casts cover optional fields, but `sessions[].turns` is required.)

- [ ] **Step 7: Commit** *(HELD — see Global Constraints; run only on hold release)*

```bash
git add bench/longmemeval/manual/drift-resolution-metrics.ts bench/longmemeval/manual/drift-resolution-metrics.test.ts
git commit -m "feat(bench): resolution-layer runner + ranking-tax metrics"
```

---

### Task 2: Wire resolution metrics into the sweep + output

**Files:**
- Modify: `bench/longmemeval/manual/drift-injection-sweep.ts`
- Test: `bench/longmemeval/manual/drift-injection-sweep.test.ts`

**Interfaces:**
- Consumes (Task 1): `resolveOnly`, `isResolutionScorable`, `staleDeprecationCorrect`, `recencyTop1Correct`, `droppedByRanking`, `lineageFragmented`. Plus existing `claimsFor` (already imported), `RULE`, `MANUAL_KEY_CARDINALITY`, `answerArmA`, `scoreQuestion`.
- Produces: an augmented `Cell` carrying `res: { staleDeprec: number; recencyTop1: number; dropped: number; nRes: number; fragLineages: number }`, plus new table columns and a resolution dose-response block.

- [ ] **Step 1: Write the failing sweep test additions**

Add to `bench/longmemeval/manual/drift-injection-sweep.test.ts` (inside the existing `describe`):

```ts
it("fixture run reports resolution columns and zero fragmentation at f=0", async () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try {
    const code = await main([
      "--file", "bench/longmemeval/fixtures/dataset.json",
      "--claims", "bench/longmemeval/fixtures/claims.jsonl",
      "--fractions", "0,1.0", "--modes", "morph",
      "--expect-update-correct", "1.0",
    ]);
    expect(code).toBe(0);
  } finally { console.log = orig; }
  const out = logs.join("\n");
  expect(out).toMatch(/staleDeprec/);          // new table column header
  expect(out).toMatch(/fragLineages/);          // fragmentation instrument
  expect(out).toMatch(/ranking tax|dropped/i);  // tax line present
  // f=0 has no injected drift → fragLineages (last table column) must be 0 for the f=0 morph off row.
  expect(out).toMatch(/\|\s*0\s*\|\s*morph\s*\|\s*off\s*\|.*\|\s*0\s*\|\s*$/m);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run bench/longmemeval/manual/drift-injection-sweep.test.ts`
Expected: FAIL — output lacks `staleDeprec`/`fragLineages`/tax until wired.

- [ ] **Step 3: Add imports**

In `bench/longmemeval/manual/drift-injection-sweep.ts`, add to the import block:

```ts
import {
  resolveOnly, isResolutionScorable, staleDeprecationCorrect,
  recencyTop1Correct, droppedByRanking, lineageFragmented,
} from "./drift-resolution-metrics.js";
```

- [ ] **Step 4: Extend the `Cell` type and the measurement loop**

Find the **existing `export interface Cell`** (drift-injection-sweep.ts:43 — it IS exported; edit it in place, keep the `export`) and add a `res` field:

```ts
export interface Cell {
  fraction: number;
  mode: string;
  aliased: boolean;
  rows: ScoreRow[];
  coverage?: { eligibleKeys: number; driftedKeys: number; noVariantKeys: number };
  res: { staleDeprec: number; recencyTop1: number; dropped: number; nRes: number; fragLineages: number };
}
```

Replace the inner `for (const aliased of [false, true])` block (currently sweep lines ~132-145) with this version that also computes resolution metrics per question:

```ts
        // fragLineages is aliasing-independent (drift split is fixed per cell) — compute once.
        let fragLineages = 0;
        for (const q of questions) {
          if (!isResolutionScorable(q)) continue;
          if (lineageFragmented(q, claimsFor(q, drifted, { oracle: true }), aliasMap) === true) fragLineages++;
        }

        for (const aliased of [false, true]) {
          const scores: QuestionScore[] = [];
          let sdSum = 0, rtSum = 0, dropSum = 0, nRes = 0;
          for (const q of questions) {
            const res = answerArmA(session, `lme-${q.question_id}`, q, {
              k: MAX_K, keyCardinality: MANUAL_KEY_CARDINALITY,
              abstainBelowTop: 0, relevanceFloor: 0,
              keyAliases: aliased ? aliasMap : undefined,
              evidencePoolingRule: RULE.MAX_MEAN,
            });
            const qScore = scoreQuestion(q, res, KS);
            scores.push(qScore);

            if (!isResolutionScorable(q)) continue;
            const survivors = resolveOnly(session, `lme-${q.question_id}`, q, {
              keyCardinality: MANUAL_KEY_CARDINALITY,
              keyAliases: aliased ? aliasMap : undefined,
              evidencePoolingRule: RULE.MAX_MEAN,
            });
            const sd = staleDeprecationCorrect(q, survivors);
            if (sd === undefined) continue;
            nRes++;
            if (sd) sdSum++;
            if (recencyTop1Correct(q, survivors) === true) rtSum++;
            if (droppedByRanking(q, survivors, qScore.updateCorrect) === true) dropSum++;
          }
          cells.push({
            fraction, mode, aliased, rows: aggregate(scores, KS), coverage,
            res: {
              staleDeprec: nRes ? sdSum / nRes : 0,
              recencyTop1: nRes ? rtSum / nRes : 0,
              dropped: nRes ? dropSum / nRes : 0,
              nRes, fragLineages,
            },
          });
        }
```

(The `try`/`finally` wrapper, the ingest loop above it, and the sanity gate below it are unchanged.)

- [ ] **Step 5: Extend the output blocks**

Replace the table header/rows block (sweep lines ~165-180) so the new columns render:

```ts
  const outLines: string[] = [];
  outLines.push("| fraction | mode | aliased | updateCorrect | recall@1 | recall@3 | n | staleDeprec | recencyTop1 | nRes | fragLineages |");
  outLines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const c of cells) {
    const uc = kuUpdate(c.rows);
    const recall = (k: number): number | undefined =>
      c.rows.find((r) => r.category === "knowledge-update" && r.metric === `recall@${k}`)?.value;
    const nRow = c.rows.find((r) => r.category === "knowledge-update" && r.metric === "updateCorrect");
    outLines.push(
      `| ${c.fraction} | ${c.mode} | ${c.aliased ? "on" : "off"} | ` +
      `${uc !== undefined ? r3(uc) : "—"} | ${recall(1) !== undefined ? r3(recall(1)!) : "—"} | ` +
      `${recall(3) !== undefined ? r3(recall(3)!) : "—"} | ${nRow?.n ?? 0} | ` +
      `${r3(c.res.staleDeprec)} | ${r3(c.res.recencyTop1)} | ${c.res.nRes} | ${c.res.fragLineages} |`,
    );
  }
  const table = outLines.join("\n");
  console.log(table);
```

Then, immediately AFTER the existing `dose-response [...] updateCorrect` loop (sweep ~line 192), add the resolution dose-response + ranking-tax block:

```ts
  // resolution dose-response + per-question ranking tax (staleDeprec=true ∧ updateCorrect=false)
  for (const mode of modes) {
    console.log(`\nresolution [${mode}] staleDeprec (off → on) | ranking tax = dropped(on) − dropped(off):`);
    for (const f of fractions) {
      const m = f === 0 ? modes[0] : mode;
      const off = cells.find((c) => c.mode === m && c.fraction === f && !c.aliased);
      const on = cells.find((c) => c.mode === m && c.fraction === f && c.aliased);
      if (!off || !on) { console.log(`  f=${f}: —`); continue; }
      const tax = on.res.dropped - off.res.dropped;
      console.log(
        `  f=${f}: ${r3(off.res.staleDeprec)} → ${r3(on.res.staleDeprec)} | ` +
        `tax ${r3(tax)} (dropped off ${r3(off.res.dropped)} → on ${r3(on.res.dropped)}); ` +
        `fragLineages ${off.res.fragLineages}, nRes ${off.res.nRes}`,
      );
    }
  }
```

- [ ] **Step 6: Run the sweep test + full drift suite + typecheck**

Run: `npx vitest run bench/longmemeval/manual/drift-injection-sweep.test.ts`
Expected: PASS (new assertions for `staleDeprec`/`fragLineages`/tax; gate still passes).
Run: `npx vitest run bench/longmemeval/manual/drift-injector.test.ts bench/longmemeval/manual/drift-injection.integration.test.ts bench/longmemeval/manual/drift-injection-sweep.test.ts bench/longmemeval/manual/drift-resolution-metrics.test.ts`
Expected: all green.
Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit** *(HELD)*

```bash
git add bench/longmemeval/manual/drift-injection-sweep.ts bench/longmemeval/manual/drift-injection-sweep.test.ts
git commit -m "feat(bench): wire resolution-vs-served metrics + ranking-tax into drift sweep"
```

---

## Post-implementation: re-run the oracle sweep

After both tasks pass, re-run the real sweep (records the resolution-vs-served result):

```bash
npx tsx bench/longmemeval/manual/drift-injection-sweep.ts \
  --file bench/datasets/longmemeval/longmemeval_oracle_target.json \
  --claims bench/datasets/longmemeval/longmemeval-oracle-claims.jsonl \
  --raw --expect-update-correct 0.403 \
  --append-results bench/RESULTS.md
```

Read per spec §8: only where `fragLineages > 0` (f>0); expect a positive `dropped` tax (resolution recovers stale-collapse that ranking drops, esp. morph), `recencyTop1` delta ≈0 (control). Record the table + which of the three outcomes (confirmed / refuted / inconclusive) held, and update memory `drift-injection-null-result`.

## Commit policy (this run)

All commits HELD per the user. Implement + verify each task leaving the tree staged-but-uncommitted; the per-task `git commit` steps run only on release. The spec and this plan are likewise uncommitted.

---

## Self-Review

**Spec coverage:**
- §4 `resolveOnly` → Task 1 (impl + integration test). ✓
- §5 metrics (staleDeprec, recencyTop1, latestAnswerSessionId semantics, ≥2-session denominator, complete-collapse, negative control) → Task 1 (impl + unit tests incl. 3-session + single-session + non-KU). ✓
- §6 wiring (per-question on same opts), columns, fragLineages instrument, per-question `dropped` tax, dose-response → Task 2. ✓
- §7 testing (resolveOnly no-ranking, latestAnswerSessionId tie, 3-session, dropped conjunction, sweep columns + fragLineages=0 at f=0) → Tasks 1 & 2. ✓
- §8 outcomes → Post-implementation run section. ✓
- Constraints (resolveOnly mirrors arm A minus ranking; MAX_MEAN; readonly Claim[]; .js imports; clock-free; no src change) → honored. ✓

**Placeholder scan:** none. The `as unknown as LmeQuestionT` casts in tests are deliberate minimal fixtures (metrics read only key/tags/valid/recordedSeq), with Step 6 noting alignment to the real schema if tsc complains.

**Type consistency:** `resolveOnly`, `staleDeprecationCorrect`, `recencyTop1Correct`, `droppedByRanking`, `lineageFragmented`, `isResolutionScorable`, `latestAnswerSessionId`, `sessionTagOf` named identically across Task 1 (def), Task 1 tests, and Task 2 (consumption). `res` cell field shape matches between Step 4 (def) and Step 5 (output). `Record<string,string>` aliasMap matches the injector's `KeyAliasMap` and `answer.ts:24` `keyAliases`.
