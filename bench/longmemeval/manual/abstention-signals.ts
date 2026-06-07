/**
 * Abstention deep-dive: multi-signal study (follow-up to the negative topScore result).
 *
 *   npx tsx bench/longmemeval/manual/abstention-signals.ts \
 *     --file <oracle_target.json> --claims <oracle-claims.jsonl> \
 *     --ratified <judgments-min094.jsonl>
 *
 * For every question (citable config: validated aliases + hybrid ranking) compute
 * candidate abstention signals beyond topScore:
 *   top1          — hybrid top score (the failed baseline signal)
 *   margin12      — top1 - top2 (sharp winner vs plateau)
 *   top5mean      — mean of top-5 hybrid scores (plateau mass)
 *   top1_jaccard  — jaccard component of the top-1 hybrid claim's value
 *   maxJaccard    — max jaccard across ALL surviving claims (lexical anchor anywhere?)
 *   maxKeySim     — max hybrid similarity between the QUESTION and any surviving KEY
 *                   (schema-aware: "do I even have a claim about the asked attribute?")
 * Per signal: train-chosen threshold (balanced accuracy, both directions tried),
 * holdout evaluation. Small-n caveat printed (19 train / 11 holdout abstentions —
 * thresholds here are evidence about SIGNAL QUALITY, not production dials).
 * Plus qualitative dumps: top-3 claims for 3 abstention + 3 answerable holdouts.
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
import { warmEmbeddings } from "../../../src/algebra/embedding.js";
import { createLocalEmbeddingAdapter, warmForQuestion } from "../embeddings-local.js";
import { autoRatify } from "./key-alias-auto.js";

const TARGET_CATEGORIES = new Set(["knowledge-update", "temporal-reasoning", "abstention"]);
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const pairKey = (a: string, b: string): string => (a < b ? `${a}\x1f${b}` : `${b}\x1f${a}`);

interface Obs {
  qid: string;
  category: string;
  answerable: boolean;
  train: boolean;
  signals: Record<string, number>;
  top3: Array<{ key: string; value: string; score: number }>;
  question: string;
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { file: { type: "string" }, claims: { type: "string" }, ratified: { type: "string" } },
  });
  if (!values.file || !values.claims || !values.ratified) {
    console.error("--file, --claims, --ratified are required");
    return 1;
  }

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

  const adapter = await createLocalEmbeddingAdapter();
  const cache = new EmbeddingCache();
  const cosine = cosineOver(adapter, cache);
  const hybrid = hybridMax(simJaccard, cosine);
  registerSimilarity("hybrid-sig", hybrid);
  // keys + questions both need embeddings for maxKeySim
  const allKeys = [...new Set(allClaims.map((c) => c.key))].sort();
  await warmEmbeddings(adapter, cache, [...allKeys, ...questions.map((q) => q.question)]);

  const dir = mkdtempSync(join(tmpdir(), "mneme-abst-sig-"));
  const session = openSession({ dbPath: join(dir, "sig.db"), writer: "abst-sig", source: "imported" });
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
          rho.by("hybrid-sig", q.question),
        ),
        { evaluationClock: t },
      );
      const scored = ranked.scored;
      const top1 = scored.length > 0 ? scored[0].score : -1;
      const top2 = scored.length > 1 ? scored[1].score : -1;
      const top5 = scored.slice(0, 5).map((s) => s.score);
      const survivorKeys = [...new Set(scored.map((s) => s.claim.key))];
      // entityCoverage: fraction of the question's entity-ish tokens (capitalized
      // mid-sentence words + number-bearing tokens like "991") present anywhere
      // in surviving claim text. The qualitative pattern: abstention questions
      // are missing-entity questions (Sacramento/Porsche/Tom absent) while the
      // TOPIC is well covered — invisible to similarity, visible to coverage.
      const QUESTION_WORDS = new Set(["When", "Which", "Who", "What", "How", "Where", "Why", "Did", "Do", "Does", "Is", "Are", "Was", "Were", "The", "I"]);
      const entityTokens = [...new Set((q.question.match(/\b(?:[A-Z][a-zA-Z]+|\d+[a-zA-Z]*)\b/g) ?? []).filter((w) => !QUESTION_WORDS.has(w)))];
      const corpusText = scored.map((s) => `${s.claim.subject} ${s.claim.key} ${String(s.claim.value)}`).join(" ").toLowerCase();
      const covered = entityTokens.filter((tok) => corpusText.includes(tok.toLowerCase())).length;
      const signals: Record<string, number> = {
        top1,
        margin12: scored.length > 1 ? top1 - top2 : 1,
        top5mean: top5.length ? top5.reduce((a, b) => a + b, 0) / top5.length : -1,
        top1_jaccard: scored.length > 0 ? simJaccard.scoreOne(scored[0].claim.value, q.question) : -1,
        maxJaccard: scored.length
          ? Math.max(...scored.map((s) => simJaccard.scoreOne(s.claim.value, q.question)))
          : -1,
        maxKeySim: survivorKeys.length
          ? Math.max(...survivorKeys.map((k) => hybrid.scoreOne(k, q.question)))
          : -1,
        entityCoverage: entityTokens.length ? covered / entityTokens.length : 1,
      };
      observations.push({
        qid: q.question_id,
        category: categoryOf(q),
        answerable: categoryOf(q) !== "abstention",
        train: parseInt(createHash("sha256").update(q.question_id).digest("hex").slice(0, 8), 16) % 2 === 0,
        signals,
        top3: scored.slice(0, 3).map((s) => ({
          key: s.claim.key,
          value: String(s.claim.value).slice(0, 70),
          score: r3(s.score),
        })),
        question: q.question,
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

  // --- per-signal train→holdout evaluation, both directions ---
  console.log("\nSMALL-N CAVEAT: 19 train / 11 holdout abstention questions — this ranks SIGNAL QUALITY, not production dials.\n");
  console.log("| signal | dir | train_thresh | holdout abstCorrect | holdout falseAbst | holdout balanced |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  const train = observations.filter((o) => o.train);
  const holdout = observations.filter((o) => !o.train);
  for (const sig of Object.keys(observations[0].signals)) {
    for (const dir of ["low", "high"] as const) {
      // abstain when signal < th (low) or signal > th (high)
      const abstains = (o: Obs, th: number) => (dir === "low" ? o.signals[sig] < th : o.signals[sig] > th);
      const vals = [...new Set(train.map((o) => o.signals[sig]))].sort((a, b) => a - b);
      const mids: number[] = [];
      for (let i = 1; i < vals.length; i++) mids.push((vals[i - 1] + vals[i]) / 2);
      let best = { th: 0, balanced: -1 };
      for (const th of mids) {
        const aR = train.filter((o) => !o.answerable && abstains(o, th)).length / Math.max(1, train.filter((o) => !o.answerable).length);
        const sR = train.filter((o) => o.answerable && !abstains(o, th)).length / Math.max(1, train.filter((o) => o.answerable).length);
        const bal = (aR + sR) / 2;
        if (bal > best.balanced) best = { th, balanced: bal };
      }
      const hAbst = holdout.filter((o) => !o.answerable);
      const hAns = holdout.filter((o) => o.answerable);
      const hCorrect = hAbst.filter((o) => abstains(o, best.th)).length;
      const hFalse = hAns.filter((o) => abstains(o, best.th)).length;
      const hBal = (hCorrect / Math.max(1, hAbst.length) + (hAns.length - hFalse) / Math.max(1, hAns.length)) / 2;
      console.log(
        `| ${sig} | ${dir} | ${r3(best.th)} | ${hCorrect}/${hAbst.length} | ${hFalse}/${hAns.length} | ${r3(hBal)} |`,
      );
    }
  }

  // --- qualitative dumps ---
  const dump = (o: Obs) => {
    console.log(`\n[${o.answerable ? o.category : "ABSTENTION"}] ${o.qid} — "${o.question.slice(0, 90)}"`);
    console.log(`  signals: ${Object.entries(o.signals).map(([k, v]) => `${k}=${r3(v)}`).join(" ")}`);
    for (const t of o.top3) console.log(`    ${t.score}  [${t.key}] ${JSON.stringify(t.value)}`);
  };
  console.log("\n— qualitative: 3 holdout ABSTENTION questions —");
  holdout.filter((o) => !o.answerable).slice(0, 3).forEach(dump);
  console.log("\n— qualitative: 3 holdout ANSWERABLE questions —");
  holdout.filter((o) => o.answerable).slice(0, 3).forEach(dump);
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
