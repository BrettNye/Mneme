/**
 * Validate that the SHIPPED Clusters A/B/C reproduce the recorded Fireflies-dogfood
 * findings (stoa: rastate/synthesis-fireflies-dogfood-synthesis-ingestion) — through
 * first-class surfaces, deterministically, no LLM. `npx tsx scripts/validate-shipped-dogfood.ts`
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openSession, recall, keyCensus, subjectCensus, reconcile, explainRecall,
} from "../src/surface/index.js";

const deps = { embeddings: { rankFn: "jaccard" as const } };
const tmpDb = () => join(mkdtempSync(join(tmpdir(), "mneme-validate-")), "store.db");
const results: { finding: string; ok: boolean; detail: string }[] = [];
const check = (finding: string, ok: boolean, detail: string) => {
  results.push({ finding, ok, detail });
  console.log(`${ok ? "PASS" : "GAP "}  ${finding}\n        ${detail}`);
};

// 3 genuinely-distinct requirements (few shared tokens → ⊕_dedupe jaccard@0.5 will NOT merge)
const REQS = [
  { v: "weld seams must be photographed before a ticket can be submitted", from: 1 },
  { v: "crew badges scanned at the gate on every entry and exit", from: 2 },
  { v: "moisture readings logged hourly for each liner bay", from: 3 },
];
const seedReqs = (id: string, cardinality: "single" | "multi") => {
  const s = openSession({ dbPath: tmpDb(), writer: "validate" });
  s.createCorpus({ id, keyCardinality: { requirement: cardinality } });
  for (const r of REQS)
    s.write(id, { subject: "client:liner-division", key: "requirement", value: r.v,
      valid: { from: r.from, to: Infinity }, source: "llm", confidence: 0.8 });
  return s;
};

// ── Finding #4: key cardinality is load-bearing (single→1, multi→3) — Cluster C decl. ──
{
  const single = seedReqs("liner-single", "single");
  const multi = seedReqs("liner-multi", "multi");
  const nSingle = (await recall(single, { about: "requirements", corpus: "liner-single",
    subject: "client:liner-division", key: "requirement", limit: 100 }, deps)).matches.length;
  const nMulti = (await recall(multi, { about: "requirements", corpus: "liner-multi",
    subject: "client:liner-division", key: "requirement", limit: 100 }, deps)).matches.length;
  check("#4 cardinality load-bearing (single<multi, declared via CorpusSpec)",
    nSingle === 1 && nMulti === 3, `single served ${nSingle}, multi served ${nMulti} (recorded: 1 vs 3)`);
  single.close(); multi.close();
}

// ── Cluster C safety warning: single-cardinality group with ≥2 distinct values warns ──
{
  const s = seedReqs("liner-warn", "single");
  const r = await recall(s, { about: "requirements", corpus: "liner-warn",
    subject: "client:liner-division", key: "requirement" }, deps);
  const warned = (r.warnings ?? []).some((w) => /single-cardinality.*requirement.*distinct values/.test(w));
  check("C  recall safety warning fires on single-cardinality mass-deprecation",
    warned, warned ? `warned: "${(r.warnings ?? []).find((w) => /single-cardinality/.test(w))}"` : "no warning surfaced");
  s.close();
}

// ── Finding #1: opacity → transparency. explainRecall shows deprecated-by single-cardinality (Cluster A) ──
{
  const s = seedReqs("liner-explain", "single"); // schema single (also default)
  const trace = await explainRecall(s, { about: "requirements", corpus: "liner-explain",
    subject: "client:liner-division", key: "requirement" }, deps);
  const deprecated = trace.claims.filter((c) => c.disposition === "deprecated"
    && (c.reason as { via?: string }).via === "single-cardinality");
  check("#1 explainRecall exposes deprecated-by via:single-cardinality (was opaque)",
    deprecated.length === 2, `${deprecated.length} claims traced as deprecated-by single-cardinality (expected 2 of 3)`);
  s.close();
}

// ── Consistency check (Cluster A invariant vs Cluster C): explain served == recall matches on a
//    SCHEMA-declared-multi corpus. recall honors schema cardinality; does explainRecall? ──
{
  const s = seedReqs("liner-consistency", "multi");
  const served = (await recall(s, { about: "requirements", corpus: "liner-consistency",
    subject: "client:liner-division", key: "requirement", limit: 100 }, deps)).matches.length;
  const trace = await explainRecall(s, { about: "requirements", corpus: "liner-consistency",
    subject: "client:liner-division", key: "requirement", limit: 100 }, deps);
  const explainServed = trace.claims.filter((c) => c.disposition === "served").length;
  check("A×C consistency: explainRecall served == recall matches on schema-declared-multi",
    served === explainServed, `recall served ${served}, explainRecall served ${explainServed}` +
    (served === explainServed ? "" : "  ← explainRecall does NOT resolve schema keyCardinality (follow-up)"));
  s.close();
}

// ── Finding #3: recall-before-write is a first-class primitive (reconcile) — Cluster B ──
{
  const s = openSession({ dbPath: tmpDb(), writer: "validate" });
  s.createCorpus({ id: "canon" });
  // canonical existing subjects (as after meeting 1)
  for (const subj of ["project:crewtracks", "client:liner-division"])
    s.write("canon", { subject: subj, key: "status", value: "active", source: "llm", confidence: 0.8 });
  // meeting-2 independent-extraction candidates: an exact canonical, a variant, a genuinely-new one
  const rec = await reconcile(s, { corpus: "canon",
    subjects: ["project:crewtracks", "project:crewtracks-liner-build", "division:traffic-control"] }, deps);
  const byCand = new Map(rec.subjects.map((m) => [m.candidate, m]));
  const exact = byCand.get("project:crewtracks")!;
  const newDiv = byCand.get("division:traffic-control")!;
  const reuseWorks = exact.disposition === "reuse" && exact.suggestions[0]?.existing === "project:crewtracks";
  const guardWorks = newDiv.disposition === "new"; // over-anchoring guard: NOT folded
  check("#3 reconcile: exact canonical → reuse; genuinely-new → new (over-anchoring guard)",
    reuseWorks && guardWorks,
    `crewtracks → ${exact.disposition} (→${exact.suggestions[0]?.existing}); traffic-control → ${newDiv.disposition}`);
  s.close();
}

// ── Finding #2: subject fragmentation is detectable (subjectCensus) — Cluster B ──
{
  const s = openSession({ dbPath: tmpDb(), writer: "validate" });
  s.createCorpus({ id: "frag" });
  for (const subj of ["project:crewtracks", "project:crewTracks-liner-build"])
    s.write("frag", { subject: subj, key: "status", value: "active", source: "llm", confidence: 0.8 });
  const census = await subjectCensus(s, { corpus: "frag" }, deps);
  const twoSubjects = census.subjects.length >= 2;
  const pairScored = (census.candidates[0]?.score ?? 0) > 0;
  const advisory = !census.content.includes("alias-of");
  check("#2 subjectCensus enumerates fragmented subjects + scores the near-dup pair (advisory)",
    twoSubjects && pairScored && advisory,
    `${census.subjects.length} distinct subjects; top pair score ${(census.candidates[0]?.score ?? 0).toFixed(3)}; advisory=${advisory}`);
  s.close();
}

// ── Finding #5: keyCensus surfaces the cardinality collision (louder default) — Cluster C ──
{
  const s = seedReqs("liner-census", "single");
  const kc = await keyCensus(s, { corpus: "liner-census" }, deps);
  const warned = kc.warnings.some((w) => /single-cardinality.*requirement/.test(w));
  check("#5 keyCensus surfaces single-cardinality mass-deprecation (audit surface)",
    warned, warned ? "keyCensus warned on (client:liner-division, requirement)" : "no warning");
  s.close();
}

// ── Summary ──
const passed = results.filter((r) => r.ok).length;
console.log(`\n${"=".repeat(60)}\n${passed}/${results.length} recorded findings reproduced by shipped Mneme.`);
const gaps = results.filter((r) => !r.ok);
if (gaps.length) {
  console.log("\nGAPS (surfaced by this validation):");
  for (const g of gaps) console.log(`  - ${g.finding}\n      ${g.detail}`);
}
process.exit(0);
