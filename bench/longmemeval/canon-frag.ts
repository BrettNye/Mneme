/**
 * BENCH ARM (scaffold) — canon-priming: fragmentation → recall on LongMemEval.
 *
 * The decision-gating benchmark for the ctx→Mneme sweep: does priming the extractor
 * with a relevance-BOUNDED view of already-known entities (boundedCanon) reduce entity
 * FRAGMENTATION without hurting RECALL@K? The canon-priming ranker is only worth
 * shipping if it moves this number.
 *
 * Why extraction, not ingestion: the LME bench ingests PRE-EXTRACTED claims
 * (ingest.ts → writeMany), and extraction (convert/longmemeval.ts) runs per-session
 * with NO canon-priming — which is exactly why fragmentation happens. So the arm
 * re-runs EXTRACTION two ways and compares:
 *   - baseline : each session extracted independently (today's behavior).
 *   - bounded  : sessions extracted in order, each primed with boundedCanon() over the
 *                entities extracted so far (reuse-when-same, mint-when-new).
 *
 * Modes:
 *   --smoke  (default, OFFLINE, no LLM): ingest the fixture's pre-extracted claims and
 *            print the fragmentation report + the recall@K command. Proves the metric +
 *            harness plumbing. Canon has no effect offline (claims already extracted).
 *   --live   (COST — one extraction call PER SESSION PER ARM): runs both extraction arms
 *            over the dataset slice, measures fragmentation, and prints the per-arm
 *            claims files to score with run.ts. Gated behind a smoke-one-call check.
 *
 * Recall@K is obtained by pointing the EXISTING runner at each arm's claims:
 *   npx tsx bench/longmemeval/run.ts --file <dataset> --claims <arm>.claims.jsonl --k 1,3,10 --rank hybrid
 */
import { readFileSync } from "node:fs";
import { openSession } from "../../src/surface/index.js";
import type { Session, ReadDeps } from "../../src/surface/index.js";
import { fragmentation } from "./fragmentation.js";
import { ingestQuestion, claimsFor } from "./ingest.js";
import { LmeQuestion } from "./types.js";
import type { ClaimRecordT } from "./types.js";

const OFFLINE_DEPS: ReadDeps = { embeddings: { rankFn: "jaccard" } };

// ── boundedCanon — the finished ranker (see scripts/canon-bounded-final.ts). ──
// Value-aware (rank each candidate entity by its best-matching claim VALUE), jaccard-led
// with a normalized-cosine paraphrase backfill. Kept here as the plug-in seam; graduates
// to src/ when the sweep ships. In --live it is fed the accumulating corpus's entities+values.
export interface CanonEntity { name: string; values: string[] }
export function boundedCanon(
  batchText: string,
  subjects: CanonEntity[],
  keys: CanonEntity[],
  score: (value: string, query: string) => number,
  opts: { kSubjects?: number; kKeys?: number } = {},
): { subjects: string[]; keys: string[] } {
  const rank = (ents: CanonEntity[], k: number) =>
    ents
      .map((e) => ({ name: e.name, s: e.values.length ? Math.max(...e.values.map((v) => score(v, batchText))) : 0 }))
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .map((r) => r.name);
  return { subjects: rank(subjects, opts.kSubjects ?? 8), keys: rank(keys, opts.kKeys ?? 10) };
}

// ── offline smoke: prove metric + plumbing on the fixture ─────────────────────
async function runSmoke(): Promise<void> {
  const base = new URL(".", import.meta.url);
  const dataset = JSON.parse(readFileSync(new URL("fixtures/dataset.json", base), "utf8")) as unknown[];
  const claimsRaw = readFileSync(new URL("fixtures/claims.jsonl", base), "utf8")
    .split("\n").filter(Boolean).slice(1) // line 0 is the lme-extraction-header
    .map((l) => JSON.parse(l) as ClaimRecordT);
  const questions = dataset.map((d) => LmeQuestion.parse(d)); // fixture is already normalized

  console.log(`[smoke/offline] fixture: ${questions.length} question(s), ${claimsRaw.length} pre-extracted claims`);
  const session = openSession({ dbPath: ":memory:", writer: "canon-frag-smoke" });
  for (const q of questions) {
    const claims = claimsFor(q, claimsRaw); // haystack claims for this question
    if (claims.length === 0) continue;
    ingestQuestion(session, q, claims);
    const rep = await fragmentation(session, `lme-${q.question_id}`, OFFLINE_DEPS, { threshold: 0.6 });
    console.log(`  ${q.question_id}: ${rep.distinctSubjects} subjects, ${rep.nearDupPairs} near-dup pairs (rate ${rep.fragmentationRate.toFixed(3)})`);
    for (const w of rep.worst) console.log(`      ~ ${w.a}  ≈  ${w.b}   ${w.score.toFixed(3)}`);
  }
  session.close();

  console.log("\n[smoke] metric + ingest plumbing OK. Canon has NO effect offline (claims pre-extracted).");
  console.log("To measure the real fragmentation→recall delta:");
  console.log("  1. run --live to produce baseline.claims.jsonl and bounded.claims.jsonl (COST: 1 extraction/session/arm);");
  console.log("  2. score each: npx tsx bench/longmemeval/run.ts --file <dataset> --claims <arm>.claims.jsonl --k 1,3,10 --rank hybrid;");
  console.log("  3. compare fragmentationRate (this arm) AND recall@K (run.ts) between baseline and bounded.");
}

// ── live: the two extraction arms (COST-GATED; not run by --smoke) ────────────
async function runLive(): Promise<void> {
  console.error("--live is the COST path (one LLM extraction call per session per arm).");
  console.error("Not implemented in this scaffold: wire in the extraction request from");
  console.error("bench/convert/longmemeval.ts buildPrompt (baseline) and a canon-primed variant");
  console.error("(prepend boundedCanon() over the accumulating corpus's entities+values), then");
  console.error("emit baseline.claims.jsonl / bounded.claims.jsonl and reuse run.ts for recall@K.");
  console.error("Guard it behind bench/longmemeval/manual/smoke-one-call.ts before any bulk run.");
  process.exitCode = 2;
}

if (process.argv.includes("--live")) await runLive();
else await runSmoke();
