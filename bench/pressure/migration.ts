/**
 * Pressure test: upgrading a PRE-corpus_id store.
 * Copies a real legacy db (written before corpus_id existed) and opens it with the
 * current corpus-scoped facade, checking whether pre-existing claims survive the
 * migration and remain visible through scoped queries.
 */
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "../../src/surface/index.js";

const SRC = process.argv[2] ?? "C:/Users/brett/.mneme/knowledge.db";
if (!existsSync(SRC)) {
  console.error(`legacy db not found: ${SRC}`);
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "mneme-pt-"));
const db = join(dir, "store.db");
// Copy the FULL WAL set (-wal/-shm) too — the live data may not be checkpointed into the .db yet.
for (const ext of ["", "-wal", "-shm", ".corpora.json"]) {
  if (existsSync(`${SRC}${ext}`)) copyFileSync(`${SRC}${ext}`, `${db}${ext}`);
}

console.log(`=== opening a copy of ${SRC} with the current (corpus-scoped) code ===`);
const s = openSession({ dbPath: db });
const corpora = s.listCorpora();
console.log("registered corpora:", corpora.map((c) => c.id).join(", ") || "(none)");

for (const c of corpora) {
  const cnt = s.q(c.id, "count") as { groups: Map<string, { value: { n?: number } }> };
  const n = [...cnt.groups.values()][0]?.value?.n ?? "?";
  const text = s.q(c.id, "as text 4000") as { content: string };
  console.log(`corpus '${c.id}': scoped count = ${n}; composed-context length = ${text.content?.length ?? 0}`);
  if (n === 0 || n === "?") {
    console.log(`  !! pre-existing claims are INVISIBLE after migration (corpus_id was not backfilled)`);
  } else {
    console.log(`  ok: ${n} pre-existing claims survive and are visible`);
  }
}
s.close();
