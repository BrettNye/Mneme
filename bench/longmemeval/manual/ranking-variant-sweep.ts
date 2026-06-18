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
