/**
 * Key-matching oracle experiment: auto-ratification threshold sweep.
 * Spec: docs/superpowers/specs/2026-06-06-key-matching-oracle-experiment-design.md
 *
 *   npx tsx bench/longmemeval/manual/key-matching-sweep.ts \
 *     --file bench/datasets/longmemeval/longmemeval_oracle_target.json \
 *     --claims bench/datasets/longmemeval/longmemeval-oracle-claims.jsonl \
 *     [--thetas 0.5,0.6,0.7,0.8,0.9] [--expect-update-correct 0.403] [--append-results bench/RESULTS.md]
 *
 * Bench-only. Ingests each question ONCE; arms are read-only, so every
 * (scorer, theta) cell re-runs answerArmA with a different alias map against
 * the same store. Ranking stays jaccard in ALL passes (identical to the
 * recorded oracle baseline) — the scorer drives KEY-PAIR scoring only, so the
 * alias map is the only variable. Honest reporting: the full grid prints; the
 * baseline row must reproduce the recorded oracle numbers or the run aborts.
 */
import { parseArgs } from "node:util";
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "../../../src/surface/index.js";
import { markdownTable } from "../../lib/measure.js";
import {
  CacheHeader,
  ClaimRecord,
  LmeQuestion,
  categoryOf,
  normalizeQuestion,
  type LmeQuestionT,
  type ClaimRecordT,
} from "../types.js";
import { ingestQuestion, claimsFor } from "../ingest.js";
import { answerArmA } from "../answer.js";
import { scoreQuestion, aggregate, type QuestionScore, type ScoreRow } from "../score.js";
import { EXTRACTION_MODEL, PROMPT_VERSION } from "../../convert/longmemeval.js";
import { MANUAL_KEY_CARDINALITY } from "../run.js";
import { simJaccard } from "../../../src/algebra/similarity.js";
import { RULE } from "../../../src/distribution/rules.js";
import { EmbeddingCache, cosineOver, hybridMax } from "../../../src/index.js";
import { warmEmbeddings } from "../../../src/algebra/embedding.js";
import { createLocalEmbeddingAdapter } from "../embeddings-local.js";
import { autoRatify } from "./key-alias-auto.js";

const TARGET_CATEGORIES = new Set(["knowledge-update", "temporal-reasoning", "abstention"]);
const KS = [1, 3, 10];
const MAX_K = 10;

export interface SweepCell {
  scorer: string;
  theta: number | "baseline";
  rows: ScoreRow[]; // arm A aggregate rows for this cell
  aliases: number; // total alias entries across questions
  questionsAffected: number;
  largestComponent: number;
}

export interface SweepOpts {
  collect?: (cells: SweepCell[]) => void;
  onError?: (msg: string) => void;
}

/** Round to 3 decimals — the precision the recorded baseline tables use. */
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

