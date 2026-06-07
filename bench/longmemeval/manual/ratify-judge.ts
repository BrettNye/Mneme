/**
 * LLM-judge ratification of key-matching census candidates (ratified-oracle arm).
 * Spec: 2026-06-06-key-matching-oracle-experiment-design.md (ratified extension).
 *
 *   npx tsx bench/longmemeval/manual/ratify-judge.ts \
 *     --file <oracle_target.json> --claims <oracle-claims.jsonl> \
 *     --out <judgments.jsonl> [--suggest 0.92] [--limit 5]
 *
 * Mirrors the PRODUCTION ratification loop: candidates are exactly what
 * key_census surfaces (same SimilarityFn seam, suggest threshold from the
 * sweep calibration); the judge plays the agent-ratifier (the design's
 * long-run production ratifier IS an agent); judgments are an append-only
 * resume-safe artifact so the downstream eval replays deterministically.
 * Smoke-first discipline: run with --limit 5 and inspect before any bulk run.
 */
import { parseArgs } from "node:util";
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import {
  normalizeQuestion,
  categoryOf,
  type LmeQuestionT,
  ClaimRecord,
  CacheHeader,
  type ClaimRecordT,
} from "../types.js";
import { claimsFor } from "../ingest.js";
import { simJaccard } from "../../../src/algebra/similarity.js";
import { EmbeddingCache, cosineOver, hybridMax } from "../../../src/index.js";
import { warmEmbeddings } from "../../../src/algebra/embedding.js";
import { createLocalEmbeddingAdapter } from "../embeddings-local.js";

const TARGET_CATEGORIES = new Set(["knowledge-update", "temporal-reasoning", "abstention"]);
export const JUDGE_MODEL = "claude-sonnet-4-6";
export const JUDGE_PROMPT_VERSION = "ratify-v1";

export interface Candidate {
  a: string; // key A (lexicographically smaller)
  b: string; // key B
  score: number; // max hybrid score observed across questions
  subjects: string[]; // sample subjects where the pair co-occurs (<= 3)
  aValues: string[]; // sample values for key A (<= 3)
  bValues: string[]; // sample values for key B (<= 3)
  occurrences: number; // questions where both keys appear
}

export interface Judgment {
  a: string;
  b: string;
  same: boolean;
  reason: string;
  score: number;
}

/**
 * Global unique candidate pairs at score >= suggestTheta with judge context.
 * Pure given the per-question key/value data and a scorer. Deterministic:
 * keys and pairs iterated sorted.
 */
export function uniqueCandidates(
  perQuestion: Array<{ keys: Map<string, { subject: string; values: string[] }> }>,
  scoreOne: (a: string, b: string) => number,
  suggestTheta: number,
): Candidate[] {
  const byPair = new Map<string, Candidate>();
  for (const q of perQuestion) {
    const keys = [...q.keys.keys()].sort();
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const score = scoreOne(keys[i], keys[j]);
        if (score < suggestTheta) continue;
        const pairKey = `${keys[i]}${keys[j]}`;
        const ka = q.keys.get(keys[i])!;
        const kb = q.keys.get(keys[j])!;
        const existing = byPair.get(pairKey);
        if (existing) {
          existing.occurrences++;
          existing.score = Math.max(existing.score, score);
          if (existing.subjects.length < 3 && !existing.subjects.includes(ka.subject)) existing.subjects.push(ka.subject);
          for (const v of ka.values) if (existing.aValues.length < 3 && !existing.aValues.includes(v)) existing.aValues.push(v);
          for (const v of kb.values) if (existing.bValues.length < 3 && !existing.bValues.includes(v)) existing.bValues.push(v);
        } else {
          byPair.set(pairKey, {
            a: keys[i],
            b: keys[j],
            score,
            subjects: [ka.subject],
            aValues: ka.values.slice(0, 3),
            bValues: kb.values.slice(0, 3),
            occurrences: 1,
          });
        }
      }
    }
  }
  return [...byPair.values()].sort((x, y) => y.score - x.score || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
}

export function buildJudgePrompt(c: Candidate): string {
  return [
    "You are ratifying key aliases for a long-term memory system. Two attribute keys were",
    "extracted from the same user's conversation history. Decide whether they denote the",
    "SAME attribute slot — i.e. a newer value written under one key should supersede an",
    "older value written under the other. Keys that are related but track genuinely",
    "different things (e.g. 'car service date' vs 'car purchase date') are NOT the same.",
    "",
    `Subject(s): ${c.subjects.join(", ")}`,
    `Key A: "${c.a}" — example values: ${c.aValues.map((v) => JSON.stringify(v)).join(", ") || "(none)"}`,
    `Key B: "${c.b}" — example values: ${c.bValues.map((v) => JSON.stringify(v)).join(", ") || "(none)"}`,
    "",
    'Respond with JSON: { "same": boolean, "reason": "<one short sentence>" }',
  ].join("\n");
}

