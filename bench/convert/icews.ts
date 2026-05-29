/**
 * Convert an ICEWS temporal-KG dump to JSONL for the `icews` import mapper.
 *
 * Input lines are tab-separated: `subject \t relation \t object \t YYYY-MM-DD`.
 * Output lines are `{ subject, relation, object, timestamp }` (timestamp = ms epoch),
 * which the `icews` mapper turns into a claim with `valid.from = timestamp`.
 *
 *   npx tsx bench/convert/icews.ts <raw.txt> <out.jsonl>
 */
import { createReadStream, writeFileSync, appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [raw, out] = process.argv.slice(2);
if (!raw || !out) {
  console.error("usage: icews.ts <raw.txt> <out.jsonl>");
  process.exit(1);
}

writeFileSync(out, "");
let buf: string[] = [];
let n = 0;
let skipped = 0;
const flush = (): void => {
  if (buf.length) {
    appendFileSync(out, buf.join("\n") + "\n");
    buf = [];
  }
};

const rl = createInterface({ input: createReadStream(raw, "utf8"), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  const parts = line.split("\t");
  if (parts.length < 4) {
    skipped++;
    continue;
  }
  const [subject, relation, object, date] = parts;
  const timestamp = Date.parse(date.trim());
  if (Number.isNaN(timestamp)) {
    skipped++;
    continue;
  }
  buf.push(JSON.stringify({ subject, relation, object, timestamp }));
  n++;
  if (buf.length >= 10000) flush();
}
flush();
console.log(`converted ${n} rows -> ${out} (${skipped} skipped)`);
