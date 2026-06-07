/**
 * Abstention calibration from the oracle topScore distribution (lever #2).
 *
 *   npx tsx bench/longmemeval/manual/abstention-calibrate.ts \
 *     --file <oracle_target.json> --claims <oracle-claims.jsonl> \
 *     --ratified <judgments-min094.jsonl>
 *
 * Honest protocol (the 0.872 manual-sample dial explicitly does NOT transfer):
 *   1. For each question, compute topScore under the CITABLE config
 *      (validated-band ratified aliases + hybrid ranking, knobs off).
 *   2. Deterministic 50/50 split by sha256(question_id) parity â€” no RNG.
 *   3. On TRAIN: choose abstainBelowTop maximizing balanced accuracy
 *      (mean of abstention-recall and answerable-precision) over candidate
 *      thresholds = midpoints between adjacent distinct train scores.
 *   4. On HOLDOUT only: report correct abstentions, false abstentions, and
 *      the resulting per-category effect. Distribution summaries for both.
 * The chosen dial is reported, never silently adopted anywhere.
 */
import { parseArgs } from "node:util";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openSession, pipe, leaf, rho } from "../../../src/surface/index.js";
import type { RankedCorpus } from "../../../src/algebra/types.js";
import { canonicalReadStages } from "../../../src/retrieval/read-pipeline.js";
import {
  CacheHeader,
  ClaimRecord,
  normalizeQuestion,
  categoryOf,
  type LmeQuestionT,
  type ClaimRecordT,
} from "../types.js";
import { ingestQuestion, claimsFor, corpusIdFor } from "../ingest.js";
import { evaluationInstant } from "../answer.js";
import { MANUAL_KEY_CARDINALITY } from "../run.js";
import { RULE } from "../../../src/distribution/rules.js";
import { simJaccard, registerSimilarity } from "../../../src/algebra/similarity.js";
import { EmbeddingCache, cosineOver, hybridMax } from "../../../src/index.js";
import { createLocalEmbeddingAdapter, warmForQuestion } from "../embeddings-local.js";
import { autoRatify } from "./key-alias-auto.js";

const TARGET_CATEGORIES = new Set(["knowledge-update", "temporal-reasoning", "abstention"]);
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const pairKey = (a: string, b: string): string => (a < b ? `${a}\x1f${b}` : `${b}\x1f${a}`);

interface Obs {
  qid: string;
  category: string;
  answerable: boolean; // abstention questions are NOT answerable
  topScore: number; // -Infinity when no claims survive
  train: boolean;
}

