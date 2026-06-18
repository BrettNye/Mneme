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
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
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
import type { Claim } from "../../../src/core/claim.js";

const TARGET_CATEGORIES = new Set(["knowledge-update", "temporal-reasoning"]); // abstention excluded
const DAY_MS = 86_400_000;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const cellLabel = (alpha: number): string => `a${alpha}`;

interface QState { q: LmeQuestionT; category: string; survivors: readonly Claim[]; t: number; gold: string }

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
      qstates.push({ q, category: categoryOf(q), survivors, t: evaluationInstant(q), gold: String(q.answer) });
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