export function parseJudgment(text: string): { same: boolean; reason: string } | null {
  try {
    const obj = JSON.parse(text) as { same?: unknown; reason?: unknown };
    if (typeof obj.same !== "boolean") return null;
    return { same: obj.same, reason: typeof obj.reason === "string" ? obj.reason : "" };
  } catch {
    return null;
  }
}

const pairId = (a: string, b: string): string => `${a}${b}`;

async function judgeOne(apiKey: string, c: Candidate): Promise<{ same: boolean; reason: string }> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      max_tokens: 300,
      messages: [{ role: "user", content: buildJudgePrompt(c) }],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { same: { type: "boolean" }, reason: { type: "string" } },
            required: ["same", "reason"],
            additionalProperties: false,
          },
        },
      },
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${body.slice(0, 200)}`);
  }
  const data = (await response.json()) as { content: Array<{ type: string; text?: string }> };
  const text = data.content.find((b) => b.type === "text")?.text ?? "";
  const parsed = parseJudgment(text);
  if (!parsed) throw new Error(`parseJudgment failed on: ${text.slice(0, 200)}`);
  return parsed;
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      file: { type: "string" },
      claims: { type: "string" },
      out: { type: "string" },
      suggest: { type: "string", default: "0.92" },
      limit: { type: "string" },
    },
  });
  if (!values.file || !values.claims || !values.out) {
    console.error("--file, --claims, --out are required");
    return 1;
  }
  const suggestTheta = parseFloat(String(values.suggest));
  const limit = values.limit !== undefined ? parseInt(String(values.limit), 10) : Infinity;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set");
    return 1;
  }

  // --- load dataset + claims ---
  const datasetRaw = JSON.parse(readFileSync(values.file, "utf-8")) as unknown[];
  const questions: LmeQuestionT[] = datasetRaw
    .map(normalizeQuestion)
    .filter((q) => TARGET_CATEGORIES.has(categoryOf(q)));
  const lines = readFileSync(values.claims, "utf-8").split("\n").filter((l) => l.trim().length > 0);
  CacheHeader.parse(JSON.parse(lines[0]));
  const allClaims: ClaimRecordT[] = lines.slice(1).map((l) => ClaimRecord.parse(JSON.parse(l)));

  // --- per-question key context ---
  const perQuestion = questions.map((q) => {
    const keys = new Map<string, { subject: string; values: string[] }>();
    for (const r of claimsFor(q, allClaims, { oracle: true })) {
      const entry = keys.get(r.key);
      if (entry) {
        if (entry.values.length < 3 && !entry.values.includes(String(r.value))) entry.values.push(String(r.value));
      } else {
        keys.set(r.key, { subject: r.subject, values: [String(r.value)] });
      }
    }
    return { keys };
  });

  // --- hybrid scorer (same seam as census/sweep) ---
  const adapter = await createLocalEmbeddingAdapter();
  const cache = new EmbeddingCache();
  const allKeys = [...new Set(perQuestion.flatMap((s) => [...s.keys.keys()]))].sort();
  await warmEmbeddings(adapter, cache, allKeys);
  const hybrid = hybridMax(simJaccard, cosineOver(adapter, cache));

  const candidates = uniqueCandidates(perQuestion, (a, b) => hybrid.scoreOne(a, b), suggestTheta);
  console.log(`candidates at suggest>=${suggestTheta}: ${candidates.length} unique pairs`);

  // --- resume cache ---
  const judged = new Set<string>();
  if (existsSync(values.out)) {
    for (const line of readFileSync(values.out, "utf-8").split("\n").filter((l) => l.trim().length > 0)) {
      const obj = JSON.parse(line) as { kind?: string; a?: string; b?: string };
      if (obj.kind === undefined && obj.a && obj.b) judged.add(pairId(obj.a, obj.b));
    }
  } else {
    appendFileSync(
      values.out,
      JSON.stringify({ kind: "key-ratify-header", model: JUDGE_MODEL, promptVersion: JUDGE_PROMPT_VERSION, suggestTheta }) + "\n",
      "utf8",
    );
  }
  const pending = candidates.filter((c) => !judged.has(pairId(c.a, c.b)));
  console.log(`already judged: ${judged.size}; pending: ${pending.length}; this run: ${Math.min(limit, pending.length)}`);

  let done = 0;
  let approved = 0;
  for (const c of pending) {
    if (done >= limit) break;
    const verdict = await judgeOne(apiKey, c);
    const record: Judgment = { a: c.a, b: c.b, same: verdict.same, reason: verdict.reason, score: c.score };
    appendFileSync(values.out, JSON.stringify(record) + "\n", "utf8");
    if (verdict.same) approved++;
    done++;
    if (done <= 10 || done % 50 === 0) {
      console.log(`[${done}] ${verdict.same ? "SAME" : "DIFF"} "${c.a}" ~ "${c.b}" (${c.score.toFixed(3)}) — ${verdict.reason}`);
    }
  }
  console.log(`judged this run: ${done}; approved: ${approved}; remaining: ${pending.length - done}`);
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