const summarize = (xs: number[]): string => {
  if (xs.length === 0) return "(none)";
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return `n=${s.length} min=${r3(s[0])} p25=${r3(q(0.25))} med=${r3(q(0.5))} p75=${r3(q(0.75))} max=${r3(s[s.length - 1])}`;
};

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      file: { type: "string" },
      claims: { type: "string" },
      ratified: { type: "string" },
    },
  });
  if (!values.file || !values.claims || !values.ratified) {
    console.error("--file, --claims, --ratified are required");
    return 1;
  }

  // --- inputs ---
  const datasetRaw = JSON.parse(readFileSync(values.file, "utf-8")) as unknown[];
  const questions: LmeQuestionT[] = datasetRaw
    .map(normalizeQuestion)
    .filter((q) => TARGET_CATEGORIES.has(categoryOf(q)));
  const lines = readFileSync(values.claims, "utf-8").split("\n").filter((l) => l.trim().length > 0);
  CacheHeader.parse(JSON.parse(lines[0]));
  const allClaims: ClaimRecordT[] = lines.slice(1).map((l) => ClaimRecord.parse(JSON.parse(l)));

  const approved = new Set<string>();
  for (const line of readFileSync(String(values.ratified), "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)) {
    const obj = JSON.parse(line) as { kind?: string; a?: string; b?: string; same?: boolean };
    if (obj.kind === undefined && obj.same && obj.a && obj.b) approved.add(pairKey(obj.a, obj.b));
  }
  const indicator = (a: string, b: string): number => (approved.has(pairKey(a, b)) ? 1 : 0);

  // --- hybrid ranking (the citable config's ranker) ---
  const adapter = await createLocalEmbeddingAdapter();
  const cache = new EmbeddingCache();
  registerSimilarity("hybrid-cal", hybridMax(simJaccard, cosineOver(adapter, cache)));

  // --- session + ingest + per-question topScore ---
  const dir = mkdtempSync(join(tmpdir(), "mneme-abst-cal-"));
  const session = openSession({ dbPath: join(dir, "cal.db"), writer: "abst-cal", source: "imported" });
  const observations: Obs[] = [];
  try {
    for (const q of questions) {
      const records = claimsFor(q, allClaims, { oracle: true });
      ingestQuestion(session, q, records);
      await warmForQuestion(adapter, cache, records, q.question);

      const keyCounts = new Map<string, number>();
      for (const r of records) keyCounts.set(r.key, (keyCounts.get(r.key) ?? 0) + 1);
      const { map } = autoRatify(keyCounts, indicator, 1);

      const t = evaluationInstant(q);
      const ranked = session.mneme.query<RankedCorpus>(
        corpusIdFor(q.question_id),
        pipe(
          leaf(corpusIdFor(q.question_id)),
          ...canonicalReadStages({
            evaluationInstant: t,
            keyCardinality: MANUAL_KEY_CARDINALITY,
            keyAliases: map,
            evidencePoolingRule: RULE.MAX_MEAN,
          }),
          rho.by("hybrid-cal", q.question),
        ),
        { evaluationClock: t },
      );
      const topScore = ranked.scored.length > 0 ? ranked.scored[0].score : -Infinity;
      const category = categoryOf(q);
      observations.push({
        qid: q.question_id,
        category,
        answerable: category !== "abstention",
        topScore,
        train: parseInt(createHash("sha256").update(q.question_id).digest("hex").slice(0, 8), 16) % 2 === 0,
      });
    }
  } finally {
    session.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  // --- distributions ---
  const part = (train: boolean, answerable: boolean) =>
    observations.filter((o) => o.train === train && o.answerable === answerable).map((o) => o.topScore);
  console.log("\ntopScore distributions (citable config: ratified-min094 + hybrid ranking):");
  console.log(`  TRAIN   answerable: ${summarize(part(true, true))}`);
  console.log(`  TRAIN   abstention: ${summarize(part(true, false))}`);
  console.log(`  HOLDOUT answerable: ${summarize(part(false, true))}`);
  console.log(`  HOLDOUT abstention: ${summarize(part(false, false))}`);

  // --- choose threshold on TRAIN: maximize balanced accuracy ---
  const train = observations.filter((o) => o.train);
  const candidates = [...new Set(train.map((o) => o.topScore).filter((s) => Number.isFinite(s)))].sort((a, b) => a - b);
  const midpoints: number[] = [0];
  for (let i = 1; i < candidates.length; i++) midpoints.push((candidates[i - 1] + candidates[i]) / 2);
  let best = { threshold: 0, balanced: -1, abstRecall: 0, ansPrecision: 0 };
  for (const th of midpoints) {
    const abst = train.filter((o) => !o.answerable);
    const ans = train.filter((o) => o.answerable);
    const abstCorrect = abst.filter((o) => o.topScore < th).length; // abstained correctly
    const ansServed = ans.filter((o) => o.topScore >= th).length; // not falsely abstained
    const abstRecall = abst.length ? abstCorrect / abst.length : 0;
    const ansPrecision = ans.length ? ansServed / ans.length : 0;
    const balanced = (abstRecall + ansPrecision) / 2;
    if (balanced > best.balanced) best = { threshold: th, balanced, abstRecall, ansPrecision };
  }
  console.log(
    `\nTRAIN-chosen abstainBelowTop = ${r3(best.threshold)} ` +
      `(train: abstention-recall ${r3(best.abstRecall)}, answerable-served ${r3(best.ansPrecision)}, balanced ${r3(best.balanced)})`,
  );

  // --- evaluate on HOLDOUT only ---
  const holdout = observations.filter((o) => !o.train);
  const hAbst = holdout.filter((o) => !o.answerable);
  const hAns = holdout.filter((o) => o.answerable);
  const correctAbst = hAbst.filter((o) => o.topScore < best.threshold).length;
  const falseAbst = hAns.filter((o) => o.topScore < best.threshold);
  console.log(`\nHOLDOUT evaluation at ${r3(best.threshold)}:`);
  console.log(`  abstentionCorrect: ${correctAbst}/${hAbst.length} (${r3(hAbst.length ? correctAbst / hAbst.length : 0)})  [was 0 with knobs off]`);
  console.log(`  false abstentions on answerable: ${falseAbst.length}/${hAns.length} (${r3(hAns.length ? falseAbst.length / hAns.length : 0)})`);
  for (const o of falseAbst) console.log(`    falsely abstained: ${o.qid} (${o.category}, topScore ${r3(o.topScore)})`);
  const sepNote =
    hAbst.length && hAns.length
      ? Math.max(...hAbst.map((o) => o.topScore)) < Math.min(...hAns.map((o) => o.topScore))
        ? "CLEAN separation on holdout (zero overlap)"
        : "OVERLAP on holdout â€” dial trades abstention recall vs false abstentions; see lines above"
      : "insufficient holdout data";
  console.log(`  separation: ${sepNote}`);
  return 0;
}

import { pathToFileURL } from "node:url";
const isCliEntry = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCliEntry) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
