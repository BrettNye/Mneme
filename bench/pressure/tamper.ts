/**
 * Pressure test: tamper-evidence against a real SQLite attack.
 * Builds a real claim/event history via the facade, anchors an epoch, then mutates
 * the claim_events table directly (the actual threat) and checks that:
 *   T1  a naive field tamper (entry_hash left stale)  -> verifyChain reports the break
 *   T2  deleting an event                              -> verifyChain reports the break
 *   T3  appending a forged-but-consistent event AFTER anchoring -> chain still "intact",
 *       but the externally-saved Merkle root no longer matches (the anchor catches it)
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openSession } from "../../src/surface/index.js";
import { createSqliteAdapter } from "../../src/index.js";
import { verifyChain, anchorEpoch, auditReport, createLocalSigner, createLocalAnchor, merkleRoot } from "../../src/audit/index.js";
import type { StorageAdapter } from "../../src/adapters/adapter.js";

const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
const rootOf = (a: StorageAdapter, corpus: string) =>
  hex(merkleRoot(a.readEvents({ corpusId: corpus }).filter((e) => e.entryHash).map((e) => Uint8Array.from(Buffer.from(e.entryHash!, "hex")))));

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { (ok ? pass++ : fail++); console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`); };

const dir = mkdtempSync(join(tmpdir(), "mneme-tamper-"));
const db = join(dir, "store.db");

// 1. Real history via the facade: a few claims into corpus "acme".
const s = openSession({ dbPath: db, writer: "acme-svc" });
s.createCorpus({ id: "acme", subjects: [] });
for (let i = 0; i < 5; i++) s.write("acme", { subject: `host:${i}`, key: "status", value: i % 2 ? "healthy" : "degraded" });
s.close();

// 2. Audit on a fresh adapter over the same db (events persisted).
const a = createSqliteAdapter(db);
check("fresh chain verifies intact", verifyChain(a, "acme").intact);
const signer = createLocalSigner();
const anchor = createLocalAnchor(a, "acme");
const receipt = await anchorEpoch(a, "acme", "epoch-1", { signer, anchor });
const anchoredRoot = rootOf(a, "acme"); // the root captured at anchor time (kept "externally" in test memory)
const report = auditReport(verifyChain(a, "acme"), anchor.guarantee);
check("anchored with detect tier; report says tamper-detecting", receipt.guarantee === "detect" && report.claim === "tamper-detecting", `claim=${report.claim}`);
a.close!();

// 3a. T1 — naive field tamper: change a writer, leave entry_hash stale.
const atk1 = new Database(db);
atk1.prepare("UPDATE claim_events SET writer = 'attacker' WHERE seq_pk = (SELECT MIN(seq_pk)+2 FROM claim_events)").run();
atk1.close();
const a1 = createSqliteAdapter(db);
const v1 = verifyChain(a1, "acme");
check("T1 naive field tamper detected by verifyChain", !v1.intact && v1.brokenAt !== undefined, `brokenAt=${v1.brokenAt}`);
a1.close!();

// rebuild a clean store for T2/T3 (fresh history)
const dir2 = mkdtempSync(join(tmpdir(), "mneme-tamper2-"));
const db2 = join(dir2, "store.db");
const s2 = openSession({ dbPath: db2, writer: "acme-svc" });
s2.createCorpus({ id: "acme", subjects: [] });
for (let i = 0; i < 5; i++) s2.write("acme", { subject: `h:${i}`, key: "k", value: `v${i}` });
s2.close();

// 3b. T2 — delete an event row.
const a2pre = createSqliteAdapter(db2);
const rootBefore = rootOf(a2pre, "acme");
a2pre.close!();
const atk2 = new Database(db2);
atk2.prepare("DELETE FROM claim_events WHERE seq_pk = (SELECT MIN(seq_pk)+2 FROM claim_events)").run();
atk2.close();
const a2 = createSqliteAdapter(db2);
const v2 = verifyChain(a2, "acme");
check("T2 deleted event detected by verifyChain", !v2.intact, `brokenAt=${v2.brokenAt}`);

// 3c. T3 — append a forged-but-consistent event AFTER the anchor; chain stays intact, but the externally-anchored root no longer matches.
// (use a clean store so T2's break doesn't interfere)
a2.close!();
const dir3 = mkdtempSync(join(tmpdir(), "mneme-tamper3-"));
const db3 = join(dir3, "store.db");
const s3 = openSession({ dbPath: db3, writer: "svc" });
s3.createCorpus({ id: "acme", subjects: [] });
for (let i = 0; i < 4; i++) s3.write("acme", { subject: `h:${i}`, key: "k", value: `v${i}` });
s3.close();
const a3 = createSqliteAdapter(db3);
const anchoredRoot3 = rootOf(a3, "acme"); // saved externally at anchor time
a3.appendEvent({ op: "commit", corpusId: "acme", writer: "attacker", claimId: "forged-claim", recorded: Date.now(), recordedSeq: 999 });
const v3 = verifyChain(a3, "acme");
const rootAfter3 = rootOf(a3, "acme");
check("T3 forged append keeps chain internally 'intact'", v3.intact);
check("T3 external anchored root catches the forged append (root mismatch)", anchoredRoot3 !== rootAfter3, `${anchoredRoot3.slice(0,12)} != ${rootAfter3.slice(0,12)}`);
a3.close!();

console.log(`\n=== tamper pressure test: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
