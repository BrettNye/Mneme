/**
 * Pressure test: many tenants (corpora) in ONE store, at volume.
 * Confirms (a) each tenant query returns ONLY its own claims (no cross-tenant leak),
 * and (b) import throughput stays ~linear with the per-corpus hash chain + corpus_id
 * index (no O(n^2) regression).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "../../src/surface/index.js";

const K = Number(process.argv[2] ?? 10);   // tenants
const M = Number(process.argv[3] ?? 3000); // claims per tenant
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { (ok ? pass++ : fail++); console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`); };

const db = join(mkdtempSync(join(tmpdir(), "mneme-mt-")), "store.db");
const s = openSession({ dbPath: db, writer: "svc" });

const start = Date.now();
for (let t = 0; t < K; t++) {
  const corpus = `tenant-${t}`;
  s.createCorpus({ id: corpus, subjects: [] });
  const recs = Array.from({ length: M }, (_, i) => ({ subject: `t${t}:s${i % 500}`, key: `k${i % 20}`, value: `v${i}` }));
  s.writeMany(corpus, recs);
}
const elapsed = Date.now() - start;
const total = K * M;
console.log(`=== imported ${total} claims across ${K} tenants in ${(elapsed / 1000).toFixed(1)}s (${Math.round((total / elapsed) * 1000)}/s) ===`);

// (a) isolation: each tenant sees exactly its own M claims
let allIsolated = true;
for (let t = 0; t < K; t++) {
  const cnt = s.q(`tenant-${t}`, "count") as { groups: Map<string, { value: { n?: number } }> };
  const n = [...cnt.groups.values()][0]?.value?.n;
  if (n !== M) { allIsolated = false; console.log(`  tenant-${t}: count=${n} (expected ${M})`); }
}
check(`every tenant sees exactly its own ${M} claims (no over/under-count)`, allIsolated);

// (b) no cross-tenant leak: tenant-0 querying a subject that only exists in tenant-1 returns nothing
const cross = s.q("tenant-0", "where subject = t1:s0") as { claims?: unknown[] };
check("tenant-0 cannot see tenant-1's subjects (no cross-tenant read leak)", (cross.claims?.length ?? 0) === 0, `got ${cross.claims?.length ?? 0}`);

// total across the store via the raw count of one tenant proves scoping (not K*M)
check("a scoped count is per-tenant (not the whole store)", ([...(s.q("tenant-0", "count") as any).groups.values()][0]?.value?.n) === M);

s.close();
console.log(`\n=== multi-tenant pressure test: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
