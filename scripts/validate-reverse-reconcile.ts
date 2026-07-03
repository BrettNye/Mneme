/**
 * Validate over-fold (subject-over-merge) detection through the public surface + audit —
 * deterministic, offline, no LLM. Companion to scripts/validate-belief-change.ts.
 * `npx tsx scripts/validate-reverse-reconcile.ts`
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession, reverseReconcile } from "../src/surface/index.js";
import { audit } from "../src/surface/audit.js";

const deps = { embeddings: { rankFn: "jaccard" as const } };
const tmpDb = () => join(mkdtempSync(join(tmpdir(), "mneme-vrr-")), "s.db");
const results: { effect: string; ok: boolean; detail: string }[] = [];
const check = (effect: string, ok: boolean, detail: string) => {
  results.push({ effect, ok, detail });
  console.log(`${ok ? "PASS" : "GAP "}  ${effect}\n        ${detail}`);
};

// Seed an over-merged subject (two token-disjoint value clusters) + a cohesive control.
function seed() {
  const s = openSession({ dbPath: tmpDb(), writer: "vrr" });
  s.createCorpus({ id: "c" });
  const w = (subject: string, value: string, from: number) =>
    s.write("c", { subject, key: "capability", value, valid: { from, to: Infinity }, source: "llm", confidence: 0.8 });
  w("project:x", "payroll export csv adp", 1); w("project:x", "payroll timesheet approval", 2);
  w("project:x", "geofencing biometric clock", 3); w("project:x", "geofencing perimeter alerts", 4);
  w("project:y", "scheduling shift calendar", 5); w("project:y", "scheduling shift roster", 6);
  return s;
}

// Effect 1 — reverseReconcile flags the over-merge, not the cohesive control; writes nothing; no "high".
{
  const s = seed();
  const before = s.mneme.read("c", { corpusId: "c" }).length;
  const r = await reverseReconcile(s, { corpus: "c" }, deps);
  const after = s.mneme.read("c", { corpusId: "c" }).length;
  const flagged = r.proposals.some((p) => p.subject === "project:x");
  const controlClean = !r.proposals.some((p) => p.subject === "project:y");
  const noHigh = r.proposals.every((p) => p.confidence === "low" || p.confidence === "medium");
  check("reverseReconcile flags over-merge (not control), no writes, no high-confidence",
    flagged && controlClean && before === after && noHigh,
    `flagged x=${flagged}, control clean=${controlClean}, writes=${after - before}, proposals=${r.proposals.length}`);
  s.close();
}

// Effect 2 — audit surfaces the subject-over-merge proposal.
{
  const s = seed();
  const a = await audit(s, { corpus: "c" }, deps);
  const has = a.proposals.some((p) => p.kind === "subject-over-merge");
  check("audit surfaces subject-over-merge (propose-only)", has,
    `subject-over-merge present=${has}, total proposals=${a.proposals.length}`);
  s.close();
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${"=".repeat(60)}\n${passed}/${results.length} reverse-reconcile effects verified.`);
const gaps = results.filter((r) => !r.ok);
if (gaps.length) { console.log("\nGAPS:"); for (const g of gaps) console.log(`  - ${g.effect}\n      ${g.detail}`); }
process.exit(0);
