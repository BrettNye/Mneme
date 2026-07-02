/**
 * Validate the ingest() enforced recall-before-write loop — a third durable offline harness
 * alongside scripts/validate-shipped-dogfood.ts and scripts/validate-belief-change.ts (same
 * temp-DB, jaccard-deps, no-LLM style). Drives `ingest` through the public barrel with a pure
 * `extract` callback to reproduce the predicted effects. `npx tsx scripts/validate-ingest.ts`
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession, ingest } from "../src/surface/index.js";

const deps = { embeddings: { rankFn: "jaccard" as const } };
const tmpDb = () => join(mkdtempSync(join(tmpdir(), "mneme-vingest-")), "store.db");
const results: { effect: string; ok: boolean; detail: string }[] = [];
const check = (effect: string, ok: boolean, detail: string) => {
  results.push({ effect, ok, detail });
  console.log(`${ok ? "PASS" : "GAP "}  ${effect}\n        ${detail}`);
};

// Effect 1 — reuse-remap + supersession + canon-injection:
// pre-seed canonical subject; extract an EXACT-match candidate under a new value with a later validFrom.
// Assert: extractor's ctx.canonicalSubjects included the seeded subject; disposition "reuse"; subject.final == canonical;
//         write.supersession.action == "superseded".
{
  const s = openSession({ dbPath: tmpDb(), writer: "vi" });
  s.createCorpus({ id: "c", keyCardinality: { status: "single" } });
  s.write("c", { subject: "project:crewtracks", key: "status", value: "active",
    valid: { from: 1, to: Infinity }, source: "llm", confidence: 0.8 });
  let sawCanon = false;
  const r = await ingest(s, { corpus: "c",
    extract: (ctx) => { sawCanon = ctx.canonicalSubjects.includes("project:crewtracks");
      return [{ subject: "project:crewtracks", key: "status", value: "shipping",
        validFrom: "2026-02-01T00:00:00Z" }]; } }, deps);
  const c0 = r.claims[0];
  check("reuse-remap + supersession + extractor saw canon",
    sawCanon && c0.subject.disposition === "reuse" && c0.subject.final === "project:crewtracks"
      && c0.write?.supersession?.action === "superseded",
    `sawCanon=${sawCanon}, disposition=${c0.subject.disposition}, final=${c0.subject.final}, action=${c0.write?.supersession?.action}`);
  s.close();
}

// Effect 2 — over-anchoring guard: a genuinely-distinct subject (no shared tokens) is NOT folded.
{
  const s = openSession({ dbPath: tmpDb(), writer: "vi" });
  s.createCorpus({ id: "c" });
  s.write("c", { subject: "client:liner-division", key: "status", value: "active",
    valid: { from: 1, to: Infinity }, source: "llm", confidence: 0.8 });
  const r = await ingest(s, { corpus: "c",
    extract: () => [{ subject: "host:web-01", key: "status", value: "active",
      validFrom: "2026-02-01T00:00:00Z" }] }, deps);
  const c0 = r.claims[0];
  check("over-anchoring guard — distinct subject NOT folded",
    c0.subject.final === "host:web-01" && c0.subject.disposition !== "reuse",
    `final=${c0.subject.final}, disposition=${c0.subject.disposition}`);
  s.close();
}

// Effect 3 — dryRun writes nothing yet still proposes.
// Seed a single-cardinality key already holding two distinct values (so audit surfaces a
// cardinality-declare proposal), then dryRun-ingest a third distinct candidate.
// Assert: corpus claim count unchanged after ingest; every claims[i].write is undefined; proposals non-empty.
{
  const s = openSession({ dbPath: tmpDb(), writer: "vi" });
  s.createCorpus({ id: "c", keyCardinality: { plan: "single" } });
  s.write("c", { subject: "p", key: "plan", value: "alpha",
    valid: { from: 1, to: Infinity }, source: "llm", confidence: 0.8 });
  s.write("c", { subject: "p", key: "plan", value: "bravo",
    valid: { from: 2, to: Infinity }, source: "llm", confidence: 0.8 });
  const before = s.mneme.read("c", { corpusId: "c" }).length;
  const r = await ingest(s, { corpus: "c",
    extract: () => [{ subject: "p", key: "plan", value: "charlie",
      validFrom: "2026-03-01T00:00:00Z" }],
    dryRun: true }, deps);
  const after = s.mneme.read("c", { corpusId: "c" }).length;
  const noWrites = r.claims.every((c) => c.write === undefined);
  const proposed = r.proposals.length > 0;
  check("dryRun — propose-only: claim count unchanged, no writes, non-empty proposals",
    before === after && noWrites && proposed,
    `before=${before}, after=${after}, noWrites=${noWrites}, proposals=${r.proposals.length}`);
  s.close();
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${"=".repeat(60)}\n${passed}/${results.length} ingest-loop effects verified.`);
const gaps = results.filter((r) => !r.ok);
if (gaps.length) {
  console.log("\nGAPS:");
  for (const g of gaps) console.log(`  - ${g.effect}\n      ${g.detail}`);
}
process.exit(0);
