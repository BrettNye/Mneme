/**
 * Pressure test: hard crash (SIGKILL) mid-write, then WAL recovery.
 * The tamper-evidence guarantee is only as good as its durability — a process killed
 * mid-transaction must NOT leave the per-corpus hash chain forked, half-appended, or
 * unverifiable. After the kill we reopen and assert:
 *   - the store reopens at all (no WAL corruption wedge)
 *   - verifyChain is intact over the committed prefix
 *   - every claim has exactly one event and vice versa (no half-written tx survived)
 *   - no duplicate recorded_seq
 *   - the chain CONTINUES cleanly from the recovered head (a fresh write verifies)
 */
import { spawn, execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openSession } from "../../src/surface/index.js";
import { createSqliteAdapter } from "../../src/index.js";
import { verifyChain } from "../../src/audit/index.js";

const corpus = "crash";
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { (ok ? pass++ : fail++); console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`); };

const db = join(mkdtempSync(join(tmpdir(), "mneme-crash-")), "store.db");

const setup = openSession({ dbPath: db, writer: "setup" });
setup.createCorpus({ id: corpus, subjects: [] });
setup.close();

console.log("=== spawning a writer, then SIGKILL mid-stream to simulate a crash ===");
let lastSeen = 0;
const proc = spawn("npx", ["tsx", "bench/pressure/crash-worker.ts", db, corpus, "victim"], { shell: true });
proc.stderr.on("data", (d) => { const m = String(d).trim().split("\n").pop(); if (m) lastSeen = Number(m) || lastSeen; });

// Let it commit a few hundred claims, then hard-kill the whole process tree.
// tsx cold-start is ~1-2s, so wait long enough that real writes are in flight.
await new Promise((r) => setTimeout(r, 3000));
try {
  // shell:true on Windows means proc.pid is the cmd shell; kill the tree so tsx dies too.
  if (process.platform === "win32") execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: "ignore" });
  else proc.kill("SIGKILL");
} catch { /* already gone */ }
await new Promise((r) => setTimeout(r, 400)); // let the OS reclaim file handles
console.log(`(killed after worker reported ~${lastSeen} writes)`);

// --- Recovery: reopen and audit ---
let reopened = false;
let claimCount = 0, eventCount = 0, dupSeq = 0, intact = false, brokenAt: string | null = null;
let continues = false;
try {
  const a = createSqliteAdapter(db); // reopening triggers WAL recovery
  reopened = true;
  const v = verifyChain(a, corpus);
  intact = v.intact; brokenAt = v.brokenAt ?? null;
  a.close!();

  const raw = new Database(db, { readonly: true });
  claimCount = (raw.prepare("SELECT COUNT(*) c FROM claims WHERE corpus_id=?").get(corpus) as { c: number }).c;
  eventCount = (raw.prepare("SELECT COUNT(*) c FROM claim_events WHERE corpus_id=?").get(corpus) as { c: number }).c;
  dupSeq = (raw.prepare("SELECT recorded_seq FROM claims WHERE corpus_id=? GROUP BY recorded_seq HAVING COUNT(*)>1").all(corpus)).length;
  raw.close();

  // Can the chain continue from the recovered head without forking?
  const s2 = openSession({ dbPath: db, writer: "post-crash" });
  s2.write(corpus, { subject: "after:recovery", key: "k", value: "ok" });
  const a2 = createSqliteAdapter(db);
  continues = verifyChain(a2, corpus).intact;
  a2.close!();
  s2.close();
} catch (e) {
  console.log("  recovery threw:", (e as Error).message);
}

check("worker actually wrote before the crash (non-vacuous test)", claimCount > 0, `recovered ${claimCount} claims`);
check("store reopens after crash (no WAL corruption wedge)", reopened);
check("hash chain intact over committed prefix", intact, `brokenAt=${brokenAt ?? "-"}`);
check("every claim has exactly one event (no half-written tx survived)", claimCount === eventCount, `claims=${claimCount} events=${eventCount}`);
check("no duplicate recorded_seq after recovery", dupSeq === 0, `${dupSeq} dup seqs`);
check("chain continues cleanly from recovered head", continues);
console.log(`  (recovered claims=${claimCount}, events=${eventCount})`);

console.log(`\n=== crash/recovery pressure test: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
