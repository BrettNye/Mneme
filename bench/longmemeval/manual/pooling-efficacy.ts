/**
 * Arm-P pooling efficacy instrument — pre-registered 2026-06-07.
 * Spec: docs/superpowers/specs/2026-06-07-bio-efficacy-instrument-design.md
 * Protocol: docs/bio/2026-06-07-bio-efficacy-protocol.md
 *
 *   npx tsx bench/longmemeval/manual/pooling-efficacy.ts \
 *     --file <oracle_target.json> --claims <oracle-claims.jsonl> \
 *     --ratified <judgments-min094.jsonl> [--pseudocounts 2,5,10]
 *
 *   --smoke  run the fixture-scale smoke test (network-free, exits nonzero on failure)
 *
 * Measures whether Beta-promoted, evidence-pooled confidence carries usable
 * information that scalar/MAX_MEAN confidence does not (P1 separation).
 * Pooling computed HARNESS-SIDE: the read pipeline never surfaces pooled
 * confidence (contradiction.ts:74 — consensus groups never cluster; read path
 * discards combinedConfidences). P1 signal = bindingFor("beta").combine(
 * RULE.EVIDENCE_POOLED, ...) over the top-ranked claim's group of survivors
 * keyed by (subject, canonicalKey(aliasMap), valueHash).
 */
import { parseArgs } from "node:util";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openSession, pipe, leaf, rho } from "../../../src/surface/index.js";
import type { RankedCorpus } from "../../../src/algebra/types.js";
import { canonicalReadStages } from "../../../src/retrieval/read-pipeline.js";
import { entityTokensOf, coverageOf } from "../../../src/retrieval/coverage.js";
import {
  CacheHeader,
  ClaimRecord,
  LmeQuestion,
  normalizeQuestion,
  categoryOf,
  type LmeQuestionT,
  type ClaimRecordT,
} from "../types.js";
import { ingestQuestion, claimsFor, corpusIdFor } from "../ingest.js";
import { answerArmA, evaluationInstant } from "../answer.js";
import { scoreQuestion, aggregate } from "../score.js";
import { MANUAL_KEY_CARDINALITY } from "../run.js";
import { RULE } from "../../../src/distribution/rules.js";
import { bindingFor } from "../../../src/distribution/registry.js";
import { betaFromRaw } from "../../../src/write/source-weight.js";
import type { ClaimSchema } from "../../../src/catalog/schema.js";
import { EmbeddingCache, cosineOver, hybridMax } from "../../../src/index.js";
import { warmEmbeddings } from "../../../src/algebra/embedding.js";
import { createLocalEmbeddingAdapter, warmForQuestion } from "../embeddings-local.js";
import { autoRatify } from "./key-alias-auto.js";
import { loadRatifiedPairs, pairKey } from "./key-alias-auto.js";
import { splitFolds } from "./holdout.js";

// ---------------------------------------------------------------------------
// SOURCE constant — used in EXACTLY THREE PLACES:
//   1. openSession({ source: SOURCE })
//   2. scalarPseudocount: { [SOURCE]: pc }
//   3. betaFromRaw(<raw>, SOURCE, schema)
// A mismatch is a silent no-op (source-weight.test.ts precedent / protocol note).
// ---------------------------------------------------------------------------
const SOURCE = "imported" as const;

/** Pseudocount sweep values. */
const PSEUDOCOUNTS = [2, 5, 10];

const TARGET_CATEGORIES = new Set(["knowledge-update", "temporal-reasoning", "abstention"]);
const KS = [1, 3, 10];
const MAX_K = 10;

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Canonical key via the alias map. */
const canonicalOf = (key: string, aliases: Record<string, string>): string =>
  aliases[key] ?? key;

// ---------------------------------------------------------------------------
// Harness-side pooled top-1 confidence
//
// Groups post-pipeline survivors by (subject, canonicalKey(aliasMap), valueHash).
// Takes the top-ranked claim's group. Folds via EVIDENCE_POOLED left-to-right.
// Returns undefined when there are no survivors.
// ---------------------------------------------------------------------------
interface PooledResult {
  pooledMean: number;
  groupSize: number;
}

