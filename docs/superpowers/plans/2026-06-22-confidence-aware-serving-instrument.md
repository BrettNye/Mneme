# Confidence-Aware Serving Instrument — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a bench-only instrument that measures whether confidence-aware ranking improves served accuracy on the LME oracle corpus (ceiling-first), so we know whether anything the bio layer produces can reach the served answer before building it.

**Architecture:** A pure 3-term ranking operator (`rankBlendConf` = jaccard + recency + confidence) modeled on the live bench `rankBlend`; a pure oracle-confidence injector (HI on the latest-evidence-session claim, deterministic corruption for the degradation sweep); a sweep harness that mirrors `ranking-variant-sweep.ts` (single ingest → `resolveOnly` survivors → inject → rank → score) with a G0 ceiling kill-switch, a G1 degradation sweep, identity/sanity gates, and a gated judge-confirmation path reusing `answer-correctness-judge.ts`. Numbers land in `bench/RESULTS.md`; pre-registered gates live in a protocol doc.

**Tech Stack:** TypeScript, `tsx` runner, `vitest`. All bench code under `bench/longmemeval/manual/`. No `src/` changes.

## Global Constraints

- **No `src/` edit.** Everything is bench-only (`bench/longmemeval/manual/`). Source-promotion is a separate later decision.
- **Determinism:** no `Math.random()` in the data/scoring path. Confidence corruption is seeded by `(question_id, claim id)` via a deterministic hash. Clock reads are allowed ONLY for RESULTS.md header timestamps (matching `ranking-variant-sweep.ts`).
- **Ranking-only scope:** confidence is injected AFTER `resolveOnly`, so it never changes which claim survives — only the order. recall@k moves only through top-k reordering.
- **Baseline = the bench recency operator** `rank-blend.ts` (jaccard sim, `alpha=0.5`, `halfLifeMs = 90·86_400_000`). At `wConf=0` the new operator must be byte-identical to it.
- **Identity gate is load-bearing:** if `wConf=0` ranking ≠ bench `rankBlend`, the run aborts.
- **Pre-registered gates own verdicts; `bench/RESULTS.md` owns numbers.** RESULTS anchors use `### conf-serving: <slot> (YYYY-MM-DD)`.
- **Smoke before bulk:** the LLM judge step runs only after G0/G1 pass, behind `--judge` + `ANTHROPIC_API_KEY`.
- **Fixed constants (frozen in Task 1's protocol):** `HI = 0.95`, `LO = 0.05`, `alpha = 0.5`, `halfLifeDays = 90`, `wConf grid = {0, 0.1, 0.2, 0.3, 0.5}`, `p grid = {1.0, 0.9, 0.75, 0.5}`. G0 PASS iff oracle (`p=1`, best `wConf`) lifts KU `updateCorrect` ≥ **0.05** over the recency-only baseline (`wConf=0`) with recall@10 within **0.02** and TR `temporalCorrect` not down by more than **0.02**.

---

### Task 1: Pre-registered protocol doc

Freeze the gates before building so the run can't be rationalized post-hoc (P0–P2 convention). Doc-only; no code.

**Files:**
- Create: `docs/bio/2026-06-22-conf-serving-protocol.md`

- [ ] **Step 1: Write the protocol doc**

Create `docs/bio/2026-06-22-conf-serving-protocol.md` with exactly this content:

```markdown
# Confidence-aware serving — efficacy protocol (pre-registered 2026-06-22)

**Status:** Pre-registered before the run. Gates frozen here; measured numbers
live only in `bench/RESULTS.md` under `### conf-serving: <slot> (YYYY-MM-DD)`
anchors (slots: `ceiling`, `degradation`, `judge confirm`).
**Spec:** docs/superpowers/specs/2026-06-22-confidence-aware-serving-design.md

## Fixed parameters

- HI = 0.95, LO = 0.05 (injected confidence values).
- Recency baseline: bench `rankBlend`, alpha = 0.5, half-life = 90 days.
- wConf grid = {0, 0.1, 0.2, 0.3, 0.5}.
- p (confidence-quality) grid = {1.0, 0.9, 0.75, 0.5}.
- Dataset: longmemeval_oracle_target.json (oracle attribution), --raw.
- Ranking similarity: jaccard (matches the recency real-answer baseline).

## Sanity gates (must hold or the run is void)

- **Identity:** wConf = 0 ranking is byte-identical to the bench `rankBlend`
  baseline on all 229 questions (top-k per question), regardless of injected p.
- **Garbage-confidence:** at p = 0.5 (uninformative confidence), no wConf cell
  beats the wConf = 0 baseline KU updateCorrect by more than noise (≤ 0.01).

## G0 — ceiling (hard kill-switch, run first)

Perfect oracle confidence (p = 1.0), best wConf cell. **PASS** iff it lifts KU
updateCorrect by ≥ 0.05 over the wConf = 0 baseline, with recall@10 within 0.02
of baseline AND TR temporalCorrect not down by more than 0.02. Otherwise
**FAIL → STOP**: confidence-aware serving declared low-value; bio-via-serving
parked. No degradation sweep, no LLM spend.

## G1 — degradation (only if G0 passes)

At the winning wConf, sweep p ∈ {0.9, 0.75, 0.5}. Report the lift-vs-p curve and
the p* where lift ≥ ½ the ceiling. Non-gating, informative (sets the confidence
quality the learning loop must reach).

## Confirmation (only on the G0 winning cell)

Run the answer-correctness judge (claude-sonnet-4-6) over the winning cell's
served top-5 context vs gold answers (KU + TR). PASS iff KU answerInContext lift
> 0 over baseline AND TR answerInContext not down by more than 0.02. A proxy
(updateCorrect) number is never cited without judge confirmation.

## Decision

- G0 FAIL → park confidence-aware serving; record the flat ceiling.
- G0 PASS + judge-confirmed → the ceiling lift and the G1 p* justify, as
  separate later decisions, a src confidence-ranking dial and the RaState attach.
- Ceiling height is NOT a citable product number (it leaks the label by
  construction); only the existence of lift and the degradation slope are cited.
```

- [ ] **Step 2: Commit**

```bash
git add docs/bio/2026-06-22-conf-serving-protocol.md
git commit -m "docs(bio): pre-register confidence-aware serving protocol"
```

---

### Task 2: Oracle confidence injection module

Pure functions: deterministic seed, oracle assignment (HI on the latest-evidence-session claim), seeded corruption for the degradation sweep.

**Files:**
- Create: `bench/longmemeval/manual/conf-inject.ts`
- Test: `bench/longmemeval/manual/conf-inject.test.ts`

**Interfaces:**
- Consumes: `latestAnswerSessionId`, `sessionTagOf` from `./drift-resolution-metrics.js`; `scalarConfidence` from `src/core/confidence.js`; `Claim` from `src/core/claim.js`; `LmeQuestionT` from `../types.js`.
- Produces: `HI`, `LO` constants; `seededUnit(a: string, b: string): number` (∈ [0,1)); `injectedConfidenceValue(claim: Claim, q: LmeQuestionT, p: number): number`; `injectConfidence(survivors: readonly Claim[], q: LmeQuestionT, p: number): Claim[]`.

- [ ] **Step 1: Write the failing test**

Create `bench/longmemeval/manual/conf-inject.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Claim } from "../../../src/core/claim.js";
import { pointEstimate } from "../../../src/core/confidence.js";
import type { LmeQuestionT } from "../types.js";
import { HI, LO, seededUnit, injectedConfidenceValue, injectConfidence } from "./conf-inject.js";

