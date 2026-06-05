// Smoke test: ONE real extraction call through the production request shape and
// the production parser. Run this (≈1 cent) BEFORE any bulk extraction run.
//   npx tsx bench/longmemeval/manual/smoke-one-call.ts
// Prints an explicit VERDICT line; do not launch the bulk run unless it says OK.
import { readFileSync } from "node:fs";
import { normalizeQuestion } from "../types.js";
import { buildPrompt, parseLlmClaims, EXTRACTION_MODEL } from "../../convert/longmemeval.js";

const dataset = new URL("../../datasets/longmemeval/longmemeval_oracle_target.json", import.meta.url);
const raw = JSON.parse(readFileSync(dataset, "utf8")) as unknown[];
const q = normalizeQuestion(raw[0]);
const session = q.sessions[0];
const prompt = buildPrompt(session, session.sessionId);

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

// Mirror of the CLI's realLlm request body (keep in sync with bench/convert/longmemeval.ts)
const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "x-api-key": apiKey,
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
console.log("HTTP status:", response.status, response.statusText);
const data = (await response.json()) as Record<string, unknown>;
if (!response.ok) {
  console.log("error body:", JSON.stringify(data).slice(0, 400));
  process.exit(1);
}
const content = data.content as Array<{ type: string; text?: string }>;
const text = content.find((b) => b.type === "text")?.text ?? "";
console.log("response text (first 400 chars):");
console.log(text.slice(0, 400));
const claims = parseLlmClaims(text);
if (claims === null) {
  console.log("VERDICT: parseLlmClaims FAILED — do NOT launch the bulk run");
  process.exit(1);
}
console.log(`VERDICT: OK — ${claims.length} claims parsed. Safe to launch bulk run.`);