function computePooledTop1(
  scored: RankedCorpus["scored"],
  aliasMap: Record<string, string>,
): PooledResult | undefined {
  if (scored.length === 0) return undefined;

  const top = scored[0].claim;
  const topKey = canonicalOf(top.key, aliasMap);
  const topGroup = scored.filter(
    (s) =>
      s.claim.subject === top.subject &&
      canonicalOf(s.claim.key, aliasMap) === topKey &&
      s.claim.valueHash === top.valueHash,
  );

  if (topGroup.length === 0) return undefined;

  // All promoted claims share distribution "beta"
  const dist = topGroup[0].claim.confidence.distribution;
  const binding = bindingFor(dist);
  let pooled = topGroup[0].claim.confidence.parameters;
  for (let i = 1; i < topGroup.length; i++) {
    pooled = binding.combine(RULE.EVIDENCE_POOLED, pooled, topGroup[i].claim.confidence.parameters);
  }
  const pooledMean = binding.mean(pooled);
  return { pooledMean, groupSize: topGroup.length };
}

// ---------------------------------------------------------------------------
// P1 cross-fit evaluation
//
// Strategy: splitFolds partitions abstention questions into A (isTrain=true)
// and B (isTrain=false). Cross-fit: train threshold on A, evaluate on B; swap.
// Pool held-out predictions.
//
// Residual class = abstention-labeled AND coverageOf does NOT flag
// (entity tokens appear in claims but attribute is missing).
// ---------------------------------------------------------------------------
interface P1Obs {
  qid: string;
  isAbstention: boolean;
  isAnswerable: boolean;
  isResidual: boolean;   // abstention AND NOT entityCoverage-flagged
  pooledSignal: number;  // harness-side pooled top-1 mean (or 0 if no survivors)
  scalarSignal: number;  // baseline MAX_MEAN top-1 scalar confidence (or 0)
  fold: "A" | "B";       // which fold this question belongs to (isTrain ? A : B)
}

interface P1Counts {
  tp: number;    // residual abstentions correctly flagged
  fp: number;    // answerable questions wrongly flagged
  totalAnswerable: number;
  totalResidual: number;
  falseAbst: number;    // alias for fp (false abstention)
  precision: number;
  isUnderpowered: boolean;
}

function evalP1(
  obs: P1Obs[],
  threshold: number,
  signalFn: (o: P1Obs) => number,
  flagFn: (signal: number, th: number) => boolean,
): P1Counts {
  const residuals = obs.filter((o) => o.isResidual);
  const answerable = obs.filter((o) => o.isAnswerable);
  const tp = residuals.filter((o) => flagFn(signalFn(o), threshold)).length;
  const fp = answerable.filter((o) => flagFn(signalFn(o), threshold)).length;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  return {
    tp,
    fp,
    totalAnswerable: answerable.length,
    totalResidual: residuals.length,
    falseAbst: fp,
    precision,
    isUnderpowered: tp < 4,
  };
}

/** Choose a threshold on training observations (maximize balanced accuracy). */
function chooseThreshold(
  trainObs: P1Obs[],
  signalFn: (o: P1Obs) => number,
  flagFn: (signal: number, th: number) => boolean,
): number {
  const vals = [...new Set(trainObs.map((o) => signalFn(o)))].sort((a, b) => a - b);
  const mids: number[] = [];
  for (let i = 1; i < vals.length; i++) mids.push((vals[i - 1] + vals[i]) / 2);

  const trainResiduals = trainObs.filter((o) => o.isResidual);
  const trainAnswerable = trainObs.filter((o) => o.isAnswerable);

  let bestTh = mids[0] ?? 0.5;
  let bestBal = -1;
  for (const th of mids) {
    const tpR = trainResiduals.filter((o) => flagFn(signalFn(o), th)).length /
      Math.max(1, trainResiduals.length);
    const tnA = trainAnswerable.filter((o) => !flagFn(signalFn(o), th)).length /
      Math.max(1, trainAnswerable.length);
    const bal = (tpR + tnA) / 2;
    if (bal > bestBal) {
      bestBal = bal;
      bestTh = th;
    }
  }
  return bestTh;
}

// ---------------------------------------------------------------------------
// Per-sweep-point run
// ---------------------------------------------------------------------------
interface SweepResult {
  pc: number;
  p1Pooled: P1Counts;
  p1Scalar: P1Counts;
  p2KuUpdateCorrect: number | null;
  p2Recall3: number | null;
  p2Recall10: number | null;
  p0Status: "PASS";  // P0 is verified in tests; harness assumes substrate correct
}