function mkClaim(id: string, session: string): Claim {
  return {
    id, subject: "user", key: "k", value: "v",
    valid: { from: 1000, to: Infinity },
    confidence: { distribution: "scalar", parameters: { p: 1 }, raw: 1 },
    tags: [`session:${session}`], status: "validated",
  } as unknown as Claim;
}

// q with two sessions; sess_b is later → latest answer session.
const q = {
  question_id: "q1",
  answer_session_ids: ["sess_a", "sess_b"],
  sessions: [
    { sessionId: "sess_a", date: "2023/05/01 (Mon) 10:00" },
    { sessionId: "sess_b", date: "2023/06/01 (Thu) 10:00" },
  ],
} as unknown as LmeQuestionT;

describe("seededUnit", () => {
  it("is deterministic and in [0,1)", () => {
    const u = seededUnit("q1", "c1");
    expect(u).toBe(seededUnit("q1", "c1"));
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThan(1);
  });
  it("differs across inputs", () => {
    expect(seededUnit("q1", "c1")).not.toBe(seededUnit("q1", "c2"));
  });
});

describe("injectedConfidenceValue", () => {
  it("p=1: HI on the latest-session claim, LO otherwise", () => {
    expect(injectedConfidenceValue(mkClaim("c1", "sess_b"), q, 1)).toBe(HI);
    expect(injectedConfidenceValue(mkClaim("c2", "sess_a"), q, 1)).toBe(LO);
  });
  it("is deterministic across calls at p<1", () => {
    const c = mkClaim("c3", "sess_b");
    expect(injectedConfidenceValue(c, q, 0.5)).toBe(injectedConfidenceValue(c, q, 0.5));
  });
});

