// Smoke test: ONE real answer-correctness judge call through the production
// request shape + parser. Run this (≈1 cent) BEFORE any bulk judge run.
//   npx tsx bench/longmemeval/manual/smoke-answer-judge.ts
// Prints an explicit VERDICT line; do not launch the bulk run unless it says OK.
import { judgeAnswerInContext } from "./answer-correctness-judge.js";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

const item = {
  question: "Where does Rachel live now?",
  gold: "the suburbs",
  context: [
    "rachel.residence = the suburbs (as of 2023-06-01T00:00:00.000Z)",
    "rachel.residence = downtown (as of 2023-01-01T00:00:00.000Z)",
  ],
};
try {
  const v = await judgeAnswerInContext(apiKey, item);
  console.log("verdict:", JSON.stringify(v));
  console.log(`VERDICT: OK — judge returned correct=${v.correct}. Safe to launch bulk run.`);
} catch (err) {
  console.log("VERDICT: FAILED —", (err as Error).message, "— do NOT launch the bulk run");
  process.exit(1);
}
