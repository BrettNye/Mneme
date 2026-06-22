/**
 * Drift-injection sweep (bench-only). Quantifies the key-matching wedge:
 * injects controlled key drift into the oracle claims-file, runs arm A WITH vs
 * WITHOUT the ground-truth alias map, reports updateCorrect as a dose-response
 * over drift fraction. The zero-drift no-alias cell is gated against the
 * recorded oracle value (--expect-update-correct, default 0.403).
 *
 * Spec: docs/superpowers/specs/2026-06-17-drift-injection-bench-arm-design.md
 *
 *   tsx bench/longmemeval/manual/drift-injection-sweep.ts \
 *     --file bench/datasets/longmemeval/longmemeval_oracle_target.json \
 *     --claims bench/datasets/longmemeval/longmemeval-oracle-claims.jsonl \
 *     [--fractions 0,0.1,0.25,0.5,0.75,1.0] [--modes judged,morph] \
 *     [--seed drift-v1] [--expect-update-correct 0.403] \
 *     [--judgments bench/longmemeval/manual/data/key-ratify-judgments.jsonl] \
 *     [--append-results bench/RESULTS.md]
 */
import { parseArgs } from "node:util";
import { readFileSync, appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "../../../src/surface/index.js";
import { injectDrift, buildJudgedVocab, type CanonicalGroups } from "./drift-injector.js";
import { ingestQuestion, claimsFor } from "../ingest.js";
import { answerArmA } from "../answer.js";
import { scoreQuestion, aggregate, type ScoreRow, type QuestionScore } from "../score.js";
import {
  LmeQuestion, ClaimRecord, CacheHeader, categoryOf,
  normalizeQuestion, type LmeQuestionT, type ClaimRecordT,
} from "../types.js";
import { EXTRACTION_MODEL, PROMPT_VERSION } from "../../convert/longmemeval.js";
import { MANUAL_KEY_CARDINALITY } from "../run.js";
import { RULE } from "../../../src/distribution/rules.js";
import {
  resolveOnly, isResolutionScorable, staleDeprecationCorrect,
  recencyTop1Correct, droppedByRanking, lineageFragmented,
} from "./drift-resolution-metrics.js";

// TARGET_CATEGORIES is a local constant in all sweep drivers — not exported from types.ts.
const TARGET_CATEGORIES = new Set(["knowledge-update", "temporal-reasoning", "abstention"]);

const KS = [1, 3, 10];
const MAX_K = 10;
const DEFAULT_JUDGMENTS = "bench/longmemeval/manual/data/key-ratify-judgments.jsonl";
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

export interface Cell {
  fraction: number;
  mode: string;
  aliased: boolean;
  rows: ScoreRow[];
  coverage?: { eligibleKeys: number; driftedKeys: number; noVariantKeys: number };
  res: { staleDeprec: number; recencyTop1: number; dropped: number; nRes: number; fragLineages: number };
}

const kuUpdate = (rows: ScoreRow[]): number | undefined =>
  rows.find((r) => r.category === "knowledge-update" && r.metric === "updateCorrect")?.value;

export async function main(
  argv: string[],
  opts?: { onError?: (m: string) => void },
): Promise<number> {
  const logError = (m: string): void => { console.error(m); opts?.onError?.(m); };

  const { values } = parseArgs({
    args: argv,
    options: {
      file: { type: "string" },
      claims: { type: "string" },
      fractions: { type: "string", default: "0,0.1,0.25,0.5,0.75,1.0" },
      modes: { type: "string", default: "judged,morph" },
      seed: { type: "string", default: "drift-v1" },
      judgments: { type: "string", default: DEFAULT_JUDGMENTS },
      raw: { type: "boolean", default: false },
      "expect-update-correct": { type: "string" },
      "append-results": { type: "string" },
    },
  });

  if (!values.file || !values.claims) { logError("--file and --claims are required"); return 1; }

  const fractions = String(values.fractions).split(",").map((s) => parseFloat(s.trim()));
  if (fractions.some((f) => Number.isNaN(f) || f < 0 || f > 1) || fractions.length === 0) {
    logError("--fractions must be a comma-separated list in [0, 1]"); return 1;
  }
  const modes = String(values.modes).split(",").map((s) => s.trim());
  if (modes.some((m) => m !== "judged" && m !== "morph")) {
    logError(`--modes must be "judged" and/or "morph", got "${values.modes}"`); return 1;
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

  // judged vocab built once over the full claims-file.
  const judgedVocab: CanonicalGroups = modes.includes("judged")
    ? buildJudgedVocab(allClaims, String(values.judgments)) : new Map();

  const distinctSingleKeys = new Set(
    allClaims.filter((c) => MANUAL_KEY_CARDINALITY[c.key] !== "multi").map((c) => c.key),
  ).size;

  const cells: Cell[] = [];

  // One fresh tmp DB per (fraction, mode): drift changes the INGESTED data, so
  // arm A cannot reuse a single ingest the way key-matching-sweep does. aliased
  // off/on share the same ingest (both read-only).
  for (const mode of modes) {
    for (const fraction of fractions) {
      // fraction 0 is mode-independent; run it once under the first mode only.
      if (fraction === 0 && mode !== modes[0]) continue;

      const { claims: drifted, aliasMap, coverage } = injectDrift(allClaims, {
        mode: mode as "judged" | "morph", fraction, seed: String(values.seed),
        multiKeys: MANUAL_KEY_CARDINALITY,
        judgedVocab: mode === "judged" ? judgedVocab : undefined,
      });

      const dir = mkdtempSync(join(tmpdir(), "mneme-drift-"));
      const session = openSession({ dbPath: join(dir, "lme.db"), writer: "drift-sweep", source: "imported" });
      try {
        for (const q of questions) {
          ingestQuestion(session, q, claimsFor(q, drifted, { oracle: true }));
        }
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
              // scalar oracle claims: alias grouping pools same-value claims; MAX_MEAN is the scalar-safe rule (see key-matching-sweep.ts)
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
      } finally {
        session.close();
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }

      // --- sanity gate on the zero-drift, no-alias baseline ---
      if (fraction === 0 && expect !== undefined) {
        const base = cells.find((c) => c.fraction === 0 && !c.aliased && c.mode === modes[0]);
        const v = base ? kuUpdate(base.rows) : undefined;
        if (v === undefined || r3(v) !== r3(expect)) {
          logError(`SANITY GATE FAILED: baseline KU updateCorrect ${v !== undefined ? r3(v) : "missing"} !== expected ${r3(expect)} — broken rig, aborting`);
          return 1;
        }
        console.log(`sanity gate: baseline KU updateCorrect ${r3(v)} matches recorded value ✓`);
      }
    }
  }

  // --- output ---
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

  // dose-response dump (per mode: off vs on over the fraction axis)
  for (const mode of modes) {
    console.log(`\ndose-response [${mode}] updateCorrect (off → on):`);
    for (const f of fractions) {
      const off = cells.find((c) => c.mode === (f === 0 ? modes[0] : mode) && c.fraction === f && !c.aliased);
      const on = cells.find((c) => c.mode === (f === 0 ? modes[0] : mode) && c.fraction === f && c.aliased);
      const offv = off ? kuUpdate(off.rows) : undefined;
      const onv = on ? kuUpdate(on.rows) : undefined;
      console.log(`  f=${f}: ${offv !== undefined ? r3(offv) : "—"} → ${onv !== undefined ? r3(onv) : "—"}`);
    }
  }

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

  // judged coverage line
  if (modes.includes("judged")) {
    const cov = cells.find((c) => c.mode === "judged")?.coverage;
    if (cov) {
      console.log(`\njudged coverage: eligible to drift ${cov.eligibleKeys} of ${distinctSingleKeys} single-value keys (${distinctSingleKeys - cov.eligibleKeys} had no judged variant)`);
    }
  }

  if (values["append-results"]) {
    appendFileSync(String(values["append-results"]), `\n\n## Drift-injection sweep (${new Date().toISOString()})\n\n${table}\n`, "utf-8");
  }

  return 0;
}

// CLI entry (only when run directly).
import { pathToFileURL } from "node:url";
const isCliEntry = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCliEntry) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => { console.error(err); process.exit(1); });
}
