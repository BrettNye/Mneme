// Build a small manual-extraction sample:
//  - 10 knowledge-update questions (oracle evidence + 2 distractor sessions each from _s)
//  - 5 temporal-reasoning + 5 abstention questions (oracle as-is)
// Writes manual_sample.json (LmeQuestion-conformant) + prints sizing stats.
import { readFileSync, writeFileSync } from "node:fs";
import { normalizeQuestion, categoryOf, LmeQuestion, type LmeQuestionT } from "../types.js";

const here = (n: string) => new URL(`../../datasets/longmemeval/${n}`, import.meta.url);
const oracle = (JSON.parse(readFileSync(here("longmemeval_oracle_target.json"), "utf8")) as unknown[]).map(normalizeQuestion);
const full = (JSON.parse(readFileSync(here("longmemeval_s_target.json"), "utf8")) as unknown[]).map(normalizeQuestion);
const fullById = new Map(full.map((q) => [q.question_id, q]));

const ku = oracle.filter((q) => categoryOf(q) === "knowledge-update").slice(0, 10);
const tr = oracle.filter((q) => categoryOf(q) === "temporal-reasoning").slice(0, 5);
const abs = oracle.filter((q) => categoryOf(q) === "abstention").slice(0, 5);

const sample: LmeQuestionT[] = [];
for (const q of ku) {
  const fq = fullById.get(q.question_id);
  const evidenceIds = new Set(q.sessions.map((s) => s.sessionId));
  // two smallest distractor sessions from the full haystack (cheaper to extract)
  const distractors = (fq?.sessions ?? [])
    .filter((s) => !evidenceIds.has(s.sessionId))
    .map((s) => ({ s, chars: s.turns.reduce((n, t) => n + t.content.length, 0) }))
    .sort((a, b) => a.chars - b.chars)
    .slice(0, 2)
    .map((x) => x.s);
  sample.push({ ...q, sessions: [...q.sessions, ...distractors] });
}
sample.push(...tr, ...abs);

// Validate + sizing report
let totalChars = 0;
for (const q of sample) {
  LmeQuestion.parse(q);
  const chars = q.sessions.reduce((n, s) => n + s.turns.reduce((m, t) => m + t.content.length, 0), 0);
  totalChars += chars;
  console.log(
    `${q.question_id} [${categoryOf(q)}] sessions=${q.sessions.length} evidence=${q.answer_session_ids.length} chars=${chars}`,
  );
}
console.log(`TOTAL: ${sample.length} questions, ${sample.reduce((n, q) => n + q.sessions.length, 0)} sessions, ${(totalChars / 1000).toFixed(0)}k chars`);
writeFileSync(here("manual_sample.json"), JSON.stringify(sample, null, 1));
console.log("wrote manual_sample.json");
