/**
 * Pressure test: adversarial/unicode data + cross-corpus idempotency isolation.
 *
 * Family A — data fidelity: write claims whose subject/key/value carry control chars,
 *   newlines, quotes, backslashes, unicode, NUL bytes, delimiter-collision shapes, and
 *   huge strings. Assert exact round-trip via the public API, that delimiter-shaped
 *   fields stay DISTINCT (no naive-join identity collision), and the hash chain stays intact.
 *
 * Family B — idempotency isolation: the scoped adapter force-stamps corpus_id on writes
 *   because caller-supplied corpus can't be trusted for isolation. But the idempotency
 *   scope keys off candidate.workspace (caller-supplied), not the enforced corpus. If a
 *   caller pins one workspace across two corpora and reuses an idempotency key, the second
 *   corpus's write could be suppressed as a "duplicate" of the first's — a cross-corpus leak.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "../../src/surface/index.js";
import { createSqliteAdapter } from "../../src/index.js";
import { verifyChain } from "../../src/audit/index.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { (ok ? pass++ : fail++); console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`); };

const db = join(mkdtempSync(join(tmpdir(), "mneme-adv-")), "store.db");
const s = openSession({ dbPath: db, writer: "w" });
s.createCorpus({ id: "A", subjects: [] });
s.createCorpus({ id: "B", subjects: [] });

// ---------------- Family A: adversarial data fidelity ----------------
console.log("=== Family A: adversarial/unicode data round-trip ===");

const NUL = String.fromCharCode(0);
const cases: { name: string; subject: string; key: string; value: string }[] = [
  { name: "newline/tab/quote/backslash", subject: "s-ctrl", key: "k", value: 'line1\nline2\ttab"quote"\\back' },
  { name: "unicode + emoji + combining", subject: "café-naïve-日本語", key: "k", value: "日本語 café 🎌 naïve ☃" },
  { name: "NUL byte mid-string", subject: "s-nul", key: "k", value: `a${NUL}b` },
  { name: "json-injection-looking", subject: 's-json', key: "k", value: '","x":"pwned' },
  { name: "huge value (100k chars)", subject: "s-huge", key: "k", value: "x".repeat(100_000) },
];

for (const c of cases) {
  const r = s.write("A", { subject: c.subject, key: c.key, value: c.value });
  const back = s.inspect("A", r.id);
  const ok = !!back && back.subject === c.subject && back.value === c.value;
  const detail = !back ? "not found" : back.value === c.value ? "" : `value len in=${c.value.length} out=${String(back.value).length}`;
  check(`round-trips exactly: ${c.name}`, ok, detail);
}

// Delimiter-collision: ("a:b","c") vs ("a","b:c") must be two DISTINCT identities.
const p = s.write("A", { subject: "a:b", key: "c", value: "P" });
const q = s.write("A", { subject: "a", key: "b:c", value: "Q" });
const pBack = s.inspect("A", p.id);
const qBack = s.inspect("A", q.id);
check("delimiter-shaped fields stay distinct (no identity collision)",
  p.id !== q.id && pBack?.value === "P" && qBack?.value === "Q",
  `pId=${p.id.slice(0, 8)} qId=${q.id.slice(0, 8)} pVal=${pBack?.value} qVal=${qBack?.value}`);

// Hash chain must survive all of the above unscathed.
{
  const a = createSqliteAdapter(db);
  const v = verifyChain(a, "A");
  a.close!();
  check("hash chain intact after adversarial writes", v.intact, `brokenAt=${v.brokenAt ?? "-"}`);
}

// ---------------- Family B: cross-corpus idempotency isolation ----------------
console.log("=== Family B: cross-corpus idempotency isolation ===");
const mneme = s.mneme;
const mkCand = (corpusId: string, workspace: string, value: string) => ({
  profile: "cli" as never,
  workspace: workspace as never,
  subject: "subj" as never,
  key: "k" as never,
  scope: {},
  value,
  confidence: { distribution: "scalar" as const, parameters: { p: 1 }, raw: 1 },
  valid: { from: 0, to: Infinity },
  source: "manual" as const,
  provenance: {},
  evidence: [],
  tags: [],
  schema: `${corpusId}@1`,
  status: undefined as never, // pipeline defaults to the corpus's defaultStatus, matching the surface path
});

// B1 (control): workspace defaults to the corpus id -> scopes differ -> both must commit.
const b1a = mneme.commit("A", mkCand("A", "A", "vA"), { writer: "w", idempotencyKey: "i-shared" });
const b1b = mneme.commit("B", mkCand("B", "B", "vB"), { writer: "w", idempotencyKey: "i-shared" });
check("default workspace=corpus: same idemKey across corpora both commit",
  b1a.status === "committed" && b1b.status === "committed",
  `A=${b1a.status} B=${b1b.status}`);

// B2 (the probe): caller PINS one workspace across two corpora and reuses an idemKey.
const b2a = mneme.commit("A", mkCand("A", "shared", "to-A"), { writer: "w", idempotencyKey: "i-pin" });
const b2b = mneme.commit("B", mkCand("B", "shared", "to-B"), { writer: "w", idempotencyKey: "i-pin" });
// Correct behavior: B's write is its own claim, committed, resolvable IN corpus B.
const b2bInB = s.inspect("B", b2b.id);
check("pinned workspace: corpus B write is NOT suppressed as corpus A's duplicate",
  b2b.status === "committed",
  `A=${b2a.status}(${b2a.id.slice(0, 8)}) B=${b2b.status}(${b2b.id.slice(0, 8)})`);
check("pinned workspace: B's returned id resolves to B's value (no cross-corpus id leak)",
  b2bInB?.value === "to-B",
  `inspect B/${b2b.id.slice(0, 8)} -> ${b2bInB ? `value=${b2bInB.value}` : "NOT FOUND (dangling id)"}`);

s.close();
console.log(`\n=== adversarial pressure test: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
