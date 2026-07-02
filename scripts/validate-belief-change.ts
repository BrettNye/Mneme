/**
 * Validate the belief-change / MCP-utilization improvements the Fireflies-dogfood audit drove
 * (declare_cardinality, supersession-aware remember, audit propose-loop, history lineage, inspect)
 * — deterministic, offline, no LLM. Companion to scripts/validate-shipped-dogfood.ts (which covers
 * the 5 recorded stoa findings). `npx tsx scripts/validate-belief-change.ts`
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession, recall, remember } from "../src/surface/index.js";
import { audit } from "../src/surface/audit.js";
import { lineageOf } from "../src/surface/history.js";

const deps = { embeddings: { rankFn: "jaccard" as const } };
const tmpDb = () => join(mkdtempSync(join(tmpdir(), "mneme-bc-")), "store.db");
const results: { effect: string; ok: boolean; detail: string }[] = [];
const check = (effect: string, ok: boolean, detail: string) => {
  results.push({ effect, ok, detail });
  console.log(`${ok ? "PASS" : "GAP "}  ${effect}\n        ${detail}`);
};
const seedSingle = (id: string, vals: string[]) => {
  const s = openSession({ dbPath: tmpDb(), writer: "validate-bc" });
  s.createCorpus({ id, keyCardinality: { plan: "single" } });
  const ids = vals.map((v, i) =>
    s.write(id, { subject: "p", key: "plan", value: v, valid: { from: i + 1, to: Infinity }, source: "llm", confidence: 0.8 }).id);
  return { s, ids };
};

// ── A. Cardinality declaration is ACTIONABLE (declare_cardinality) ──────────────────────────────
{
  const { s } = seedSingle("c", ["alpha", "bravo"]);
  const before = await recall(s, { about: "plan", corpus: "c", subject: "p", key: "plan", limit: 10 }, deps);
  const warned = (before.warnings ?? []).some((w) => /single-cardinality.*plan/.test(w));
  const nSingle = before.matches.length;
  s.declareCardinality("c", { plan: "multi" });
  const after = await recall(s, { about: "plan", corpus: "c", subject: "p", key: "plan", limit: 10 }, deps);
  const nMulti = after.matches.length;
  const warnGone = !(after.warnings ?? []).some((w) => /single-cardinality/.test(w));
  check("A  declare_cardinality makes the warning actionable (single→1 warned, declare multi→both, warning gone)",
    warned && nSingle === 1 && nMulti === 2 && warnGone,
    `warned=${warned}, served single=${nSingle}, served after multi=${nMulti}, warning gone=${warnGone}`);
  s.close();
}

// ── B. Write no longer blind (supersession-aware remember; full chain) ──────────────────────────
{
  const s = openSession({ dbPath: tmpDb(), writer: "validate-bc" });
  s.createCorpus({ id: "c", keyCardinality: { plan: "single" } });
  const a = remember(s, { subject: "p", key: "plan", value: "alpha", corpus: "c", validFrom: "2026-01-01T00:00:00Z" });
  const b = remember(s, { subject: "p", key: "plan", value: "bravo", corpus: "c", validFrom: "2026-02-01T00:00:00Z" });
  const g = remember(s, { subject: "p", key: "plan", value: "gamma", corpus: "c", validFrom: "2026-03-01T00:00:00Z" });
  const twoDeprecated = g.supersession?.action === "superseded"
    && g.supersession.deprecatedIds.includes(a.id) && g.supersession.deprecatedIds.includes(b.id);
  check("B  remember reports supersession — the newest write names ALL older superseded claims (3-chain)",
    b.supersession?.action === "superseded" && twoDeprecated,
    `2nd write action=${b.supersession?.action}; 3rd write deprecatedIds=${g.supersession?.deprecatedIds.length} (expected both alpha+bravo)`);
  s.close();
}

// ── C. Maintenance is PROPOSE-ONLY (audit) ──────────────────────────────────────────────────────
{
  const { s } = seedSingle("c", ["alpha", "bravo"]);
  const beforeCount = s.mneme.read("c", { corpusId: "c" }).length;
  const beforeSchema = JSON.stringify((s.inspectCorpus("c") as { schema: { keyCardinality?: unknown } }).schema.keyCardinality);
  const a = await audit(s, { corpus: "c" }, deps);
  const proposed = a.proposals.some((p) => p.kind === "cardinality-declare");
  const noWrite = s.mneme.read("c", { corpusId: "c" }).length === beforeCount
    && JSON.stringify((s.inspectCorpus("c") as { schema: { keyCardinality?: unknown } }).schema.keyCardinality) === beforeSchema;
  check("C  audit proposes fixes but NEVER applies them (I3: claim count + schema unchanged)",
    proposed && noWrite,
    `cardinality-declare proposed=${proposed}; no-write (count+schema unchanged)=${noWrite}`);
  s.close();
}

// ── D. Non-destructive ledger is VISIBLE (history / lineageOf) ───────────────────────────────────
{
  const { s, ids } = seedSingle("c", ["alpha", "bravo", "gamma"]);
  const r = lineageOf(s, { corpus: "c", subject: "p", key: "plan" });
  const allRetained = r.entries.length === 3 && ids.every((id) => r.entries.some((e) => e.id === id));
  const latestServed = r.entries.at(-1)?.disposition === "served";
  const olderDeprecated = r.entries.filter((e) => e.disposition === "deprecated").length === 2
    && r.entries.filter((e) => e.disposition === "deprecated").every((e) => (e.reason as { kind: string }).kind === "deprecated-by");
  check("D  history exposes the non-destructive ledger — deprecated versions retained + attributed",
    allRetained && latestServed && olderDeprecated,
    `entries=${r.entries.length} (all 3 retained=${allRetained}); latest served=${latestServed}; 2 older deprecated-by=${olderDeprecated}`);
  s.close();
}

// ── E. Provenance handle (inspect) ──────────────────────────────────────────────────────────────
{
  const { s, ids } = seedSingle("c", ["alpha"]);
  const claim = s.inspect("c", ids[0]) as { id?: string; value?: unknown } | undefined;
  const bogus = s.inspect("c", "nonexistent-id");
  check("E  inspect returns a claim by id and degrades gracefully on a bogus id",
    claim?.id === ids[0] && claim?.value === "alpha" && bogus === undefined,
    `found id=${claim?.id === ids[0]}, value=${claim?.value}; bogus id → ${bogus === undefined ? "undefined (graceful)" : "UNEXPECTED"}`);
  s.close();
}

// ── Summary ──────────────────────────────────────────────────────────────────────────────────────
const passed = results.filter((r) => r.ok).length;
console.log(`\n${"=".repeat(64)}\n${passed}/${results.length} belief-change / utilization improvements verified.`);
const gaps = results.filter((r) => !r.ok);
if (gaps.length) {
  console.log("\nGAPS:");
  for (const g of gaps) console.log(`  - ${g.effect}\n      ${g.detail}`);
}
process.exit(0);
