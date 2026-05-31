/**
 * Pressure test: concurrent writers to ONE store/corpus (multi-process).
 * Spawns N worker processes each committing M claims to the same corpus, then audits:
 *   - verifyChain intact (no forked hash chain from a read-head-then-insert race)
 *   - no duplicate recorded_seq (no sequence collision)
 *   - no chain fork (no entry's prev_hash reused by two successors)
 *   - committed claims actually persisted (no silent SQLITE_BUSY loss)
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openSession } from "../../src/surface/index.js";
import { createSqliteAdapter } from "../../src/index.js";
import { verifyChain } from "../../src/audit/index.js";

const N = Number(process.argv[2] ?? 4);
const M = Number(process.argv[3] ?? 200);
const corpus = "shared";
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { (ok ? pass++ : fail++); console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`); };

const db = join(mkdtempSync(join(tmpdir(), "mneme-conc-")), "store.db");

// create the corpus first (so workers just write)
const setup = openSession({ dbPath: db, writer: "setup" });
setup.createCorpus({ id: corpus, subjects: [] });
setup.close();

console.log(`=== spawning ${N} concurrent writers x ${M} claims each into one corpus ===`);
const t0 = Date.now();
const workers = Array.from({ length: N }, (_, i) =>
  new Promise<{ label: string; ok: number; err: number; firstErr: string }>((res) => {
    const p = spawn("npx", ["tsx", "bench/pressure/concurrent-worker.ts", db, corpus, String(M), `w${i}`], { shell: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => process.stderr.write(d));
    p.on("close", () => {
      try { res(JSON.parse(out.trim().split("\n").pop()!)); }
      catch { res({ label: `w${i}`, ok: 0, err: M, firstErr: "no-output" }); }
    });
  })
);
const results = await Promise.all(workers);
const elapsed = Date.now() - t0;
const totalOk = results.reduce((a, r) => a + r.ok, 0);
const totalErr = results.reduce((a, r) => a + r.err, 0);
console.log("worker results:", JSON.stringify(results));
console.log(`(${totalOk} committed, ${totalErr} errored across ${N} processes in ${(elapsed / 1000).toFixed(1)}s)`);

// audit
const a = createSqliteAdapter(db);
const v = verifyChain(a, corpus);
a.close!();

const raw = new Database(db, { readonly: true });
const claimCount = (raw.prepare("SELECT COUNT(*) c FROM claims WHERE corpus_id = ?").get(corpus) as { c: number }).c;
const dupSeq = raw.prepare("SELECT recorded_seq FROM claims WHERE corpus_id=? GROUP BY recorded_seq HAVING COUNT(*)>1").all(corpus);
const forks = raw.prepare("SELECT prev_hash FROM claim_events WHERE corpus_id=? AND prev_hash != '' GROUP BY prev_hash HAVING COUNT(*)>1").all(corpus);
const eventCount = (raw.prepare("SELECT COUNT(*) c FROM claim_events WHERE corpus_id = ?").get(corpus) as { c: number }).c;
raw.close();

check("hash chain verifies intact after concurrent writes", v.intact, `brokenAt=${v.brokenAt ?? "-"}`);
check("no duplicate recorded_seq (no sequence collision)", dupSeq.length === 0, `${dupSeq.length} dup seqs`);
check("no chain fork (no prev_hash reused)", forks.length === 0, `${forks.length} forks`);
check("all committed claims persisted (no silent BUSY loss)", claimCount === totalOk, `claims=${claimCount} committedReported=${totalOk}`);
check("no writes lost to errors (BUSY handled)", totalErr === 0, `${totalErr} errored; firstErr=${results.find((r) => r.firstErr)?.firstErr ?? "-"}`);
console.log(`  (events=${eventCount}, claims=${claimCount})`);

console.log(`\n=== concurrency pressure test: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
