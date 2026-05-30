/**
 * Benchmark a real dataset (already converted to JSONL) through Mneme's import path.
 *
 *   npx tsx bench/dataset.ts --name icews14 --file bench/datasets/icews14.jsonl --as icews
 *   npx tsx bench/dataset.ts --name conceptnet --file bench/datasets/cn.jsonl --as conceptnet --policy reject
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { openSession, importFile } from "../src/surface/index.js";
import type { ContradictionPolicy } from "../src/index.js";
import { peakRss, toMB, timed, markdownTable } from "./lib/measure.js";

const POLICIES: Record<string, ContradictionPolicy> = {
  always_accept: { kind: "always_accept" },
  reject: { kind: "reject_on_contradiction" },
  resolve: { kind: "accept_and_resolve", rule: "deprecate_lower" },
};

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      name: { type: "string", default: "dataset" },
      file: { type: "string" },
      as: { type: "string", default: "jsonl" },
      policy: { type: "string", default: "always_accept" },
      batch: { type: "string", default: "1000" },
    },
  });
  if (!values.file) {
    console.error("--file <jsonl> is required");
    return 1;
  }

  const dir = mkdtempSync(join(tmpdir(), "mneme-ds-"));
  const db = join(dir, "ds.db");
  const session = openSession({ dbPath: db, writer: "bench", source: "imported" });
  session.createCorpus({ id: "ds", subjects: [], contradictionPolicy: POLICIES[values.policy!] });

  const rss = peakRss();
  const stats = await importFile(session, "ds", values.file!, {
    format: values.as as "jsonl" | "conceptnet" | "icews",
    batchSize: Number(values.batch),
    onProgress: () => rss.sample(),
  });
  rss.sample();

  const countQ = timed(() => session.q("ds", "count") as { groups: Map<string, { value: { n?: number } }> });
  const counted = [...countQ.result.groups.values()][0]?.value?.n ?? -1;
  session.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }

  const conserved = stats.committed + stats.rejected + stats.duplicate + stats.skipped;
  const checks = [
    { name: "conservation", pass: conserved === stats.total, detail: `${conserved}==${stats.total}` },
    { name: "count==committed", pass: counted === stats.committed, detail: `count=${counted} committed=${stats.committed}` },
  ];
  const fails = checks.filter((c) => !c.pass);
  if (fails.length) console.error(`  ✗ checks failed: ${fails.map((f) => `${f.name}(${f.detail})`).join(", ")}`);

  const rowsPerSec = stats.elapsedMs > 0 ? Math.round((stats.total / stats.elapsedMs) * 1000) : 0;
  const row = {
    dataset: values.name!,
    policy: values.policy!,
    total: stats.total,
    importMs: stats.elapsedMs,
    "rows/s": rowsPerSec,
    committed: stats.committed,
    rejected: stats.rejected,
    dup: stats.duplicate,
    skipped: stats.skipped,
    count: counted,
    queryMs: countQ.ms,
    peakMB: toMB(rss.peakBytes()),
    checks: `${checks.length - fails.length}/${checks.length}`,
  };
  console.log("\n" + markdownTable([row]) + "\n");
  return fails.length ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err);
  process.exit(1);
});