async function runSweepPoint(opts: {
  pc: number;
  questions: LmeQuestionT[];
  allClaims: ClaimRecordT[];
  approved: Set<string>;
  adapter: Awaited<ReturnType<typeof createLocalEmbeddingAdapter>>;
  cache: EmbeddingCache;
  runP2: boolean;
}): Promise<SweepResult> {
  const { pc, questions, allClaims, approved, adapter, cache, runP2 } = opts;

  // Build schema for betaFromRaw (source-weight.test.ts cast precedent)
  const schema = { scalarPseudocount: { [SOURCE]: pc } } as unknown as ClaimSchema;

  // Fresh tmp DB per sweep point (AlreadyIngestedError contract)
  const dir = mkdtempSync(join(tmpdir(), "mneme-pool-eff-"));
  const session = openSession({
    dbPath: join(dir, "pool.db"),
    writer: "pool-eff",
    source: SOURCE,  // USE 1: session source
  });

  const p1Observations: P1Obs[] = [];
  const questionStates: Array<{
    q: LmeQuestionT;
    aliasMap: Record<string, string>;
    corpusId: string;
  }> = [];

  try {
    // Ingest all questions with promotion hook
    for (const q of questions) {
      const records = claimsFor(q, allClaims, { oracle: true });
      ingestQuestion(session, q, records, {
        scalarPseudocount: { [SOURCE]: pc },  // USE 2: pseudocount override key
        mapRecord: (rec, base) => ({
          ...base,
          confidence: betaFromRaw(
            base.confidence !== undefined
              ? (typeof base.confidence === "number" ? base.confidence : (base.confidence as any)?.raw ?? 1)
              : 1,
            SOURCE,  // USE 3: betaFromRaw source argument
            schema,
          ),
        }),
      });
    }

    // Build alias maps (ratified pairs, indicator scorer)
    const indicator = (a: string, b: string): number =>
      approved.has(pairKey(a, b)) ? 1 : 0;

    for (const q of questions) {
      const records = claimsFor(q, allClaims, { oracle: true });
      const keyCounts = new Map<string, number>();
      for (const r of records) keyCounts.set(r.key, (keyCounts.get(r.key) ?? 0) + 1);
      const { map: aliasMap } = autoRatify(keyCounts, indicator, 1);
      questionStates.push({ q, aliasMap, corpusId: corpusIdFor(q.question_id) });
    }

    // Query each question to build P1 observations
    for (const { q, aliasMap, corpusId } of questionStates) {
      const t = evaluationInstant(q);
      const cat = categoryOf(q);
      const isAbstention = cat === "abstention";
      const isAnswerable = !isAbstention;

      // POOLING-RULE BRANCH: Beta corpora -> EVIDENCE_POOLED (config fidelity; inert for serving)
      const rankedPooled = session.mneme.query<RankedCorpus>(
        corpusId,
        pipe(
          leaf(corpusId),
          ...canonicalReadStages({
            evaluationInstant: t,
            keyCardinality: MANUAL_KEY_CARDINALITY,
            keyAliases: aliasMap,
            evidencePoolingRule: RULE.EVIDENCE_POOLED,
          }),
          rho.by("hybrid", q.question),
        ),
        { evaluationClock: t },
      );

      // Scalar BASELINE pass: unpromoted MAX_MEAN (the recorded config, key-matching-sweep precedent)
      const rankedScalar = session.mneme.query<RankedCorpus>(
        corpusId,
        pipe(
          leaf(corpusId),
          ...canonicalReadStages({
            evaluationInstant: t,
            keyCardinality: MANUAL_KEY_CARDINALITY,
            keyAliases: aliasMap,
            evidencePoolingRule: RULE.MAX_MEAN,
          }),
          rho.by("hybrid", q.question),
        ),
        { evaluationClock: t },
      );

      // Harness-side pooled signal
      const pooledResult = computePooledTop1(rankedPooled.scored, aliasMap);
      const pooledSignal = pooledResult?.pooledMean ?? 0;

      // Scalar baseline: top-1 raw confidence (scalar path MAX_MEAN)
      const scalarSignal =
        rankedScalar.scored.length > 0
          ? (() => {
              const c = rankedScalar.scored[0].claim.confidence;
              return c.distribution === "beta"
                ? c.parameters.alpha / (c.parameters.alpha + c.parameters.beta)
                : (c.parameters as any).p ?? c.raw;
            })()
          : 0;

      // Residual class: abstention-labeled AND coverageOf does NOT flag
      let isResidual = false;
      if (isAbstention) {
        const records = claimsFor(q, allClaims, { oracle: true });
        // survivors from either path — use pooled path survivors
        const survivors = rankedPooled.scored.map((s) => s.claim);
        const entityTokens = entityTokensOf(q.question);
        const { missing } = coverageOf(entityTokens, survivors);
        // coverageOf "flags" = missing.length > 0 (entity missing from survivors)
        // residual = abstention AND entity IS covered (missing.length === 0 or entity absent)
        // ie: entity tokens appear in claims but attribute is missing
        const isFlagged = entityTokens.length > 0 && missing.length > 0;
        isResidual = !isFlagged; // abstention not caught by coverage = residual class
      }

      p1Observations.push({
        qid: q.question_id,
        isAbstention,
        isAnswerable,
        isResidual,
        pooledSignal,
        scalarSignal,
        fold: "A", // will be set below via splitFolds
      });
    }

    // Annotate fold membership
    const { A: foldAQ, B: foldBQ } = splitFolds(questions, (q) => q.question_id);
    const foldAIds = new Set(foldAQ.map((q) => q.question_id));
    for (const obs of p1Observations) {
      obs.fold = foldAIds.has(obs.qid) ? "A" : "B";
    }

    // Cross-fit: train threshold on A, evaluate on B; swap; pool held-out predictions
    const signalFn = (o: P1Obs) => o.pooledSignal;
    const scalarSignalFn = (o: P1Obs) => o.scalarSignal;
    const flagFn = (signal: number, th: number) => signal > th;

    const obsA = p1Observations.filter((o) => o.fold === "A");
    const obsB = p1Observations.filter((o) => o.fold === "B");

    // Fold 1: train on A, eval on B
    const thPooledFromA = chooseThreshold(obsA, signalFn, flagFn);
    const thScalarFromA = chooseThreshold(obsA, scalarSignalFn, flagFn);

    // Fold 2: train on B, eval on A
    const thPooledFromB = chooseThreshold(obsB, signalFn, flagFn);
    const thScalarFromB = chooseThreshold(obsB, scalarSignalFn, flagFn);

    // Pool held-out predictions
    const heldOutPooled: P1Obs[] = [
      ...obsB.map((o) => ({ ...o, _th: thPooledFromA })),
      ...obsA.map((o) => ({ ...o, _th: thPooledFromB })),
    ] as any;
    const heldOutScalar: P1Obs[] = [
      ...obsB.map((o) => ({ ...o, _th: thScalarFromA })),
      ...obsA.map((o) => ({ ...o, _th: thScalarFromB })),
    ] as any;

    // Evaluate on pooled held-out using each obs's threshold
    const evalPooled = (obs: P1Obs & { _th: number }) => flagFn(signalFn(obs), obs._th);
    const evalScalar = (obs: P1Obs & { _th: number }) => flagFn(scalarSignalFn(obs), obs._th);

    const calcCounts = (
      heldOut: Array<P1Obs & { _th: number }>,
      evalFn: (o: P1Obs & { _th: number }) => boolean,
    ): P1Counts => {
      const residuals = heldOut.filter((o) => o.isResidual);
      const answerable = heldOut.filter((o) => o.isAnswerable);
      const tp = residuals.filter(evalFn).length;
      const fp = answerable.filter(evalFn).length;
      const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
      return {
        tp,
        fp,
        totalAnswerable: answerable.length,
        totalResidual: residuals.length,
        falseAbst: fp,
        precision,
        isUnderpowered: tp < 4,
      };
    };

    const p1Pooled = calcCounts(heldOutPooled as any, evalPooled as any);
    const p1Scalar = calcCounts(heldOutScalar as any, evalScalar as any);

    // P2 (only run for pc=2, the CITABLE cell)
    let p2KuUpdateCorrect: number | null = null;
    let p2Recall3: number | null = null;
    let p2Recall10: number | null = null;

    if (runP2) {
      // The CITABLE cell: ratified aliases + hybrid rank — same as key-matching-sweep citable config
      // Run answerArmA with EVIDENCE_POOLED (pooling-rule branch) over the promoted pc=2 corpus
      const scores = [];
      for (const { q, aliasMap, corpusId } of questionStates) {
        const result = answerArmA(session, corpusId, q, {
          k: MAX_K,
          keyCardinality: MANUAL_KEY_CARDINALITY,
          keyAliases: aliasMap,
          evidencePoolingRule: RULE.EVIDENCE_POOLED,
          rankFn: "hybrid",
        });
        scores.push(scoreQuestion(q, result, KS));
      }
      const rows = aggregate(scores, KS);

      const kuUC = rows.find(
        (r) => r.category === "knowledge-update" && r.arm === "A" && r.metric === "updateCorrect",
      );
      const kuR3 = rows.find(
        (r) => r.category === "knowledge-update" && r.arm === "A" && r.metric === "recall@3",
      );
      const kuR10 = rows.find(
        (r) => r.category === "knowledge-update" && r.arm === "A" && r.metric === "recall@10",
      );
      p2KuUpdateCorrect = kuUC ? r3(kuUC.value) : null;
      p2Recall3 = kuR3 ? r3(kuR3.value) : null;
      p2Recall10 = kuR10 ? r3(kuR10.value) : null;
    }

    return { pc, p1Pooled, p1Scalar, p2KuUpdateCorrect, p2Recall3, p2Recall10, p0Status: "PASS" };
  } finally {
    session.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

// ---------------------------------------------------------------------------
// Smoke test mode (--smoke)
// ---------------------------------------------------------------------------

async function runSmoke(): Promise<number> {
  const dir = dirname(fileURLToPath(import.meta.url));
  const fixtureDir = join(dir, "..", "fixtures");
  const datasetPath = join(fixtureDir, "dataset.json");
  const claimsPath = join(fixtureDir, "claims.jsonl");

  if (!existsSync(datasetPath) || !existsSync(claimsPath)) {
    console.error(`SMOKE FAIL: fixtures not found at ${fixtureDir}`);
    return 1;
  }

  console.log("smoke: loading fixtures...");
  const datasetRaw = JSON.parse(readFileSync(datasetPath, "utf-8")) as unknown[];
  // Fixture uses the already-normalized schema (LmeQuestion.parse, not normalizeQuestion)
  const questions: LmeQuestionT[] = datasetRaw
    .map((r) => LmeQuestion.parse(r))
    .filter((q) => TARGET_CATEGORIES.has(categoryOf(q)));

  const lines = readFileSync(claimsPath, "utf-8").split("\n").filter((l) => l.trim().length > 0);
  CacheHeader.parse(JSON.parse(lines[0]));
  const allClaims: ClaimRecordT[] = lines.slice(1).map((l) => ClaimRecord.parse(JSON.parse(l)));

  console.log(`smoke: ${questions.length} questions, ${allClaims.length} claims`);

  // Verify fixture integrity: abstention question in fixture
  const absQ = questions.find((q) => categoryOf(q) === "abstention");
  if (!absQ) {
    console.error("SMOKE FAIL: no abstention question in fixture");
    return 1;
  }
  console.log(`smoke: abstention question: ${absQ.question_id} — "${absQ.question}"`);

  // Check that the committed fixture abstention Q has NO oracle claims
  // (so entityCoverage flags it → not residual class, per spec note)
  const absRecords = claimsFor(absQ, allClaims, { oracle: true });
  console.log(`smoke: abstention Q oracle claims: ${absRecords.length} (expect 0 for fixture)`);

  // Synthetic residual-class case:
  // An abstention-labeled question whose entity tokens appear in claims but whose
  // attribute is missing — cannot exercise this via committed fixture alone.
  //
  // We synthesize by: a question "What is Alice's hobby?" (entity "Alice" appears
  // in claims, but no hobby claim exists). This IS an abstention Q (no oracle sessions),
  // and entity "Alice" IS covered by surviving claims.
  const syntheticQ: LmeQuestionT = {
    question_id: "smoke-synthetic-residual_abs",
    question_type: "single-session-user",
    question: "What is Alice's hobby?",
    question_date: "2023/06/01 (Thu) 10:00",
    answer: null,
    answer_session_ids: [],
    sessions: questions[0].sessions, // borrow sessions for ingest shape
  };

  // For the synthetic residual case, use the existing KU claims (Alice/employer claims)
  // The entity "Alice" will appear in those claims but hobby won't be present.
  const syntheticClaims = claimsFor(questions[0], allClaims, { oracle: true });

  console.log(`smoke: synthetic residual case: "${syntheticQ.question}"`);
  console.log(`  entity tokens: ${entityTokensOf(syntheticQ.question).join(", ")}`);

  // Verify entity tokens of the synthetic Q cover something in the existing claims
  const synClaimObjs = syntheticClaims.map((r) => ({
    subject: r.subject,
    key: r.key,
    value: r.value,
    // minimal Claim shape for coverageOf
  }));
  const entityTokens = entityTokensOf(syntheticQ.question);
  // Build a fake Claim array for coverageOf (just needs subject/key/value strings)
  const fakeClaims = synClaimObjs.map((o) => ({
    subject: o.subject,
    key: o.key,
    value: o.value,
  })) as any[];

  const { missing } = coverageOf(entityTokens, fakeClaims);
  const isFlagged = entityTokens.length > 0 && missing.length > 0;
  console.log(`  missing tokens: ${missing.join(", ")} (flagged=${isFlagged})`);
  console.log(`  isResidual = !isFlagged = ${!isFlagged}`);

  if (isFlagged) {
    // The entity "Alice" appears in subject field of claims — should be covered
    console.error(
      "SMOKE FAIL: synthetic residual case entity not covered by claims — " +
        `missing: ${missing.join(", ")}. Entity '${entityTokens[0]}' not found in ` +
        `claims' subject/key/value. Check fixture claims.`
    );
    return 1;
  }

  console.log("smoke: synthetic residual case IS residual-class (entity covered, attribute absent) ✓");

  // Run a minimal sweep (pc=2, jaccard ranking) over the fixtures (no embeddings)
  const pc = 2;
  const schema = { scalarPseudocount: { [SOURCE]: pc } } as unknown as ClaimSchema;
  const tmpDir = mkdtempSync(join(tmpdir(), "mneme-smoke-pool-"));
  const session = openSession({
    dbPath: join(tmpDir, "smoke.db"),
    writer: "smoke-pool",
    source: SOURCE,
  });

  let ok = true;
  try {
    for (const q of [...questions, syntheticQ]) {
      const records = q === syntheticQ ? syntheticClaims : claimsFor(q, allClaims, { oracle: true });
      ingestQuestion(session, q, records, {
        scalarPseudocount: { [SOURCE]: pc },
        mapRecord: (rec, base) => ({
          ...base,
          confidence: betaFromRaw(
            base.confidence !== undefined
              ? (typeof base.confidence === "number" ? base.confidence : (base.confidence as any)?.raw ?? 1)
              : 1,
            SOURCE,
            schema,
          ),
        }),
      });
    }

    // Query each question with jaccard ranking (smoke: no embeddings)
    for (const q of [...questions, syntheticQ]) {
      const corpusId = corpusIdFor(q.question_id);
      const t = evaluationInstant(q);
      const ranked = session.mneme.query<RankedCorpus>(
        corpusId,
        pipe(
          leaf(corpusId),
          ...canonicalReadStages({
            evaluationInstant: t,
            keyCardinality: MANUAL_KEY_CARDINALITY,
            keyAliases: {},
            evidencePoolingRule: RULE.EVIDENCE_POOLED,
          }),
          rho.jaccard(q.question),
        ),
        { evaluationClock: t },
      );

      const cat = categoryOf(q);
      const survivors = ranked.scored.map((s) => s.claim);
      const tokens = entityTokensOf(q.question);
      const { missing: missingToks } = coverageOf(tokens, survivors);
      const isFlaggedQ = tokens.length > 0 && missingToks.length > 0;
      const isResidual = cat === "abstention" && !isFlaggedQ;

      console.log(
        `  ${q.question_id} [${cat}] survivors=${survivors.length} residual=${isResidual}`,
      );

      // Integrity check: promoted claims have beta distribution
      for (const s of ranked.scored) {
        if (s.claim.confidence.distribution !== "beta") {
          console.error(
            `SMOKE FAIL: claim ${s.claim.id} has distribution "${s.claim.confidence.distribution}", ` +
              `expected "beta" after promotion`
          );
          ok = false;
        }
      }
    }

    if (!ok) {
      console.error("SMOKE FAIL: integrity check failed");
      return 1;
    }

    // Verify P0 at the binding level (smoke sanity)
    const { betaFromRaw: bfr } = await import("../../../src/write/source-weight.js");
    const schemaCheck = { scalarPseudocount: { imported: 2 } } as unknown as ClaimSchema;
    const x = bfr(0.8, "imported", schemaCheck);
    const pooled = bindingFor("beta").combine(RULE.EVIDENCE_POOLED, x.parameters, x.parameters);
    if (pooled.alpha !== 4.2 || pooled.beta !== 1.4 + 1.4 - 1) {
      console.error(
        `SMOKE FAIL: P0 binding check failed: alpha=${pooled.alpha} beta=${pooled.beta}`
      );
      return 1;
    }
    console.log("smoke: P0 binding check ✓ (alpha=4.2, beta=1.7999999999999998)");

    console.log("smoke: PASS");
    return 0;
  } finally {
    session.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function printSweepTable(results: SweepResult[]): void {
  console.log("\n| pc | signal | TP | FP | precision | falseAbst | totalResidual | totalAnswerable | underpowered |");
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of results) {
    const pRow = (label: string, c: P1Counts) =>
      `| ${r.pc} | ${label} | ${c.tp} | ${c.fp} | ${r3(c.precision)} | ${c.falseAbst} | ${c.totalResidual} | ${c.totalAnswerable} | ${c.isUnderpowered ? "UNDERPOWERED" : "-"} |`;
    console.log(pRow("pooled", r.p1Pooled));
    console.log(pRow("scalar/MAX_MEAN", r.p1Scalar));
  }

  // P2 row (pc=2 only)
  const p2 = results.find((r) => r.pc === 2);
  if (p2 && p2.p2KuUpdateCorrect !== null) {
    console.log(`\n| pc | metric | value |`);
    console.log(`| --- | --- | --- |`);
    console.log(`| 2 | KU updateCorrect | ${p2.p2KuUpdateCorrect} |`);
    console.log(`| 2 | recall@3 | ${p2.p2Recall3} |`);
    console.log(`| 2 | recall@10 | ${p2.p2Recall10} |`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      file: { type: "string" },
      claims: { type: "string" },
      ratified: { type: "string" },
      pseudocounts: { type: "string", default: PSEUDOCOUNTS.join(",") },
      smoke: { type: "boolean", default: false },
      "expect-update-correct": { type: "string" },
      "expect-recall3": { type: "string" },
      "expect-recall10": { type: "string" },
    },
  });

  if (values.smoke) {
    return runSmoke();
  }

  if (!values.file || !values.claims || !values.ratified) {
    console.error("--file, --claims, --ratified are required (or use --smoke)");
    return 1;
  }

  const pseudocounts = String(values.pseudocounts)
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n) && n > 0);
  if (pseudocounts.length === 0) {
    console.error("--pseudocounts must be a comma-separated list of positive integers");
    return 1;
  }

  // Parse --expect-* flags (3-decimal, at r3 precision, abort convention)
  const expectUpdateCorrect =
    values["expect-update-correct"] !== undefined
      ? parseFloat(String(values["expect-update-correct"]))
      : undefined;
  const expectRecall3 =
    values["expect-recall3"] !== undefined
      ? parseFloat(String(values["expect-recall3"]))
      : undefined;
  const expectRecall10 =
    values["expect-recall10"] !== undefined
      ? parseFloat(String(values["expect-recall10"]))
      : undefined;

  // Load dataset + claims
  const datasetRaw = JSON.parse(readFileSync(String(values.file), "utf-8")) as unknown[];
  const questions: LmeQuestionT[] = datasetRaw
    .map(normalizeQuestion)
    .filter((q) => TARGET_CATEGORIES.has(categoryOf(q)));

  const lines = readFileSync(String(values.claims), "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  CacheHeader.parse(JSON.parse(lines[0]));
  const allClaims: ClaimRecordT[] = lines.slice(1).map((l) => ClaimRecord.parse(JSON.parse(l)));

  // Load ratified pairs
  const approved = loadRatifiedPairs(String(values.ratified));
  console.log(`loaded ${approved.size} approved pairs from ${values.ratified}`);

  // ONE shared EmbeddingCache + ONE warmEmbeddings pass (attribution argument)
  const adapter = await createLocalEmbeddingAdapter();
  const cache = new EmbeddingCache();
  const cosine = cosineOver(adapter, cache);
  const hybrid = hybridMax(
    { scoreOne: (a: string, b: string) => {
      // inline jaccard for warm pass
      const ta = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
      const tb = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
      const intersection = [...ta].filter((w) => tb.has(w)).length;
      const union = new Set([...ta, ...tb]).size;
      return union === 0 ? 0 : intersection / union;
    } } as any,
    cosine,
  );

  // warm all claim values + question texts
  const allKeys = [...new Set(allClaims.map((c) => c.key))].sort();
  const questionTexts = questions.map((q) => q.question);
  console.log(`warming embeddings: ${allKeys.length} keys + ${questionTexts.length} questions`);
  await warmEmbeddings(adapter, cache, [...allKeys, ...questionTexts]);
  for (const q of questions) {
    const records = claimsFor(q, allClaims, { oracle: true });
    await warmForQuestion(adapter, cache, records, q.question);
  }
  console.log("embeddings warm ✓");

  // Register hybrid for use in canonicalReadStages ranking
  const { registerSimilarity, simJaccard } = await import("../../../src/algebra/similarity.js");
  registerSimilarity("hybrid", hybridMax(simJaccard, cosine));

  // Run sweep
  const results: SweepResult[] = [];
  for (const pc of pseudocounts) {
    console.log(`\n=== sweep point pc=${pc} ===`);
    const result = await runSweepPoint({
      pc,
      questions,
      allClaims,
      approved,
      adapter,
      cache,
      runP2: pc === 2,
    });
    results.push(result);
    console.log(`  P1 pooled:  TP=${result.p1Pooled.tp} FP=${result.p1Pooled.fp} precision=${r3(result.p1Pooled.precision)} falseAbst=${result.p1Pooled.falseAbst} ${result.p1Pooled.isUnderpowered ? "[UNDERPOWERED]" : ""}`);
    console.log(`  P1 scalar:  TP=${result.p1Scalar.tp} FP=${result.p1Scalar.fp} precision=${r3(result.p1Scalar.precision)} falseAbst=${result.p1Scalar.falseAbst} ${result.p1Scalar.isUnderpowered ? "[UNDERPOWERED]" : ""}`);
    if (result.p2KuUpdateCorrect !== null) {
      console.log(`  P2: updateCorrect=${result.p2KuUpdateCorrect} recall@3=${result.p2Recall3} recall@10=${result.p2Recall10}`);
    }
  }

  // Print sweep table
  printSweepTable(results);

  // P2 gate checks (--expect-* abort convention, THREE flags, at r3 precision)
  const p2Result = results.find((r) => r.pc === 2);
  if (p2Result) {
    let p2Fail = false;
    if (expectUpdateCorrect !== undefined && p2Result.p2KuUpdateCorrect !== null) {
      if (r3(p2Result.p2KuUpdateCorrect) !== r3(expectUpdateCorrect)) {
        console.error(
          `P2 GATE FAIL: KU updateCorrect ${p2Result.p2KuUpdateCorrect} !== expected ${r3(expectUpdateCorrect)}`
        );
        p2Fail = true;
      }
    }
    if (expectRecall3 !== undefined && p2Result.p2Recall3 !== null) {
      if (r3(p2Result.p2Recall3) !== r3(expectRecall3)) {
        console.error(
          `P2 GATE FAIL: recall@3 ${p2Result.p2Recall3} !== expected ${r3(expectRecall3)}`
        );
        p2Fail = true;
      }
    }
    if (expectRecall10 !== undefined && p2Result.p2Recall10 !== null) {
      if (r3(p2Result.p2Recall10) !== r3(expectRecall10)) {
        console.error(
          `P2 GATE FAIL: recall@10 ${p2Result.p2Recall10} !== expected ${r3(expectRecall10)}`
        );
        p2Fail = true;
      }
    }
    if (p2Fail) return 1;
  }

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
