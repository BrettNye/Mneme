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
import { CONTEXT_K, ANSWER_JUDGE_MODEL, ANSWER_JUDGE_PROMPT_VERSION,
  renderContextClaim, judgeAnswerInContext, loadJudgeCache, appendJudgeRecord,
  appendJudgeHeaderIfNew, judgeCacheKey, type JudgeRecord } from "./answer-correctness-judge.js";

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

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      file: { type: "string" }, claims: { type: "string" },
      raw: { type: "boolean", default: false },
      smoke: { type: "boolean", default: false },
      judge: { type: "boolean", default: false },
      wconf: { type: "string" },
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
    if (values.judge) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) { console.error("--judge requires ANTHROPIC_API_KEY"); return 1; }
      const wConf = values.wconf !== undefined ? parseFloat(String(values.wconf)) : rep.bestWConf;
      const cachePath = join("bench", "longmemeval", "manual", "data", "conf-serving-judgments.jsonl");
      await judgeWinningCell(qstates, wConf, apiKey, cachePath);
    }
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
