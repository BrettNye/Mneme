/**
 * Convert a ConceptNet 5 assertions dump to JSONL for the `conceptnet` mapper.
 *
 * Input lines are tab-separated: `uri \t /r/Rel \t /c/lang/start \t /c/lang/end \t {json}`,
 * where the trailing JSON metadata carries `weight`. Output lines are
 * `{ start, rel, end, weight }` (URI prefixes stripped for readability), which the
 * `conceptnet` mapper turns into a claim with `weight` as scalar confidence.
 *
 *   # stream a capped subset without downloading the whole 350MB dump:
 *   curl -s <assertions.csv.gz> | gunzip | head -n 200000 > bench/datasets/cn.tsv
 *   npx tsx bench/convert/conceptnet.ts bench/datasets/cn.tsv bench/datasets/cn.jsonl
 */
import { createReadStream, writeFileSync, appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [raw, out] = process.argv.slice(2);
if (!raw || !out) {
  console.error("usage: conceptnet.ts <raw.tsv> <out.jsonl>");
  process.exit(1);
}

const strip = (uri: string): string => uri.replace(/^\/[a-z]\/(en\/|[a-z]{2}\/)?/, "");

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
  if (parts.length < 5) {
    skipped++;
    continue;
  }
  const [, rel, start, end, meta] = parts;
  let weight = 1;
  try {
    weight = (JSON.parse(meta) as { weight?: number }).weight ?? 1;
  } catch {
    // keep default weight on malformed metadata
  }
  buf.push(JSON.stringify({ start: strip(start), rel: strip(rel), end: strip(end), weight }));
  n++;
  if (buf.length >= 10000) flush();
}
flush();
console.log(`converted ${n} rows -> ${out} (${skipped} skipped)`);
