/**
 * Rule mining: how much of the key-matching judge is compilable into
 * deterministic rules? (The meaning-as-math question, sized with data.)
 *
 *   npx tsx bench/longmemeval/manual/rule-mining.ts \
 *     --judgments bench/longmemeval/manual/data/key-ratify-judgments.jsonl \
 *     [--sheet bench/longmemeval/manual/data/spot-check-sheet.md]
 *
 * For each candidate rule (a deterministic predicate over a key pair that
 * PREDICTS "same attribute"), measure against the 1,192 judge verdicts —
 * and, where the pair is in the human-graded spot-check sample, against the
 * human verdicts. Rules are CASCADED (first-firing wins) so coverage numbers
 * are additive. Pure analysis: no writes, no model, no LLM.
 */
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { loadJudgments, sampleStratified } from "./spot-check.js";

interface Judgment { a: string; b: string; same: boolean; reason: string; score: number }

const r1 = (v: number): string => `${Math.round(v * 1000) / 10}%`;

// ── normalization helpers ─────────────────────────────────────────────────────
const STOP_TOKENS = new Set(["of", "for", "the", "a", "an", "in", "on", "to", "with", "and"]);
const fold = (s: string): string => s.toLowerCase().replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
const tokens = (s: string): string[] => fold(s).split(" ").filter((t) => t.length > 0);
const tokenSet = (s: string): Set<string> => new Set(tokens(s));
const contentSet = (s: string): Set<string> => new Set(tokens(s).filter((t) => !STOP_TOKENS.has(t)));
const setEq = (x: Set<string>, y: Set<string>): boolean => x.size === y.size && [...x].every((t) => y.has(t));
const subset = (x: Set<string>, y: Set<string>): boolean => [...x].every((t) => y.has(t));
// naive plural fold: trailing "s" stripped per token (measured, not assumed safe)
const sFold = (set: Set<string>): Set<string> => new Set([...set].map((t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t)));

// ── candidate rules (each predicts SAME when it fires) ────────────────────────
const RULES: Array<{ name: string; fires: (a: string, b: string) => boolean }> = [
  { name: "R1 case-fold equal", fires: (a, b) => a.toLowerCase() === b.toLowerCase() },
  { name: "R2 separator-fold equal", fires: (a, b) => fold(a) === fold(b) },
  { name: "R3 token-set equal (reorder)", fires: (a, b) => setEq(tokenSet(a), tokenSet(b)) },
  { name: "R4 content-token-set equal (stopwords dropped)", fires: (a, b) => setEq(contentSet(a), contentSet(b)) },
  { name: "R5 content-set equal after plural-fold", fires: (a, b) => setEq(sFold(contentSet(a)), sFold(contentSet(b))) },
  {
    name: "R6 same head + modifier-subset",
    fires: (a, b) => {
      const ta = tokens(a);
      const tb = tokens(b);
      if (ta.length === 0 || tb.length === 0) return false;
      if (ta[ta.length - 1] !== tb[tb.length - 1]) return false; // same head noun
      const ca = contentSet(a);
      const cb = contentSet(b);
      return subset(ca, cb) || subset(cb, ca); // one is a modifier-refinement of the other
    },
  },
];

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { judgments: { type: "string" }, sheet: { type: "string" } },
  });
  if (!values.judgments) {
    console.error("--judgments required");
    return 1;
  }
  const judgments = loadJudgments(String(values.judgments)) as Judgment[];
  const totalSame = judgments.filter((j) => j.same).length;
  console.log(`judgments: ${judgments.length} (judge-approved: ${totalSame})\n`);

  // ── human grades (optional): reconstruct the stratified sample pairing ──────
  const humanByPair = new Map<string, string>();
  if (values.sheet) {
    const sample = sampleStratified(judgments as never[]) as unknown as Judgment[];
    const verdicts = [...readFileSync(String(values.sheet), "utf-8").matchAll(/^VERDICT:\s*(\S+)\s*$/gm)].map((m) =>
      m[1].toUpperCase(),
    );
    if (verdicts.length === sample.length) {
      sample.forEach((j, i) => humanByPair.set(`${j.a}\x1f${j.b}`, verdicts[i]));
      console.log(`human grades joined: ${humanByPair.size} pairs\n`);
    } else {
      console.log(`(sheet verdicts ${verdicts.length} != sample ${sample.length} — human columns skipped)\n`);
    }
  }

  // ── per-rule (independent) and cascade (first-fire) metrics ─────────────────
  console.log("| rule | fires | precision vs judge | recall of judge-SAME | human agree (n) |");
  console.log("| --- | --- | --- | --- | --- |");
  for (const rule of RULES) {
    const fired = judgments.filter((j) => rule.fires(j.a, j.b));
    const tp = fired.filter((j) => j.same).length;
    const humanPairs = fired.filter((j) => humanByPair.has(`${j.a}\x1f${j.b}`));
    const humanAgree = humanPairs.filter((j) => humanByPair.get(`${j.a}\x1f${j.b}`) === "SAME").length;
    console.log(
      `| ${rule.name} | ${fired.length} (${r1(fired.length / judgments.length)}) | ${fired.length ? r1(tp / fired.length) : "—"} | ${r1(tp / totalSame)} | ${humanPairs.length ? `${humanAgree}/${humanPairs.length}` : "—"} |`,
    );
  }

  console.log("\nCASCADE (first-firing rule wins; residue = judgment surface):");
  console.log("| stage | claims | precision vs judge | cumulative recall of judge-SAME |");
  console.log("| --- | --- | --- | --- |");
  const claimed = new Set<number>();
  let cumTp = 0;
  for (const rule of RULES) {
    const mine = judgments.map((j, i) => ({ j, i })).filter(({ j, i }) => !claimed.has(i) && rule.fires(j.a, j.b));
    mine.forEach(({ i }) => claimed.add(i));
    const tp = mine.filter(({ j }) => j.same).length;
    cumTp += tp;
    console.log(
      `| ${rule.name} | ${mine.length} | ${mine.length ? r1(tp / mine.length) : "—"} | ${r1(cumTp / totalSame)} |`,
    );
  }
  const residue = judgments.filter((_, i) => !claimed.has(i));
  const residueSame = residue.filter((j) => j.same).length;
  console.log(
    `| (residue → judgment) | ${residue.length} | ${residue.length ? r1(residueSame / residue.length) : "—"} | — |`,
  );

  // ── example misfires for the riskiest rules (honesty check) ─────────────────
  console.log("\nMisfire samples (rule fired, judge said DIFF):");
  for (const rule of RULES.slice(3)) {
    const misses = judgments.filter((j) => rule.fires(j.a, j.b) && !j.same).slice(0, 3);
    for (const m of misses) console.log(`  [${rule.name}] "${m.a}" ~ "${m.b}" — judge: ${m.reason.slice(0, 90)}`);
  }
  return 0;
}

import { pathToFileURL } from "node:url";
const isCliEntry = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCliEntry) {
  main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
