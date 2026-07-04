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
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "../../src/surface/index.js";
import type { Session, ReadDeps } from "../../src/surface/index.js";
import { simJaccard } from "../../src/algebra/similarity.js";
import { fragmentation } from "./fragmentation.js";
import { ingestQuestion, claimsFor } from "./ingest.js";
import { LmeQuestion } from "./types.js";
import type { ClaimRecordT, LmeQuestionT } from "./types.js";
import {
  buildPrompt, parseLlmClaims, extractClaims, EXTRACTION_MODEL, PROMPT_VERSION,
  type ExtractCache,
} from "../convert/longmemeval.js";

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

// ── live: the two extraction arms (COST-GATED) ────────────────────────────────
function apiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const env = readFileSync(new URL("../../.env", import.meta.url), "utf8");
  const m = env.match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.+)$/m);
  if (!m) throw new Error("ANTHROPIC_API_KEY not in shell env or .env");
  return m[1].trim().replace(/^["']|["']$/g, "");
}
async function callAnthropic(prompt: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey(), "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: EXTRACTION_MODEL, max_tokens: 4096, messages: [{ role: "user", content: prompt }] }),
  });
  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data.content?.find((b) => b.type === "text")?.text ?? "";
}
function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
function loadQuestions(): LmeQuestionT[] {
  const file = argValue("--file");
  const url = file ? new URL(`file://${file.replace(/\\/g, "/")}`) : new URL("fixtures/dataset.json", new URL(".", import.meta.url));
  const raw = JSON.parse(readFileSync(url, "utf8")) as unknown[];
  const limit = argValue("--limit") ? parseInt(argValue("--limit")!, 10) : 3;
  return raw.slice(0, limit).map((d) => LmeQuestion.parse(d)); // expects normalized shape
}

/** Run one extraction arm. `primed` = inject boundedCanon over entities extracted so far. */
async function runArm(name: string, primed: boolean, questions: LmeQuestionT[]): Promise<ClaimRecordT[]> {
  const recs: ClaimRecordT[] = [];
  const subjVals = new Map<string, string[]>();
  const keyVals = new Map<string, string[]>();
  const add = (m: Map<string, string[]>, k: string, v: string) => m.set(k, [...(m.get(k) ?? []), v]);
  const cache: ExtractCache = {
    has: () => false,
    emit: (rec) => { recs.push(rec); add(subjVals, rec.subject, rec.value); add(keyVals, rec.key, rec.value); },
    markSkipped: () => {},
  };
  // canon-priming rides the llm wrapper: extractClaims processes sessions in order and
  // emits after each, so by session N the maps reflect sessions 1..N-1 (recall-before-write).
  const llm = async (prompt: string): Promise<string> => {
    if (!primed) return callAnthropic(prompt);
    const subjects = [...subjVals].map(([n, values]) => ({ name: n, values }));
    const keys = [...keyVals].map(([n, values]) => ({ name: n, values }));
    const { subjects: kS, keys: kK } = boundedCanon(prompt, subjects, keys, (v, q) => simJaccard.scoreOne(v, q));
    const block = (kS.length || kK.length)
      ? `## Canonical entities already extracted (reuse a subject/key VERBATIM only for the SAME entity; MINT anything genuinely new):\nSubjects: ${kS.join(", ")}\nKeys: ${kK.join(", ")}\n\n`
      : "";
    return callAnthropic(block + prompt);
  };
  await extractClaims(questions, cache, { llm });
  console.error(`  arm ${name}: ${recs.length} claims from ${new Set(recs.flatMap((r) => r.tags.filter((t) => t.startsWith("session:")))).size} sessions`);
  return recs;
}

function writeClaims(dir: string, arm: string, recs: ClaimRecordT[]): string {
  const path = join(dir, `${arm}.claims.jsonl`);
  const header = JSON.stringify({ kind: "lme-extraction-header", model: EXTRACTION_MODEL, promptVersion: PROMPT_VERSION });
  writeFileSync(path, [header, ...recs.map((r) => JSON.stringify(r))].join("\n") + "\n");
  return path;
}

async function measureArm(arm: string, questions: LmeQuestionT[], recs: ClaimRecordT[]): Promise<{ subjects: number; nearDup: number }> {
  const session = openSession({ dbPath: ":memory:", writer: `canon-frag-${arm}` });
  let subjects = 0, nearDup = 0;
  for (const q of questions) {
    const claims = claimsFor(q, recs);
    if (claims.length === 0) continue;
    ingestQuestion(session, q, claims);
    const rep = await fragmentation(session, `lme-${q.question_id}`, OFFLINE_DEPS, { threshold: 0.6 });
    subjects += rep.distinctSubjects; nearDup += rep.nearDupPairs;
  }
  session.close();
  return { subjects, nearDup };
}

async function runLive(): Promise<void> {
  const questions = loadQuestions();
  const sessionCount = new Set(questions.flatMap((q) => q.sessions.map((s) => s.sessionId))).size;
  const first = questions[0].sessions[0];

  // smoke gate — one real call before any bulk spend (the $20 lesson).
  console.error(`[live/smoke] one extraction call on session ${first.sessionId}…`);
  const claims = parseLlmClaims(await callAnthropic(buildPrompt(first, first.sessionId)));
  if (claims === null) { console.error("VERDICT: parseLlmClaims FAILED — aborting, do NOT run --go"); process.exit(1); }
  console.error(`VERDICT: OK — ${claims.length} claims parsed.`);

  if (!process.argv.includes("--go")) {
    console.log(`\nSmoke passed. Full run = 2 arms × ${sessionCount} unique sessions ≈ ${2 * sessionCount} extraction calls.`);
    console.log(`Re-run with --go to execute:  npx tsx bench/longmemeval/canon-frag.ts --live --go [--file <dataset>] [--limit N]`);
    return;
  }

  console.error(`[live] extracting baseline + bounded over ${questions.length} question(s)…`);
  const baseline = await runArm("baseline", false, questions);
  const bounded = await runArm("bounded", true, questions);
  const dir = mkdtempSync(join(tmpdir(), "canon-frag-"));
  const bPath = writeClaims(dir, "baseline", baseline);
  const cPath = writeClaims(dir, "bounded", bounded);
  const bFrag = await measureArm("baseline", questions, baseline);
  const cFrag = await measureArm("bounded", questions, bounded);

  console.log(`\n=== fragmentation (lower near-dup = better canonicalization) ===`);
  console.log(`  baseline: ${baseline.length} claims, ${bFrag.subjects} distinct subjects, ${bFrag.nearDup} near-dup pairs`);
  console.log(`  bounded:  ${bounded.length} claims, ${cFrag.subjects} distinct subjects, ${cFrag.nearDup} near-dup pairs`);
  console.log(`\n=== recall@K — score each arm with the existing runner ===`);
  const ds = argValue("--file") ?? "bench/longmemeval/fixtures/dataset.json";
  console.log(`  npx tsx bench/longmemeval/run.ts --file ${ds} --claims ${bPath} --k 1,3,10 --rank hybrid`);
  console.log(`  npx tsx bench/longmemeval/run.ts --file ${ds} --claims ${cPath} --k 1,3,10 --rank hybrid`);
}

if (process.argv.includes("--live")) await runLive();
else await runSmoke();