export async function main(argv: string[], opts?: SweepOpts): Promise<number> {
  const logError = (msg: string): void => {
    console.error(msg);
    opts?.onError?.(msg);
  };

  const { values } = parseArgs({
    args: argv,
    options: {
      file: { type: "string" },
      claims: { type: "string" },
      thetas: { type: "string", default: "0.5,0.6,0.7,0.8,0.9" },
      raw: { type: "boolean", default: false },
      "expect-update-correct": { type: "string" },
      "append-results": { type: "string" },
    },
  });
  if (!values.file || !values.claims) {
    logError("--file and --claims are required");
    return 1;
  }
  const thetas = String(values.thetas)
    .split(",")
    .map((s) => parseFloat(s.trim()))
    .filter((n) => !Number.isNaN(n) && n > 0 && n <= 1);
  if (thetas.length === 0) {
    logError("--thetas must be a comma-separated list in (0, 1]");
    return 1;
  }
  const expectUpdateCorrect =
    values["expect-update-correct"] !== undefined
      ? parseFloat(String(values["expect-update-correct"]))
      : undefined;

  // --- load dataset + claims (same validation discipline as run.ts) ---
  const datasetRaw = JSON.parse(readFileSync(values.file, "utf-8")) as unknown[];
  const questions: LmeQuestionT[] = datasetRaw
    .map((r) => (values.raw ? normalizeQuestion(r) : LmeQuestion.parse(r)))
    .filter((q) => TARGET_CATEGORIES.has(categoryOf(q)));

  const lines = readFileSync(values.claims, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  const header = CacheHeader.parse(JSON.parse(lines[0]));
  if (header.model !== EXTRACTION_MODEL || header.promptVersion !== PROMPT_VERSION) {
    logError(
      `Claims cache header mismatch: model=${header.model}, promptVersion=${header.promptVersion}`,
    );
    return 1;
  }
  const allClaims: ClaimRecordT[] = lines.slice(1).map((l) => ClaimRecord.parse(JSON.parse(l)));

  // --- session + one-time ingest ---
  const dir = mkdtempSync(join(tmpdir(), "mneme-lme-sweep-"));
  const session = openSession({ dbPath: join(dir, "lme.db"), writer: "lme-sweep", source: "imported" });

  try {
    interface QState {
      q: LmeQuestionT;
      corpusId: string;
      keyCounts: Map<string, number>;
    }
    const qstates: QState[] = [];
    for (const q of questions) {
      const records = claimsFor(q, allClaims, { oracle: true });
      ingestQuestion(session, q, records);
      const keyCounts = new Map<string, number>();
      for (const r of records) keyCounts.set(r.key, (keyCounts.get(r.key) ?? 0) + 1);
      qstates.push({ q, corpusId: `lme-${q.question_id}`, keyCounts });
    }

    // MAX_MEAN pooling: extraction claims are SCALAR-confidence; canonical
    // grouping co-locates same-value claims across drifted keys (⊕_dedupe is
    // alias-blind) and the scalar binding rejects EVIDENCE_POOLED. MAX_MEAN is
    // the conservative scalar choice. Applied uniformly INCLUDING the baseline
    // pass — pooling never fires there (dedupe collapses same-key duplicates
    // first), which the sanity gate verifies by reproducing the recorded value.
    const armAOpts = {
      k: MAX_K,
      keyCardinality: MANUAL_KEY_CARDINALITY,
      evidencePoolingRule: RULE.MAX_MEAN,
    };
    const cells: SweepCell[] = [];

    // --- baseline pass (no aliases) + sanity gate ---
    {
      const scores: QuestionScore[] = [];
      for (const s of qstates) scores.push(scoreQuestion(s.q, answerArmA(session, s.corpusId, s.q, armAOpts), KS));
      const rows = aggregate(scores, KS);
      cells.push({ scorer: "—", theta: "baseline", rows, aliases: 0, questionsAffected: 0, largestComponent: 1 });

      if (expectUpdateCorrect !== undefined) {
        const ku = rows.find((r) => r.category === "knowledge-update" && r.metric === "updateCorrect");
        if (!ku || r3(ku.value) !== r3(expectUpdateCorrect)) {
          logError(
            `SANITY GATE FAILED: baseline KU updateCorrect ${ku ? r3(ku.value) : "missing"} !== expected ${r3(expectUpdateCorrect)} — broken rig, aborting`,
          );
          return 1;
        }
        console.log(`sanity gate: baseline KU updateCorrect ${r3(ku.value)} matches recorded oracle value ✓`);
      }
    }

    // --- scorers ---
    type Scorer = { name: string; scoreOne: (a: string, b: string) => number };
    const scorers: Scorer[] = [{ name: "jaccard", scoreOne: (a, b) => simJaccard.scoreOne(a, b) }];
    try {
      const adapter = await createLocalEmbeddingAdapter();
      const cache = new EmbeddingCache();
      const allKeys = [...new Set(qstates.flatMap((s) => [...s.keyCounts.keys()]))].sort();
      await warmEmbeddings(adapter, cache, allKeys);
      const hybrid = hybridMax(simJaccard, cosineOver(adapter, cache));
      scorers.push({ name: "hybrid", scoreOne: (a, b) => hybrid.scoreOne(a, b) });
      console.log(`hybrid scorer ready: ${allKeys.length} distinct keys embedded`);
    } catch (err) {
      logError(`hybrid scorer SKIPPED (model unavailable): ${(err as Error).message}`);
    }

    // --- sweep ---
    for (const scorer of scorers) {
      // Pair scores are theta-independent: memoize per question, filter per theta.
      const pairScores = qstates.map((s) => {
        const keys = [...s.keyCounts.keys()].sort();
        const m = new Map<string, number>();
        for (let i = 0; i < keys.length; i++)
          for (let j = i + 1; j < keys.length; j++)
            m.set(`${keys[i]}${keys[j]}`, scorer.scoreOne(keys[i], keys[j]));
        return m;
      });
      const lookup = (qi: number) => (a: string, b: string): number =>
        pairScores[qi].get(a < b ? `${a}${b}` : `${b}${a}`) ?? 0;

      for (const theta of thetas) {
        const scores: QuestionScore[] = [];
        let aliases = 0;
        let affected = 0;
        let largest = 1;
        for (let qi = 0; qi < qstates.length; qi++) {
          const s = qstates[qi];
          const { map, stats } = autoRatify(s.keyCounts, lookup(qi), theta);
          aliases += stats.aliases;
          if (stats.aliases > 0) affected++;
          if (stats.largestComponent > largest) largest = stats.largestComponent;
          const result = answerArmA(session, s.corpusId, s.q, { ...armAOpts, keyAliases: map });
          scores.push(scoreQuestion(s.q, result, KS));
        }
        cells.push({
          scorer: scorer.name,
          theta,
          rows: aggregate(scores, KS),
          aliases,
          questionsAffected: affected,
          largestComponent: largest,
        });
        console.log(`pass done: scorer=${scorer.name} theta=${theta} aliases=${aliases} affected=${affected}`);
      }
    }

    opts?.collect?.(cells);

    // --- report ---
    const metric = (c: SweepCell, category: string, name: string): number | string => {
      const row = c.rows.find((r) => r.category === category && r.arm === "A" && r.metric === name);
      return row ? r3(row.value) : "—";
    };
    const tableRows = cells.map((c) => ({
      scorer: c.scorer,
      theta: String(c.theta),
      KU_updateCorrect: metric(c, "knowledge-update", "updateCorrect"),
      "KU_recall@1": metric(c, "knowledge-update", "recall@1"),
      "KU_recall@3": metric(c, "knowledge-update", "recall@3"),
      "KU_recall@10": metric(c, "knowledge-update", "recall@10"),
      TR_correct: metric(c, "temporal-reasoning", "temporalCorrect"),
      "TR_recall@3": metric(c, "temporal-reasoning", "recall@3"),
      ABS_correct: metric(c, "abstention", "abstentionCorrect"),
      aliases: c.aliases,
      qAffected: c.questionsAffected,
      maxComponent: c.largestComponent,
    }));
    const table = markdownTable(tableRows);
    console.log("\n" + table + "\n");

    if (values["append-results"]) {
      const addendum = [
        "",
        "## Key-matching oracle experiment — auto-ratification threshold sweep (2026-06-06)",
        "",
        `Dataset: ${values.file} (oracle attribution). Claims: ${values.claims} ` +
          `(model ${header.model}, promptVersion ${header.promptVersion}). Ranking jaccard in all ` +
          "passes; scorer drives key-pair auto-ratification only (single-link components, " +
          "canonical = most-claims then lexicographic). Bench-only experiment policy — the product " +
          "keeps human/agent ratification; this curve is calibration evidence for a future " +
          "auto-suggest dial. Spec: docs/superpowers/specs/2026-06-06-key-matching-oracle-experiment-design.md",
        "",
        table,
        "",
      ].join("\n");
      appendFileSync(String(values["append-results"]), addendum, "utf8");
      console.log(`addendum appended to ${values["append-results"]}`);
    }
    return 0;
  } finally {
    session.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
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
