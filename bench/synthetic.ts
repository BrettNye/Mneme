/**
 * Synthetic dataset benchmark for Mneme's import path.
 *
 * Runs a matrix of (scale x contradiction-policy), measuring import throughput,
 * peak RSS, and a follow-up query, and asserting correctness/integrity invariants
 * against the generator's ground-truth counts.
 *
 *   npx tsx bench/synthetic.ts
 *   npx tsx bench/synthetic.ts --scales 10000,100000,500000 --contradiction 0.3 --duplicate 0.1 --batch 1000
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { openSession, importFile } from "../src/surface/index.js";
import type { ContradictionPolicy } from "../src/index.js";
import { writeClaimsFile } from "./lib/generate.js";
import { peakRss, toMB, timed, markdownTable } from "./lib/measure.js";

const POLICIES: Record<string, ContradictionPolicy> = {
  always_accept: { kind: "always_accept" },
  reject: { kind: "reject_on_contradiction" },
  resolve: { kind: "accept_and_resolve", rule: "deprecate_lower" },
};

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

async function runOne(
  scale: number,
  policyName: string,
  cfg: { contradiction: number; duplicate: number; batch: number; scopeValues: number; seed: number },
): Promise<Record<string, string | number>> {
  const dir = mkdtempSync(join(tmpdir(), "mneme-bench-"));
  const file = join(dir, "data.jsonl");
  const db = join(dir, "bench.db");

  // 1. Generate (excluded from import timing).
  const gen = timed(() =>
    writeClaimsFile(file, {
      count: scale,
      contradictionRate: cfg.contradiction,
      duplicateRate: cfg.duplicate,
      scopeValues: cfg.scopeValues,
      seed: cfg.seed,
    }),
  );

  // 2. Import (the measured path).
  const session = openSession({ dbPath: db, writer: "bench", source: "imported" });
  session.createCorpus({ id: "bench", subjects: [], contradictionPolicy: POLICIES[policyName] });

  const rss = peakRss();
  const stats = await importFile(session, "bench", file, {
    format: "jsonl",
    batchSize: cfg.batch,
    onProgress: () => rss.sample(),
  });
  rss.sample();

  // 3. Follow-up query timing + count reconciliation.
  const countQ = timed(() => session.q("bench", "count") as { groups: Map<string, { value: { n?: number } }> });
  const counted = [...countQ.result.groups.values()][0]?.value?.n ?? -1;
  session.close();

  // 4. Correctness / integrity checks against generator ground truth.
  // Policy-agnostic integrity invariants (these MUST hold regardless of engine internals).
  // The exact committed/rejected split under reject/resolve is order-dependent engine
  // behavior, so it is reported as data — not asserted against stream-classified counts.
  const conserved = stats.committed + stats.rejected + stats.duplicate + stats.skipped;
  const checks: Check[] = [
    { name: "conservation", pass: conserved === stats.total && stats.total === gen.result.total, detail: `${conserved}==${stats.total}==${gen.result.total}` },
    // The corpus must contain exactly the committed claims — catches silent loss/miscount.
    { name: "count==committed", pass: counted === stats.committed, detail: `count=${counted} committed=${stats.committed}` },
    // Every fresh identity commits; nothing commits beyond the input.
    { name: "fresh<=committed<=total", pass: gen.result.fresh <= stats.committed && stats.committed <= stats.total, detail: `${gen.result.fresh}<=${stats.committed}<=${stats.total}` },
  ];
  if (policyName === "always_accept" || policyName === "resolve") {
    checks.push({ name: "accept-all", pass: stats.rejected === 0 && stats.committed === stats.total, detail: `rejected=${stats.rejected} committed=${stats.committed}/${stats.total}` });
  } else if (policyName === "reject") {
    checks.push({ name: "rejects-contradictions", pass: gen.result.contradictions === 0 || stats.rejected > 0, detail: `rejected=${stats.rejected} contradictions=${gen.result.contradictions}` });
  }

  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Temp dir cleanup is best-effort; the OS temp will be reclaimed regardless.
  }

  const failures = checks.filter((c) => !c.pass);
  const rowsPerSec = stats.elapsedMs > 0 ? Math.round((stats.total / stats.elapsedMs) * 1000) : 0;
  if (failures.length) {
    console.error(`  ✗ ${policyName}@${scale} failed: ${failures.map((f) => `${f.name}(${f.detail})`).join(", ")}`);
  }

  return {
    scale,
    policy: policyName,
    genMs: gen.ms,
    importMs: stats.elapsedMs,
    "rows/s": rowsPerSec,
    committed: stats.committed,
    rejected: stats.rejected,
    dup: stats.duplicate,
    skipped: stats.skipped,
    "count": counted,
    queryMs: countQ.ms,
    peakMB: toMB(rss.peakBytes()),
    checks: `${checks.length - failures.length}/${checks.length}`,
  };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      scales: { type: "string", default: "10000,100000" },
      policies: { type: "string", default: "always_accept,reject,resolve" },
      contradiction: { type: "string", default: "0.3" },
      duplicate: { type: "string", default: "0.1" },
      batch: { type: "string", default: "1000" },
      scopeValues: { type: "string", default: "0" },
      seed: { type: "string", default: "1" },
    },
  });
  const scales = values.scales!.split(",").map(Number);
  const policies = values.policies!.split(",");
  const cfg = {
    contradiction: Number(values.contradiction),
    duplicate: Number(values.duplicate),
    batch: Number(values.batch),
    scopeValues: Number(values.scopeValues),
    seed: Number(values.seed),
  };

  console.log(`Mneme synthetic benchmark — contradiction=${cfg.contradiction} duplicate=${cfg.duplicate} batch=${cfg.batch}\n`);
  const rows: Array<Record<string, string | number>> = [];
  let anyFail = false;
  for (const scale of scales) {
    for (const policy of policies) {
      const row = await runOne(scale, policy, cfg);
      rows.push(row);
      if (String(row.checks).split("/")[0] !== String(row.checks).split("/")[1]) anyFail = true;
      console.log(`  done ${policy}@${scale}: ${row["rows/s"]} rows/s, peak ${row.peakMB}MB, checks ${row.checks}`);
    }
  }

  console.log("\n" + markdownTable(rows) + "\n");
  return anyFail ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err);
  process.exit(1);
});
