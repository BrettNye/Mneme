// Filter the raw LongMemEval downloads to the three target categories
// (knowledge-update / temporal-reasoning / abstention) — writes *_target.json
// next to the downloads. Deterministic; safe to re-run.
//   npx tsx bench/longmemeval/manual/build-target-subsets.ts
import { readFileSync, writeFileSync } from "node:fs";
import { normalizeQuestion, categoryOf } from "../types.js";

const TARGETS = new Set(["knowledge-update", "temporal-reasoning", "abstention"]);
const dataDir = (n: string) => new URL(`../../datasets/longmemeval/${n}`, import.meta.url);

for (const f of ["longmemeval_oracle", "longmemeval_s"]) {
  const raw = JSON.parse(readFileSync(dataDir(`${f}.json`), "utf8")) as unknown[];
  const filtered = raw.filter((r) => TARGETS.has(categoryOf(normalizeQuestion(r))));
  writeFileSync(dataDir(`${f}_target.json`), JSON.stringify(filtered));
  console.log(`${f}_target.json: ${filtered.length} questions (of ${raw.length})`);
}
