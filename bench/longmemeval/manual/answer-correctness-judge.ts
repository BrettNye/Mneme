/**
 * LLM judge: does the served top-k context actually answer the question?
 * Mirrors ratify-judge.ts (raw fetch → Anthropic Messages API, json_schema
 * structured output) and adds a resume-safe cache with header validation +
 * torn-write recovery (NET-NEW vs ratify-judge, modeled on the extraction cache).
 *
 * Spec: docs/superpowers/specs/2026-06-18-real-answer-confirmation-design.md
 */
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import type { Claim } from "../../../src/core/claim.js";
import { canonicalizeValue } from "../../../src/core/value.js";

export const ANSWER_JUDGE_MODEL = "claude-sonnet-4-6";
export const ANSWER_JUDGE_PROMPT_VERSION = "answer-judge-v1";
export const CONTEXT_K = 5;

export interface JudgeItem { question: string; gold: string; context: string[] }
export interface JudgeVerdict { correct: boolean; reason: string }
export type JudgeFn = (item: JudgeItem) => Promise<JudgeVerdict>;

export interface JudgeRecord {
  cell: string;
  questionId: string;
  category: string;
  correct: boolean;
  reason: string;
}

/** "subject.key = value (as of <ISO valid.from>)". Date format is deterministic (no clock read). */
export function renderContextClaim(c: Claim): string {
  const iso = new Date(c.valid.from).toISOString();
  return `${c.subject}.${c.key} = ${canonicalizeValue(c.value)} (as of ${iso})`;
}

export function buildAnswerJudgePrompt(item: JudgeItem): string {
  const ctx = item.context.length > 0 ? item.context.map((l) => `- ${l}`).join("\n") : "(empty)";
  return [
    "You are judging a memory system's retrieval. A question was asked, and the system",
    "served the context below (the top retrieved facts). Decide whether that context",
    "CONTAINS OR SUPPORTS the gold answer to the question. Be strict: facts that are",
    "adjacent or partially relevant but do not actually answer the question are NOT correct.",
    "",
    `Question: ${item.question}`,
    `Gold answer: ${item.gold}`,
    "Served context:",
    ctx,
    "",
    'Respond with JSON: { "correct": boolean, "reason": "<one short sentence>" }',
  ].join("\n");
}

export function parseAnswerVerdict(text: string): JudgeVerdict | null {
  try {
    const obj = JSON.parse(text) as { correct?: unknown; reason?: unknown };
    if (typeof obj.correct !== "boolean") return null;
    return { correct: obj.correct, reason: typeof obj.reason === "string" ? obj.reason : "" };
  } catch {
    return null;
  }
}

export async function judgeAnswerInContext(apiKey: string, item: JudgeItem): Promise<JudgeVerdict> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: ANSWER_JUDGE_MODEL,
      max_tokens: 300,
      messages: [{ role: "user", content: buildAnswerJudgePrompt(item) }],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { correct: { type: "boolean" }, reason: { type: "string" } },
            required: ["correct", "reason"],
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
  const parsed = parseAnswerVerdict(text);
  if (!parsed) throw new Error(`parseAnswerVerdict failed on: ${text.slice(0, 200)}`);
  return parsed;
}

export function judgeCacheKey(cell: string, questionId: string): string {
  return `${cell}|${questionId}`;
}

interface JudgeHeader { model: string; promptVersion: string; contextK: number }

export function appendJudgeHeaderIfNew(path: string, header: JudgeHeader): void {
  if (existsSync(path)) return;
  appendFileSync(path, JSON.stringify({ kind: "answer-judge-header", ...header }) + "\n", "utf8");
}

export function appendJudgeRecord(path: string, rec: JudgeRecord): void {
  appendFileSync(path, JSON.stringify(rec) + "\n", "utf8");
}

/** Validates the header (mismatch → throw) and recovers a torn final line (drops it). */
export function loadJudgeCache(path: string, expect: JudgeHeader): Map<string, JudgeRecord> {
  const cache = new Map<string, JudgeRecord>();
  if (!existsSync(path)) return cache;
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return cache;
  const header = JSON.parse(lines[0]) as { kind?: string } & Partial<JudgeHeader>;
  if (header.kind !== "answer-judge-header" || header.model !== expect.model
    || header.promptVersion !== expect.promptVersion || header.contextK !== expect.contextK) {
    throw new Error(`answer-judge cache header mismatch at ${path}: got ${JSON.stringify(header)}, expected ${JSON.stringify(expect)}`);
  }
  for (const line of lines.slice(1)) {
    let rec: JudgeRecord;
    try { rec = JSON.parse(line) as JudgeRecord; } catch { continue; } // torn final line — drop
    if (rec && typeof rec.correct === "boolean" && rec.cell && rec.questionId) {
      cache.set(judgeCacheKey(rec.cell, rec.questionId), rec);
    }
  }
  return cache;
}
