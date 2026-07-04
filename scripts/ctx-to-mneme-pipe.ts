/**
 * PROTOTYPE — ctx (episodic) → Mneme (semantic) ingest pipe.
 *
 * Demonstrates the "consume, don't compete" hand-off: ctx has auto-captured
 * agent-session history (episodic, unresolved); Mneme's ingest() distills it into
 * typed, canonicalized, RESOLVED claims — with no human `remember` step.
 *
 *   1. SOURCE  — pull a slice of Mneme-history message events straight from ctx's
 *                SQLite via `ctx sql --json` (the episodic layer).
 *   2. EXTRACT — ingest()'s `extract` callback runs ONE LLM call (structured
 *                output), injecting ctx's LIVE canonical entities so it reuses
 *                them (recall-before-write), then parseLlmClaims → CandidateClaim[].
 *   3. INGEST  — ingest() canonicalizes subjects/keys + supersedes on (subject,key).
 *   4. RECALL  — recall() RESOLVES to the current answer (canonicalReadStages),
 *                contrasted with ctx's raw lexical search for the same question.
 *
 * Smoke-first (the $20 lesson): `npx tsx scripts/ctx-to-mneme-pipe.ts --smoke`
 * does ONE real call + a parse check and exits. Only launch the full run if it
 * prints VERDICT: OK. Full run spends a few cents (one extraction call).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "../src/surface/index.js";
import { ingest } from "../src/surface/ingest.js";
import { recall } from "../src/surface/recall.js";
import { initEmbeddings } from "../src/surface/embeddings.js";
import type { CandidateClaim, IngestContext } from "../src/surface/ingest.js";
import { parseLlmClaims, EXTRACTION_MODEL } from "../bench/convert/longmemeval.js";

const QUESTION = "what is Mneme's market positioning and should it be a standalone product?";
const CTX_BIN = "C:/Users/brett/.cargo/bin/ctx.exe";

function apiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
  const m = env.match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.+)$/m);
  if (!m) throw new Error("ANTHROPIC_API_KEY not in shell env or .env");
  return m[1].trim().replace(/^["']|["']$/g, "");
}

// ── 1. SOURCE: pull a slice of Mneme-positioning message events from ctx ──────
interface CtxEvent { ts: number; role: string; text: string }
function pullCtxSlice(limit: number): CtxEvent[] {
  // role='user' — user-message payloads reliably carry text at $.body.content_preview.text
  // (assistant payloads store it elsewhere / get truncation-wrapped); user directives +
  // questions about positioning/competitors are the decision-bearing slice we want.
  const sql =
    "SELECT occurred_at_ms, role, json_extract(payload_json,'$.body.content_preview.text') AS text " +
    "FROM events WHERE event_type='message' AND role='user' " +
    "AND lower(payload_json) LIKE '%mneme%' " +
    "AND (lower(payload_json) LIKE '%positioning%' OR lower(payload_json) LIKE '%standalone%' " +
    "  OR lower(payload_json) LIKE '%wedge%' OR lower(payload_json) LIKE '%competitor%' " +
    "  OR lower(payload_json) LIKE '%mem0%' OR lower(payload_json) LIKE '%non-destructive%') " +
    // DESC: most-recent positioning discussions (competitor/standalone analyses) are richest.
    `ORDER BY occurred_at_ms DESC LIMIT ${limit}`;
  const out = execFileSync(
    CTX_BIN,
    ["sql", "--json", "--max-value-bytes", "6000", "--max-rows", String(limit), sql],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(out) as { rows: [number, string, string | null][] };
  return parsed.rows
    .map(([ts, role, text]) => ({ ts, role, text: text ?? "" }))
    .filter((e) => e.text.trim().length > 0);
}

// ── 2. EXTRACT: one structured-output LLM call → CandidateClaim[] ──────────────
async function llmExtract(sliceText: string, canonPrompt: string): Promise<CandidateClaim[]> {
  const prompt =
    `You are extracting durable, factual CLAIMS about the MNEME project from coding-agent ` +
    `session history, for a long-term memory system. Return only claims STILL TRUE AND USEFUL ` +
    `three months from now (decisions, positioning, verdicts, competitor assessments, strategy) — ` +
    `NOT transient state or logistics.\n` +
    `- subject: a STABLE typed entity "type:name" kebab-case (e.g. project:mneme, competitor:mem0).\n` +
    `- key: a kebab-case predicate, most-general first (e.g. positioning, market-verdict, decision, competitor.assessment).\n` +
    `- value: the claim, concise and self-contained.\n` +
    (canonPrompt
      ? `\nREUSE these existing canonical entities verbatim when the same thing (mint new only if genuinely new):\n${canonPrompt}\n`
      : "") +
    `\nSession history slice:\n${sliceText}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey(),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: EXTRACTION_MODEL,
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              claims: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    subject: { type: "string" },
                    key: { type: "string" },
                    value: { type: "string" },
                  },
                  required: ["subject", "key", "value"],
                  additionalProperties: false,
                },
              },
            },
            required: ["claims"],
            additionalProperties: false,
          },
        },
      },
    }),
  });
  const data = (await response.json()) as {
    content?: { type: string; text?: string }[];
    usage?: { input_tokens: number; output_tokens: number };
  };
  if (!(response as Response).ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(data).slice(0, 400)}`);
  const text = data.content?.find((b) => b.type === "text")?.text ?? "";
  const parsed = parseLlmClaims(text);
  if (parsed === null) throw new Error("parseLlmClaims failed on the LLM response");
  if (data.usage) console.error(`   (extraction tokens in/out: ${data.usage.input_tokens}/${data.usage.output_tokens})`);
  return parsed.map((c) => ({ subject: c.subject, key: c.key, value: c.value, confidence: 0.7 }));
}

// ── main ──────────────────────────────────────────────────────────────────────
const smoke = process.argv.includes("--smoke");

const slice = pullCtxSlice(smoke ? 3 : 12);
console.error(`[1] ctx SOURCE: pulled ${slice.length} message events from ctx's SQLite about Mneme positioning`);
const sliceText = slice.map((e) => `[${e.role}] ${e.text}`).join("\n\n---\n\n");

if (smoke) {
  console.error("[smoke] one extraction call on the first few events…");
  const claims = await llmExtract(sliceText, "");
  console.log(`\nVERDICT: OK — ${claims.length} claims parsed. Safe to launch the full run.`);
  for (const c of claims) console.log(`  - ${c.subject} | ${c.key} = ${c.value}`);
  process.exit(0);
}

const dbPath = join(mkdtempSync(join(tmpdir(), "ctx-mneme-pipe-")), "store.db");
const session = openSession({ dbPath, writer: "ctx-pipe" });
session.createCorpus({ id: "mneme-history", scopeFields: { project: "string", context: "string" } });
const deps = { embeddings: await initEmbeddings() };

console.error("[2+3] EXTRACT + INGEST: ingest() runs the LLM extractor with canonicalization…");
const report = await ingest(
  session,
  { corpus: "mneme-history", extract: (ctx: IngestContext) => llmExtract(sliceText, ctx.canonPrompt) },
  deps,
);
console.log("\n=== ingest report ===");
console.log(JSON.stringify(report.counts, null, 2));
console.log("\n=== claims distilled from ctx episodic history ===");
for (const c of report.claims) {
  const sup = c.write?.supersession ? "  ⟵ superseded prior" : "";
  console.log(`  - ${c.subject.final} | ${c.key.final} = ${c.candidate.value}${sup}`);
}

console.error("\n[4] RECALL: Mneme resolves the question (canonicalReadStages)…");
const r = await recall(session, { corpus: "mneme-history", about: QUESTION, limit: 5 }, deps);
console.log(`\n=== Mneme recall — "${QUESTION}" ===`);
console.log(`rankFn=${r.rankFn}  abstained=${r.abstained}  matches=${r.matches.length}`);
console.log(r.content || "(empty)");

console.log(`\n=== ctx search (lexical) — same question, for contrast ===`);
try {
  const ctxOut = execFileSync(CTX_BIN, ["search", QUESTION, "--limit", "3"], { encoding: "utf8" });
  console.log(ctxOut.trim() || "(no results)");
} catch {
  console.log("(ctx search returned nonzero / no results)");
}
session.close();