describe("injectConfidence", () => {
  it("overrides confidence without changing claim identity/order", () => {
    const survivors = [mkClaim("c1", "sess_b"), mkClaim("c2", "sess_a")];
    const out = injectConfidence(survivors, q, 1);
    expect(out.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(pointEstimate(out[0].confidence)).toBe(HI);
    expect(pointEstimate(out[1].confidence)).toBe(LO);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run bench/longmemeval/manual/conf-inject.test.ts`
Expected: FAIL — cannot find module `./conf-inject.js`.

- [ ] **Step 3: Write minimal implementation**

Create `bench/longmemeval/manual/conf-inject.ts`:

```ts
/**
 * Oracle confidence injection for the confidence-aware serving instrument
 * (bench-only). HI on the latest-evidence-session claim (what a perfect bio
 * layer would have learned), LO otherwise; deterministic corruption for the
 * degradation sweep. Injected AFTER resolveOnly, so it never changes the
 * survivor set — only ranking sees it.
 *
 * Spec: docs/superpowers/specs/2026-06-22-confidence-aware-serving-design.md
 */
import type { Claim } from "../../../src/core/claim.js";
import { scalarConfidence } from "../../../src/core/confidence.js";
import type { LmeQuestionT } from "../types.js";
import { latestAnswerSessionId, sessionTagOf } from "./drift-resolution-metrics.js";

export const HI = 0.95;
export const LO = 0.05;

/** Deterministic [0,1) from two strings (FNV-1a 32-bit). No clock, no RNG. */
export function seededUnit(a: string, b: string): number {
  let h = 2166136261 >>> 0;
  const s = `${a}\x1f${b}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0) / 4294967296;
}

/**
 * Oracle confidence for a survivor under quality p:
 *  - oracle value = HI if the claim traces to the latest answer session, else LO.
 *  - with prob p keep the oracle value; with prob (1−p) replace by a seeded
 *    random HI/LO draw (the degradation corruption).
 */
export function injectedConfidenceValue(claim: Claim, q: LmeQuestionT, p: number): number {
  const latest = latestAnswerSessionId(q);
  const oracle = latest !== null && sessionTagOf(claim) === latest ? HI : LO;
  if (p >= 1) return oracle;
  if (seededUnit(q.question_id, claim.id) < p) return oracle;
  return seededUnit(claim.id, q.question_id) < 0.5 ? LO : HI;
}

/** Map survivors to copies carrying the injected (scalar) confidence. */
export function injectConfidence(survivors: readonly Claim[], q: LmeQuestionT, p: number): Claim[] {
  return survivors.map((c) => ({ ...c, confidence: scalarConfidence(injectedConfidenceValue(c, q, p)) }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run bench/longmemeval/manual/conf-inject.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add bench/longmemeval/manual/conf-inject.ts bench/longmemeval/manual/conf-inject.test.ts
git commit -m "feat(bench): oracle confidence injection for conf-serving instrument"
```

---

### Task 3: Confidence-aware ranking operator

The 3-term ranker, with the load-bearing `wConf=0` identity gate against the bench `rankBlend`.

**Files:**
- Create: `bench/longmemeval/manual/rank-blend-conf.ts`
- Test: `bench/longmemeval/manual/rank-blend-conf.test.ts`

**Interfaces:**
- Consumes: `simJaccard` from `src/algebra/similarity.js`; `pointEstimate` from `src/core/confidence.js`; `Claim` from `src/core/claim.js`; `Value` from `src/core/value.js`; the existing `rankBlend` from `./rank-blend.js` (for the identity test only).
- Produces: `BlendConfOpts { alpha: number; halfLifeMs: number; wConf: number; t: number }`; `rankBlendConf(survivors: readonly Claim[], query: Value, opts: BlendConfOpts): Claim[]`.

- [ ] **Step 1: Write the failing test**

Create `bench/longmemeval/manual/rank-blend-conf.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Claim } from "../../../src/core/claim.js";
import { rankBlend } from "./rank-blend.js";
import { rankBlendConf } from "./rank-blend-conf.js";

function mk(id: string, value: string, validFrom: number, conf: number): Claim {
  return {
    id, subject: "s", key: "k", value,
    valid: { from: validFrom, to: Infinity },
    confidence: { distribution: "scalar", parameters: { p: conf }, raw: conf },
    tags: [], status: "validated",
  } as unknown as Claim;
}

const HL = 90 * 86_400_000;
const T = 10_000_000_000;

describe("rankBlendConf", () => {
  const survivors = [
    mk("a", "alpha trip vegas", T - HL, 0.05),
    mk("b", "beta trip paris", T - 10 * HL, 0.95),
    mk("c", "gamma hotel", T - 2 * HL, 0.5),
  ];

  it("wConf=0 is byte-identical to bench rankBlend (identity gate)", () => {
    const query = "trip";
    for (const alpha of [1, 0.5, 0]) {
      const base = rankBlend(survivors, query, { alpha, halfLifeMs: HL, t: T });
      const conf = rankBlendConf(survivors, query, { alpha, halfLifeMs: HL, wConf: 0, t: T });
      expect(conf.map((x) => x.id)).toEqual(base.map((x) => x.id));
    }
  });

  it("wConf>0 lets a high-confidence claim outrank on confidence alone", () => {
    // wConf=1 → pure confidence → "b" (conf 0.95) ranks first.
    const out = rankBlendConf(survivors, "zzz", { alpha: 0.5, halfLifeMs: HL, wConf: 1, t: T });
    expect(out[0].id).toBe("b");
  });

  it("is deterministic", () => {
    const a = rankBlendConf(survivors, "trip", { alpha: 0.5, halfLifeMs: HL, wConf: 0.3, t: T });
    const b = rankBlendConf(survivors, "trip", { alpha: 0.5, halfLifeMs: HL, wConf: 0.3, t: T });
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run bench/longmemeval/manual/rank-blend-conf.test.ts`
Expected: FAIL — cannot find module `./rank-blend-conf.js`.

- [ ] **Step 3: Write minimal implementation**

Create `bench/longmemeval/manual/rank-blend-conf.ts`:

```ts
/**
 * Confidence-aware blend ranker for the confidence-aware serving instrument
 * (bench-only). Extends the recency blend (rank-blend.ts) with a confidence
 * term:
 *   score = wSim·jaccard(value,query) + wRec·exp(-lambda·age) + wConf·conf,
 *   wSim = (1-wConf)·alpha, wRec = (1-wConf)·(1-alpha), lambda = ln2/halfLifeMs.
 * At wConf=0 this reduces EXACTLY to bench rankBlend (the recency baseline,
 * itself byte-identical to arm A at alpha=1) — the load-bearing identity gate.
 *
 * Spec: docs/superpowers/specs/2026-06-22-confidence-aware-serving-design.md
 */
import type { Claim } from "../../../src/core/claim.js";
import type { Value } from "../../../src/core/value.js";
import { simJaccard } from "../../../src/algebra/similarity.js";
import { pointEstimate } from "../../../src/core/confidence.js";

export interface BlendConfOpts { alpha: number; halfLifeMs: number; wConf: number; t: number }

export function rankBlendConf(survivors: readonly Claim[], query: Value, opts: BlendConfOpts): Claim[] {
  const lambda = Math.LN2 / opts.halfLifeMs;
  const wSim = (1 - opts.wConf) * opts.alpha;
  const wRec = (1 - opts.wConf) * (1 - opts.alpha);
  const scored = survivors.map((claim, i) => {
    const rel = simJaccard.scoreOne(claim.value, query);     // [0,1]
    const age = Math.max(0, opts.t - claim.valid.from);      // ≥0
    const recency = Math.exp(-lambda * age);                 // (0,1]
    const conf = pointEstimate(claim.confidence);            // [0,1]
    const score = wSim * rel + wRec * recency + opts.wConf * conf;
    return { claim, score, i };
  });
  // Tie-break = stable input order ONLY (identical to bench rankBlend / arm A rho).
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.claim);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run bench/longmemeval/manual/rank-blend-conf.test.ts`
Expected: PASS (identity, confidence-dominance, determinism).

- [ ] **Step 5: Commit**

```bash
git add bench/longmemeval/manual/rank-blend-conf.ts bench/longmemeval/manual/rank-blend-conf.test.ts
git commit -m "feat(bench): confidence-aware blend ranker (wConf=0 identity gate)"
```

---

### Task 4: Sweep harness (G0 ceiling, G1 degradation, gates)

Mirrors `ranking-variant-sweep.ts`: single ingest → `resolveOnly` survivors → inject confidence per p → rank with `rankBlendConf` per wConf → score. Enforces the identity gate, runs G0 (kill-switch) then G1, prints tables, and supports `--append-results`. A `--smoke` flag runs the gate logic on a tiny in-memory fixture, network-free.

**Files:**
- Create: `bench/longmemeval/manual/conf-serving-sweep.ts`
- Test: `bench/longmemeval/manual/conf-serving-sweep.test.ts`

**Interfaces:**
- Consumes: `resolveOnly` from `./drift-resolution-metrics.js`; `injectConfidence` from `./conf-inject.js`; `rankBlendConf` from `./rank-blend-conf.js`; `rankBlend` from `./rank-blend.js`; `ingestQuestion`, `claimsFor` from `../ingest.js`; `answerArmA`, `evaluationInstant` from `../answer.js`; `scoreQuestion`, `aggregate`, `ScoreRow`, `QuestionScore` from `../score.js`; `MANUAL_KEY_CARDINALITY` from `../run.js`; `RULE` from `src/distribution/rules.js`; loaders/types from `../types.js` and `../../convert/longmemeval.js`.
- Produces: `runSweep(questions, allClaims): SweepReport` (exported for the test); `main(argv): Promise<number>`; `SweepReport { ku0: number; bestWConf: number; ceilingKU: number; identityFailed: boolean; degradation: Array<{ p: number; ku: number }> }`.

- [ ] **Step 1: Write the failing test**

Create `bench/longmemeval/manual/conf-serving-sweep.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { main } from "./conf-serving-sweep.js";

describe("conf-serving-sweep --smoke", () => {
  it("runs the gate logic network-free and exits 0", async () => {
    const code = await main(["--smoke"]);
    expect(code).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run bench/longmemeval/manual/conf-serving-sweep.test.ts`
Expected: FAIL — cannot find module `./conf-serving-sweep.js`.

- [ ] **Step 3: Write minimal implementation**

Create `bench/longmemeval/manual/conf-serving-sweep.ts`:

```ts
/**
 * Confidence-aware serving efficacy instrument (bench-only). Ceiling-first:
 * inject oracle confidence, re-rank the resolved survivor set with rankBlendConf
 * over a wConf grid, measure served-accuracy lift + recall cost (G0 kill-switch),
 * then a confidence-quality degradation sweep (G1). wConf=0 is gated byte-identical
 * to the bench recency rankBlend.
 *
 * Spec:     docs/superpowers/specs/2026-06-22-confidence-aware-serving-design.md
 * Protocol: docs/bio/2026-06-22-conf-serving-protocol.md
 *
 *   tsx bench/longmemeval/manual/conf-serving-sweep.ts \
 *     --file bench/datasets/longmemeval/longmemeval_oracle_target.json \
 *     --claims bench/datasets/longmemeval/longmemeval-oracle-claims.jsonl --raw \
 *     [--append-results bench/RESULTS.md]
 *   tsx bench/longmemeval/manual/conf-serving-sweep.ts --smoke
 */
import { parseArgs } from "node:util";
import { readFileSync, appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "../../../src/surface/index.js";
import type { Claim } from "../../../src/core/claim.js";
import { RULE } from "../../../src/distribution/rules.js";
import { rankBlend } from "./rank-blend.js";
import { rankBlendConf } from "./rank-blend-conf.js";
import { injectConfidence } from "./conf-inject.js";
import { resolveOnly } from "./drift-resolution-metrics.js";
import { ingestQuestion, claimsFor } from "../ingest.js";
import { evaluationInstant } from "../answer.js";
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
const ALPHA = 0.5;
const HALF_LIFE_DAYS = 90;
const W_CONF_GRID = [0, 0.1, 0.2, 0.3, 0.5];
const P_GRID = [1.0, 0.9, 0.75, 0.5];
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

const metric = (rows: ScoreRow[], cat: string, m: string): number | undefined =>
  rows.find((r) => r.category === cat && r.metric === m)?.value;

export interface QState { q: LmeQuestionT; survivors: readonly Claim[]; t: number }
export interface SweepReport {
  ku0: number; bestWConf: number; ceilingKU: number; recall10Base: number; recall10Ceiling: number;
  trBase: number; trCeiling: number; identityFailed: boolean; degradation: Array<{ p: number; ku: number }>;
}

/** Rank one (p, wConf) cell over all questions and return aggregate rows. */
function rankCell(qstates: QState[], p: number, wConf: number): ScoreRow[] {
  const halfLifeMs = HALF_LIFE_DAYS * DAY_MS;
  const scores: QuestionScore[] = [];
  for (const s of qstates) {
    const injected = injectConfidence(s.survivors, s.q, p);
    const ordered = rankBlendConf(injected, s.q.question, { alpha: ALPHA, halfLifeMs, wConf, t: s.t });
    const result: AnswerResult = { arm: "A", claims: ordered.slice(0, MAX_K), abstained: ordered.length === 0 };
    scores.push(scoreQuestion(s.q, result, KS));
  }
  return aggregate(scores, KS);
}

/** Identity check: wConf=0 ranking == bench rankBlend on every question. */
function identityHolds(qstates: QState[]): boolean {
  const halfLifeMs = HALF_LIFE_DAYS * DAY_MS;
  for (const s of qstates) {
    const injected = injectConfidence(s.survivors, s.q, 1);
    const base = rankBlend(s.survivors, s.q.question, { alpha: ALPHA, halfLifeMs, t: s.t });
    const conf = rankBlendConf(injected, s.q.question, { alpha: ALPHA, halfLifeMs, wConf: 0, t: s.t });
    if (base.map((c) => c.id).join("|") !== conf.map((c) => c.id).join("|")) return false;
  }
  return true;
}

/** Pure sweep over precomputed survivors (testable without I/O). */
export function runSweep(qstates: QState[]): SweepReport {
  const identityFailed = !identityHolds(qstates);

  const baseRows = rankCell(qstates, 1, 0);
  const ku0 = metric(baseRows, "knowledge-update", "updateCorrect") ?? NaN;
  const recall10Base = metric(baseRows, "knowledge-update", "recall@10") ?? NaN;
  const trBase = metric(baseRows, "temporal-reasoning", "temporalCorrect") ?? NaN;

  // G0: p=1, sweep wConf>0, pick best KU.
  let bestWConf = 0, ceilingKU = ku0, recall10Ceiling = recall10Base, trCeiling = trBase;
  for (const wConf of W_CONF_GRID) {
    if (wConf === 0) continue;
    const rows = rankCell(qstates, 1, wConf);
    const ku = metric(rows, "knowledge-update", "updateCorrect") ?? NaN;
    if (ku > ceilingKU) {
      ceilingKU = ku; bestWConf = wConf;
      recall10Ceiling = metric(rows, "knowledge-update", "recall@10") ?? NaN;
      trCeiling = metric(rows, "temporal-reasoning", "temporalCorrect") ?? NaN;
    }
  }

  // G1: degradation at the winning wConf (only meaningful if bestWConf>0).
  const degradation: Array<{ p: number; ku: number }> = [];
  for (const p of P_GRID) {
    const w = bestWConf === 0 ? W_CONF_GRID[W_CONF_GRID.length - 1] : bestWConf;
    const rows = rankCell(qstates, p, w);
    degradation.push({ p, ku: metric(rows, "knowledge-update", "updateCorrect") ?? NaN });
  }

  return { ku0, bestWConf, ceilingKU, recall10Base, recall10Ceiling, trBase, trCeiling, identityFailed, degradation };
}

/** Build QStates: ingest once, resolveOnly survivors per question. */
function buildQStates(session: ReturnType<typeof openSession>, questions: LmeQuestionT[], allClaims: ClaimRecordT[]): QState[] {
  const qstates: QState[] = [];
  for (const q of questions) {
    const corpusId = `lme-${q.question_id}`;
    ingestQuestion(session, q, claimsFor(q, allClaims, { oracle: true }));
    const survivors = resolveOnly(session, corpusId, q, {
      keyCardinality: MANUAL_KEY_CARDINALITY, evidencePoolingRule: RULE.MAX_MEAN,
    });
    qstates.push({ q, survivors, t: evaluationInstant(q) });
  }
  return qstates;
}

function printReport(rep: SweepReport): string {
  const out: string[] = [];
  out.push(`identity gate (wConf=0 == bench rankBlend): ${rep.identityFailed ? "FAILED" : "OK"}`);
  out.push(`baseline KU updateCorrect (wConf=0): ${r3(rep.ku0)} | recall@10 ${r3(rep.recall10Base)} | TR ${r3(rep.trBase)}`);
  out.push(`ceiling (p=1, best wConf=${rep.bestWConf}): KU ${r3(rep.ceilingKU)} | recall@10 ${r3(rep.recall10Ceiling)} | TR ${r3(rep.trCeiling)}`);
  out.push(`G0 lift dKU ${r3(rep.ceilingKU - rep.ku0)} | dRecall@10 ${r3(rep.recall10Ceiling - rep.recall10Base)} | dTR ${r3(rep.trCeiling - rep.trBase)}`);
  const g0pass = rep.ceilingKU - rep.ku0 >= 0.05 && rep.recall10Ceiling - rep.recall10Base >= -0.02 && rep.trCeiling - rep.trBase >= -0.02;
  out.push(`G0 verdict: ${g0pass ? "PASS — run G1 + judge" : "FAIL — park (ceiling flat / guardrail tripped)"}`);
  out.push(`G1 degradation @ wConf=${rep.bestWConf === 0 ? W_CONF_GRID[W_CONF_GRID.length - 1] : rep.bestWConf}: ` +
    rep.degradation.map((d) => `p=${d.p}:${r3(d.ku)}`).join("  "));
  return out.join("\n");
}

/** In-memory smoke: two questions, no network, exercises gate + identity logic. */
function smokeQStates(): QState[] {
  const mk = (id: string, value: string, session: string, validFrom: number): Claim => ({
    id, subject: "user", key: "k", value,
    valid: { from: validFrom, to: Infinity },
    confidence: { distribution: "scalar", parameters: { p: 1 }, raw: 1 },
    tags: [`session:${session}`], status: "validated",
  } as unknown as Claim);
  const q = (qid: string): LmeQuestionT => ({
    question_id: qid, question: "trip destination", question_type: "knowledge-update",
    answer: "x", answer_session_ids: ["s_old", "s_new"],
    sessions: [
      { sessionId: "s_old", date: "2023/05/01 (Mon) 10:00" },
      { sessionId: "s_new", date: "2023/06/01 (Thu) 10:00" },
    ],
  } as unknown as LmeQuestionT);
  const t = 2_000_000_000_000;
  return [
    { q: q("k1"), t, survivors: [mk("a", "trip vegas", "s_old", t - 1_000), mk("b", "trip paris", "s_new", t - 2_000)] },
    { q: q("k2"), t, survivors: [mk("c", "trip rome", "s_old", t - 1_000), mk("d", "trip lima", "s_new", t - 2_000)] },
  ];
}

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      file: { type: "string" }, claims: { type: "string" },
      raw: { type: "boolean", default: false },
      smoke: { type: "boolean", default: false },
      "append-results": { type: "string" },
    },
  });

  if (values.smoke) {
    const rep = runSweep(smokeQStates());
    console.log(printReport(rep));
    if (rep.identityFailed) { console.error("SMOKE FAIL: identity gate failed"); return 1; }
    console.log("smoke: PASS");
    return 0;
  }

  if (!values.file || !values.claims) { console.error("--file and --claims are required (or --smoke)"); return 1; }

  const datasetRaw = JSON.parse(readFileSync(values.file, "utf-8")) as unknown[];
  const questions: LmeQuestionT[] = datasetRaw
    .map((r) => (values.raw ? normalizeQuestion(r) : LmeQuestion.parse(r)))
    .filter((q) => TARGET_CATEGORIES.has(categoryOf(q)));

  const lines = readFileSync(values.claims, "utf-8").split("\n").filter((l) => l.trim().length > 0);
  const header = CacheHeader.parse(JSON.parse(lines[0]));
  if (header.model !== EXTRACTION_MODEL || header.promptVersion !== PROMPT_VERSION) {
    console.error(`Claims cache header mismatch: model=${header.model}, promptVersion=${header.promptVersion}`);
    return 1;
  }
  const allClaims: ClaimRecordT[] = lines.slice(1).map((l) => ClaimRecord.parse(JSON.parse(l)));

  const dir = mkdtempSync(join(tmpdir(), "mneme-conf-serve-"));
  const session = openSession({ dbPath: join(dir, "lme.db"), writer: "conf-serve", source: "imported" });
  try {
    const qstates = buildQStates(session, questions, allClaims);
    const rep = runSweep(qstates);
    const report = printReport(rep);
    console.log(report);
    if (rep.identityFailed) { console.error("IDENTITY GATE FAILED — aborting"); return 1; }
    if (values["append-results"]) {
      appendFileSync(String(values["append-results"]),
        `\n\n### conf-serving: ceiling (${new Date().toISOString().slice(0, 10)})\n\n\`\`\`\n${report}\n\`\`\`\n`, "utf-8");
    }
    return 0;
  } finally {
    session.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

if (process.argv[1] && process.argv[1].endsWith("conf-serving-sweep.ts")) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run bench/longmemeval/manual/conf-serving-sweep.test.ts`
Expected: PASS — `--smoke` exits 0, identity holds on the fixture.

- [ ] **Step 5: Run the smoke manually to eyeball the report**

Run: `npx tsx bench/longmemeval/manual/conf-serving-sweep.ts --smoke`
Expected: prints `identity gate ... OK`, a baseline/ceiling/G0/G1 block, and `smoke: PASS`.

- [ ] **Step 6: Commit**

```bash
git add bench/longmemeval/manual/conf-serving-sweep.ts bench/longmemeval/manual/conf-serving-sweep.test.ts
git commit -m "feat(bench): confidence-aware serving sweep harness (G0/G1 + identity gate + smoke)"
```

---

### Task 5: Judge-confirmation path (gated, reuses the answer judge)

Add a `--judge` mode to the harness that re-ranks the G0 winning cell, renders its served top-5 context, and judges it against gold answers with the existing `answer-correctness-judge.ts` (cached, resume-safe). Runs only after G0/G1 pass, behind `ANTHROPIC_API_KEY`.

**Files:**
- Modify: `bench/longmemeval/manual/conf-serving-sweep.ts` (add `--judge` + `--wconf` options and a `judgeWinningCell` function)
- Test: `bench/longmemeval/manual/conf-serving-judge.test.ts`

**Interfaces:**
- Consumes: `JudgeItem`, `renderContextClaim`, `judgeAnswerInContext`, `loadJudgeCache`, `appendJudgeRecord`, `appendJudgeHeaderIfNew`, `judgeCacheKey`, `ANSWER_JUDGE_MODEL`, `ANSWER_JUDGE_PROMPT_VERSION`, `CONTEXT_K`, `type JudgeRecord` from `./answer-correctness-judge.js`; `rankBlendConf`, `injectConfidence` (already imported).
- Produces: `buildJudgeContext(qstates: QState[], wConf: number): Array<{ q: LmeQuestionT; context: string[] }>` (exported, pure, testable without network); `--judge`/`--wconf` CLI behavior in `main`.

- [ ] **Step 1: Write the failing test**

Create `bench/longmemeval/manual/conf-serving-judge.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildJudgeContext } from "./conf-serving-sweep.js";
import type { Claim } from "../../../src/core/claim.js";
import type { LmeQuestionT } from "../types.js";

function mk(id: string, value: string, session: string, validFrom: number): Claim {
  return {
    id, subject: "user", key: "dest", value,
    valid: { from: validFrom, to: Infinity },
    confidence: { distribution: "scalar", parameters: { p: 1 }, raw: 1 },
    tags: [`session:${session}`], status: "validated",
  } as unknown as Claim;
}

const q = {
  question_id: "k1", question: "trip destination", question_type: "knowledge-update",
  answer: "Paris", answer_session_ids: ["s_old", "s_new"],
  sessions: [
    { sessionId: "s_old", date: "2023/05/01 (Mon) 10:00" },
    { sessionId: "s_new", date: "2023/06/01 (Thu) 10:00" },
  ],
} as unknown as LmeQuestionT;

describe("buildJudgeContext", () => {
  it("renders top-K served context strings per question (pure, no network)", () => {
    const t = 2_000_000_000_000;
    const qstates = [{ q, t, survivors: [mk("a", "Vegas", "s_old", t - 1_000), mk("b", "Paris", "s_new", t - 2_000)] }];
    const out = buildJudgeContext(qstates, 1); // wConf=1 → confidence dominates, latest-session "Paris" first
    expect(out).toHaveLength(1);
    expect(out[0].context.length).toBeGreaterThan(0);
    expect(out[0].context[0]).toContain("Paris");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run bench/longmemeval/manual/conf-serving-judge.test.ts`
Expected: FAIL — `buildJudgeContext` is not exported.

- [ ] **Step 3: Add `buildJudgeContext`, `judgeWinningCell`, and the `--judge` path**

In `bench/longmemeval/manual/conf-serving-sweep.ts`, add these imports near the top (after the existing imports):

```ts
import { CONTEXT_K, ANSWER_JUDGE_MODEL, ANSWER_JUDGE_PROMPT_VERSION,
  renderContextClaim, judgeAnswerInContext, loadJudgeCache, appendJudgeRecord,
  appendJudgeHeaderIfNew, judgeCacheKey, type JudgeRecord } from "./answer-correctness-judge.js";
```

Add these exported functions above `main`:

```ts
/** Render the served top-CONTEXT_K context for the winning cell (pure, no network). */
export function buildJudgeContext(qstates: QState[], wConf: number): Array<{ q: LmeQuestionT; context: string[] }> {
  const halfLifeMs = HALF_LIFE_DAYS * DAY_MS;
  return qstates.map((s) => {
    const injected = injectConfidence(s.survivors, s.q, 1); // p=1 ceiling cell
    const ordered = rankBlendConf(injected, s.q.question, { alpha: ALPHA, halfLifeMs, wConf, t: s.t });
    return { q: s.q, context: ordered.slice(0, CONTEXT_K).map(renderContextClaim) };
  });
}

/** Judge the winning cell's served context vs gold answers (KU + TR; cached, resume-safe). */
async function judgeWinningCell(qstates: QState[], wConf: number, apiKey: string, cachePath: string): Promise<void> {
  const cell = `conf-wconf-${wConf}`;
  const expect = { model: ANSWER_JUDGE_MODEL, promptVersion: ANSWER_JUDGE_PROMPT_VERSION, contextK: CONTEXT_K };
  appendJudgeHeaderIfNew(cachePath, expect);
  const cache = loadJudgeCache(cachePath, expect);
  const built = buildJudgeContext(qstates, wConf);
  const byCat = new Map<string, { correct: number; n: number }>();
  for (const { q, context } of built) {
    const cat = categoryOf(q);
    if (cat !== "knowledge-update" && cat !== "temporal-reasoning") continue; // abstention has no gold
    const gold = q.answer;
    if (gold === null || gold === undefined) continue;
    const key = judgeCacheKey(cell, q.question_id);
    let rec = cache.get(key);
    if (!rec) {
      const v = await judgeAnswerInContext(apiKey, { question: q.question, gold, context });
      rec = { cell, questionId: q.question_id, category: cat, correct: v.correct, reason: v.reason };
      appendJudgeRecord(cachePath, rec);
    }
    const agg = byCat.get(cat) ?? { correct: 0, n: 0 };
    agg.correct += rec.correct ? 1 : 0; agg.n += 1;
    byCat.set(cat, agg);
  }
  for (const [cat, a] of byCat) {
    console.log(`judge ${cat}: answerInContext ${r3(a.correct / a.n)} (${a.correct}/${a.n})`);
  }
}
```

Then extend the `parseArgs` options in `main` to add `judge` and `wconf`:

```ts
      smoke: { type: "boolean", default: false },
      judge: { type: "boolean", default: false },
      wconf: { type: "string" },
      "append-results": { type: "string" },
```

And, in `main`, after `const rep = runSweep(qstates);` and the identity-abort check (inside the `try`, before the `--append-results` block), add:

```ts
    if (values.judge) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) { console.error("--judge requires ANTHROPIC_API_KEY"); return 1; }
      const wConf = values.wconf !== undefined ? parseFloat(String(values.wconf)) : rep.bestWConf;
      const cachePath = join("bench", "longmemeval", "manual", "data", "conf-serving-judgments.jsonl");
      await judgeWinningCell(qstates, wConf, apiKey, cachePath);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run bench/longmemeval/manual/conf-serving-judge.test.ts`
Expected: PASS — `buildJudgeContext` renders the latest-session value first at `wConf=1`.

- [ ] **Step 5: Re-run the smoke + the full bench test file to confirm no regression**

Run: `npx vitest run bench/longmemeval/manual/conf-serving-sweep.test.ts bench/longmemeval/manual/conf-serving-judge.test.ts`
Expected: PASS (both files).

- [ ] **Step 6: Commit**

```bash
git add bench/longmemeval/manual/conf-serving-sweep.ts bench/longmemeval/manual/conf-serving-judge.test.ts
git commit -m "feat(bench): gated judge-confirmation path for conf-serving instrument"
```

---

## Execution notes (not steps)

- The real run is **not** part of this plan (the plan builds the instrument). After merge, run, in order: `--smoke`; then the full sweep (`--file ... --claims ... --raw`) for the G0/G1 tables; then, **only if G0 passes**, `--judge` on the winning `--wconf`. Append the ceiling table to `bench/RESULTS.md` and fill the protocol verdicts.
- Never cite the ceiling height as a product number; cite only the existence of lift + the degradation slope (per the protocol).
