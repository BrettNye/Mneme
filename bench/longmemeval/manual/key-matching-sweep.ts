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
import { openSession, pipe, leaf } from "../../../src/surface/index.js";
import type { Corpus as AlgebraCorpus } from "../../../src/algebra/types.js";
import { canonicalReadStages } from "../../../src/retrieval/read-pipeline.js";
import { entityTokensOf, coverageOf } from "../../../src/retrieval/coverage.js";
import { evaluationInstant } from "../answer.js";
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
import { simJaccard, registerSimilarity, similarityFn } from "../../../src/algebra/similarity.js";
import { RULE } from "../../../src/distribution/rules.js";
import { EmbeddingCache, cosineOver, hybridMax } from "../../../src/index.js";
import { warmEmbeddings } from "../../../src/algebra/embedding.js";
import { createLocalEmbeddingAdapter, warmForQuestion } from "../embeddings-local.js";
import { autoRatify } from "./key-alias-auto.js";

const TARGET_CATEGORIES = new Set(["knowledge-update", "temporal-reasoning", "abstention"]);
const KS = [1, 3, 10];
const MAX_K = 10;

export interface SweepCell {
  scorer: string;
  theta: number | "baseline" | "ratified" | "agent-decides";
  /** Ranking similarity fn for the answer arm ("jaccard" | "hybrid"). The
   *  jaccard-gated integrity baseline is always emitted; --rank hybrid adds
   *  hybrid-RANKED cells (abstention knobs stay OFF — calibration is a
   *  separate lever, not confounded here). */
  rank: string;
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
      ratified: { type: "string" },
      rank: { type: "string", default: "jaccard" },
      "agent-decides": { type: "boolean", default: false },
      distractors: { type: "string", default: "0" },
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
  const rank = String(values.rank);
  if (rank !== "jaccard" && rank !== "hybrid") {
    logError(`--rank must be "jaccard" or "hybrid", got "${rank}"`);
    return 1;
  }
  // --distractors D: synthetic haystack rehearsal. Each question's corpus gets
  // D x |own| additional claims pooled DETERMINISTICALLY from other questions
  // (whole-question blocks, rotating from i+1). Bounds the middle: harder than
  // oracle (crowded ranking, noisier census/coverage), easier than real
  // haystack (cross-question distractors are less confusable than same-user
  // sessions). $0 — reuses the existing extraction.
  const distractors = parseInt(String(values.distractors), 10);
  if (Number.isNaN(distractors) || distractors < 0) {
    logError(`--distractors must be a non-negative integer, got "${values.distractors}"`);
    return 1;
  }
  if (distractors > 0 && expectUpdateCorrect !== undefined) {
    logError("--expect-update-correct is oracle-calibrated; omit it when --distractors > 0");
    return 1;
  }

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
      records: ClaimRecordT[];
    }
    const qstates: QState[] = [];
    // Two passes: per-question evidence first, then deterministic distractor
    // pooling (whole-question blocks rotating from i+1 until D x |own| added).
    const perQuestion = questions.map((q) => claimsFor(q, allClaims, { oracle: true }));
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const own = perQuestion[i];
      let combined = own;
      if (distractors > 0) {
        const target = distractors * own.length;
        // Dedup by record reference: evidence sessions can be SHARED across
        // questions (perQuestion arrays alias the same allClaims objects), and
        // ingestQuestion's conservation check rejects duplicate records.
        const seen = new Set<ClaimRecordT>(own);
        const extra: ClaimRecordT[] = [];
        for (let step = 1; extra.length < target && step < questions.length; step++) {
          for (const r of perQuestion[(i + step) % questions.length]) {
            if (!seen.has(r)) {
              seen.add(r);
              extra.push(r);
            }
          }
        }
        combined = [...own, ...extra.slice(0, target)];
      }
      ingestQuestion(session, q, combined);
      const keyCounts = new Map<string, number>();
      for (const r of combined) keyCounts.set(r.key, (keyCounts.get(r.key) ?? 0) + 1);
      qstates.push({ q, corpusId: `lme-${q.question_id}`, keyCounts, records: combined });
    }
    if (distractors > 0) {
      const total = qstates.reduce((n, s) => n + s.records.length, 0);
      console.log(`distractor mode: D=${distractors}, total ingested claims ${total} across ${qstates.length} corpora`);
    }

    // --- embedding adapter (shared by key-pair scorer and, with --rank hybrid, ranking) ---
    let adapter: Awaited<ReturnType<typeof createLocalEmbeddingAdapter>> | null = null;
    let cache: InstanceType<typeof EmbeddingCache> | null = null;
    try {
      adapter = await createLocalEmbeddingAdapter();
      cache = new EmbeddingCache();
    } catch (err) {
      if (rank === "hybrid") {
        logError(`--rank hybrid requires the local embedding model: ${(err as Error).message}`);
        return 1;
      }
      logError(`embedding model unavailable (hybrid scorer will be skipped): ${(err as Error).message}`);
    }
    if (rank === "hybrid" && adapter && cache) {
      // Same registration as run.ts --rank hybrid; abstention knobs stay OFF —
      // this arm isolates the RANKING lever from the calibration lever.
      registerSimilarity("cosine", cosineOver(adapter, cache));
      registerSimilarity("hybrid", hybridMax(simJaccard, similarityFn("cosine")));
      for (const s of qstates) {
        await warmForQuestion(adapter, cache, s.records, s.q.question);
      }
      console.log(`hybrid RANKING ready: claim values + questions warmed for ${qstates.length} questions`);
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
    // Sweep/ratified cells use the selected ranking; the INTEGRITY baseline
    // below always stays jaccard-ranked so the recorded-value gate holds.
    const rankedOpts = rank === "hybrid" ? { ...armAOpts, rankFn: "hybrid" } : armAOpts;
    const cells: SweepCell[] = [];

    // --- integrity baseline pass (no aliases, jaccard rank) + sanity gate ---
    {
      const scores: QuestionScore[] = [];
      for (const s of qstates) scores.push(scoreQuestion(s.q, answerArmA(session, s.corpusId, s.q, armAOpts), KS));
      const rows = aggregate(scores, KS);
      cells.push({ scorer: "—", theta: "baseline", rank: "jaccard", rows, aliases: 0, questionsAffected: 0, largestComponent: 1 });

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

    // --- hybrid-RANKED no-alias baseline (the ranking lever in isolation) ---
    if (rank === "hybrid") {
      const scores: QuestionScore[] = [];
      for (const s of qstates) scores.push(scoreQuestion(s.q, answerArmA(session, s.corpusId, s.q, rankedOpts), KS));
      cells.push({ scorer: "—", theta: "baseline", rank: "hybrid", rows: aggregate(scores, KS), aliases: 0, questionsAffected: 0, largestComponent: 1 });
      console.log("pass done: hybrid-ranked baseline (no aliases)");
    }

    // --- scorers ---
    type Scorer = { name: string; scoreOne: (a: string, b: string) => number };
    const scorers: Scorer[] = [{ name: "jaccard", scoreOne: (a, b) => simJaccard.scoreOne(a, b) }];
    if (adapter && cache) {
      const allKeys = [...new Set(qstates.flatMap((s) => [...s.keyCounts.keys()]))].sort();
      await warmEmbeddings(adapter, cache, allKeys);
      const hybrid = hybridMax(simJaccard, cosineOver(adapter, cache));
      scorers.push({ name: "hybrid", scoreOne: (a, b) => hybrid.scoreOne(a, b) });
      console.log(`hybrid scorer ready: ${allKeys.length} distinct keys embedded`);
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
          const result = answerArmA(session, s.corpusId, s.q, { ...rankedOpts, keyAliases: map });
          scores.push(scoreQuestion(s.q, result, KS));
        }
        cells.push({
          scorer: scorer.name,
          theta,
          rank,
          rows: aggregate(scores, KS),
          aliases,
          questionsAffected: affected,
          largestComponent: largest,
        });
        console.log(`pass done: scorer=${scorer.name} theta=${theta} aliases=${aliases} affected=${affected}`);
      }
    }

    // --- agent-decides arm (coverage-annotation refusal, simulated agent) ---
    // The PRODUCT ships coverage as an annotation; the AGENT decides refusal.
    // This arm simulates the trivial agent policy at the VALIDATED operating
    // point: decline when the coverage fraction over the canonical-pipeline
    // survivors (the same pre-knob basis production recall annotates) drops
    // below 0.75 (abstention-signals study: 5/11 caught, 3/96 false). Declined
    // answerable questions pay full price in their metrics — no free lunch.
    const AGENT_DECLINE_BELOW = 0.75;

    // --- ratified arm (judged census candidates → precision-by-judgment maps) ---
    if (values.ratified) {
      const approved = new Set<string>();
      let judgedTotal = 0;
      for (const line of readFileSync(String(values.ratified), "utf-8")
        .split("\n")
        .filter((l) => l.trim().length > 0)) {
        const obj = JSON.parse(line) as { kind?: string; a?: string; b?: string; same?: boolean };
        if (obj.kind !== undefined) continue; // header
        judgedTotal++;
        if (obj.same && obj.a && obj.b) {
          approved.add(obj.a < obj.b ? `${obj.a}\x1f${obj.b}` : `${obj.b}\x1f${obj.a}`);
        }
      }
      console.log(`ratified arm: ${approved.size} approved of ${judgedTotal} judged pairs`);
      // Indicator scorer reuses autoRatify verbatim: components + canonical
      // rule identical to the blind arms; only edge admission differs.
      const indicator = (a: string, b: string): number =>
        approved.has(a < b ? `${a}\x1f${b}` : `${b}\x1f${a}`) ? 1 : 0;
      const scores: QuestionScore[] = [];
      let aliases = 0;
      let affected = 0;
      let largest = 1;
      for (const s of qstates) {
        const { map, stats } = autoRatify(s.keyCounts, indicator, 1);
        aliases += stats.aliases;
        if (stats.aliases > 0) affected++;
        if (stats.largestComponent > largest) largest = stats.largestComponent;
        scores.push(scoreQuestion(s.q, answerArmA(session, s.corpusId, s.q, { ...rankedOpts, keyAliases: map }), KS));
      }
      cells.push({
        scorer: "ratified",
        theta: "ratified",
        rank,
        rows: aggregate(scores, KS),
        aliases,
        questionsAffected: affected,
        largestComponent: largest,
      });
      console.log(`pass done: scorer=ratified aliases=${aliases} affected=${affected}`);

      if (values["agent-decides"]) {
        const agentScores: QuestionScore[] = [];
        let declines = 0;
        const declinedByCategory = new Map<string, number>();
        for (const s of qstates) {
          const { map } = autoRatify(s.keyCounts, indicator, 1);
          const t = evaluationInstant(s.q);
          // The same survivor basis production recall annotates: canonical
          // pipeline output, pre-knob (ρ only orders; the claim set is equal).
          const survivors = session.mneme.query<AlgebraCorpus>(
            s.corpusId,
            pipe(
              leaf(s.corpusId),
              ...canonicalReadStages({
                evaluationInstant: t,
                keyCardinality: MANUAL_KEY_CARDINALITY,
                keyAliases: map,
                evidencePoolingRule: RULE.MAX_MEAN,
              }),
            ),
            { evaluationClock: t },
          );
          const entityTokens = entityTokensOf(s.q.question);
          const { missing } = coverageOf(entityTokens, survivors.claims);
          const fraction = entityTokens.length
            ? (entityTokens.length - missing.length) / entityTokens.length
            : 1;
          if (fraction < AGENT_DECLINE_BELOW) {
            declines++;
            const cat = categoryOf(s.q);
            declinedByCategory.set(cat, (declinedByCategory.get(cat) ?? 0) + 1);
            agentScores.push(scoreQuestion(s.q, { arm: "A", claims: [], abstained: true }, KS));
          } else {
            agentScores.push(
              scoreQuestion(s.q, answerArmA(session, s.corpusId, s.q, { ...rankedOpts, keyAliases: map }), KS),
            );
          }
        }
        cells.push({
          scorer: "agent",
          theta: "agent-decides",
          rank,
          rows: aggregate(agentScores, KS),
          aliases,
          questionsAffected: affected,
          largestComponent: largest,
        });
        console.log(
          `pass done: scorer=agent declines=${declines} byCategory=${JSON.stringify([...declinedByCategory.entries()])}`,
        );
      }
    } else if (values["agent-decides"]) {
      logError("--agent-decides requires --ratified (the citable config's alias maps)");
      return 1;
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
      rank: c.rank,
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
          `(model ${header.model}, promptVersion ${header.promptVersion}). Ranking: ${rank} ` +
          "(integrity baseline always jaccard); scorer drives key-pair auto-ratification only (single-link components, " +
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
