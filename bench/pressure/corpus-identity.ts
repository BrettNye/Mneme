/**
 * Pressure test: enforced corpus identity on the Claim type (`corpusId`), under a
 * DECOUPLED workspace, at volume — plus the cross-corpus replay backstop.
 *
 * Background: claims now carry `corpusId?: CorpusId`, populated on read from the
 * ENFORCED `corpus_id` column — never from the caller-supplied `workspace`. A session
 * pinned to ONE workspace across MANY corpora (`openSession({ workspace })`) is the
 * decoupling vector that historically let `workspace`-keyed code leak across corpora.
 *
 * This asserts the structural fix is effective:
 *   E1 — every claim read back carries the ENFORCED corpus as `corpusId` (A's claims
 *        => "A", B's => "B"), and NEVER the pinned workspace, at volume.
 *   E2 — a foreign claim cannot be replayed under the wrong corpus. Two layers:
 *        (a) end-to-end via the session, the scoped read blocks it (status "missing");
 *        (b) the deeper `Mneme.replay` assertion throws `corpus mismatch` when handed a
 *            foreign claim OBJECT directly (the backstop for code that bypasses the
 *            scoped read by holding a Claim).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "../../src/surface/index.js";

const M = Number(process.argv[2] ?? 2000); // claims per corpus
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  (ok ? pass++ : fail++);
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`);
};

const db = join(mkdtempSync(join(tmpdir(), "mneme-cid-")), "store.db");

// PIN one workspace across BOTH corpora — decouples `workspace` from the enforced corpus.
const PINNED = "pinned-ws";
const s = openSession({ dbPath: db, writer: "w", workspace: PINNED });
s.createCorpus({ id: "A", subjects: [] });
s.createCorpus({ id: "B", subjects: [] });

const idsA: string[] = [];
const idsB: string[] = [];
for (let i = 0; i < M; i++) {
  idsA.push(s.write("A", { subject: `s${i % 200}`, key: `k${i % 10}`, value: `a${i}` }).id);
  idsB.push(s.write("B", { subject: `s${i % 200}`, key: `k${i % 10}`, value: `b${i}` }).id);
}
console.log(`=== wrote ${M} claims to each of corpora A,B under pinned workspace "${PINNED}" ===`);

// ---------------- E1: corpusId reflects the ENFORCED corpus, never the workspace ----------------
let aOk = true, bOk = true, wsLeak = false;
for (const id of idsA) {
  const c = s.inspect("A", id);
  if (!c || c.corpusId !== "A") aOk = false;
  if (c && (c.corpusId as string) === PINNED) wsLeak = true;
}
for (const id of idsB) {
  const c = s.inspect("B", id);
  if (!c || c.corpusId !== "B") bOk = false;
  if (c && (c.corpusId as string) === PINNED) wsLeak = true;
}
check(`every A claim reads back corpusId==="A" (enforced corpus, not the pinned workspace)`, aOk);
check(`every B claim reads back corpusId==="B" (enforced corpus, not the pinned workspace)`, bOk);
check(`corpusId NEVER equals the pinned workspace "${PINNED}" (no workspace conflation on read)`, !wsLeak);

// Sanity: the decoupling is real (workspace IS pinned, distinct from corpusId) — proves
// the E1 checks above aren't vacuously passing because workspace happened to equal corpus.
{
  const c = s.inspect("A", idsA[0]) as { workspace?: string; corpusId?: string } | undefined;
  check(
    `decoupling is real: workspace==="${PINNED}" while corpusId==="A" on the same claim`,
    c?.workspace === PINNED && c?.corpusId === "A",
    `ws=${c?.workspace} cid=${c?.corpusId}`
  );
}

// ---------------- E2: a foreign claim cannot be replayed under the wrong corpus ----------------
// (a) End-to-end via the session: A's claim id under corpus B — the scoped read returns
//     nothing, so it surfaces as "missing" rather than leaking A's claim into B's replay.
const foreignReplay = s.replay("B", idsA[0]);
check(
  `session.replay of a foreign claim id under the wrong corpus is blocked (status "missing")`,
  foreignReplay.status === "missing",
  `status=${foreignReplay.status}`
);

// (b) Deeper backstop: hand Mneme.replay a foreign claim OBJECT (corpusId "A") under
//     corpus "B" — the assertion must throw `corpus mismatch`.
const foreignClaim = s.inspect("A", idsA[0]);
let threw = false, msg = "";
try {
  s.mneme.replay("B", foreignClaim as never);
} catch (e) {
  threw = true;
  msg = e instanceof Error ? e.message : String(e);
}
check(
  `Mneme.replay throws "corpus mismatch" for a foreign claim object (deep backstop)`,
  threw && /corpus mismatch/.test(msg),
  msg.slice(0, 90)
);

s.close();
console.log(`\n=== corpus-identity pressure test: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
