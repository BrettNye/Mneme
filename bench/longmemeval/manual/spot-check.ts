/**
 * Judge spot-check: blind human grading of a stratified judgment sample.
 *
 *   # 1. generate the blind grading sheet (no verdicts shown — no anchoring):
 *   npx tsx bench/longmemeval/manual/spot-check.ts --generate \
 *     --judgments bench/longmemeval/manual/data/key-ratify-judgments.jsonl \
 *     --claims bench/datasets/longmemeval/longmemeval-oracle-claims.jsonl \
 *     --out bench/longmemeval/manual/data/spot-check-sheet.md
 *
 *   # 2. human fills each VERDICT line with SAME / DIFF / UNSURE
 *
 *   # 3. score agreement:
 *   npx tsx bench/longmemeval/manual/spot-check.ts --score \
 *     --judgments ... --sheet bench/longmemeval/manual/data/spot-check-sheet.md
 *
 * Stratification: 4 score bands × judge verdict. Approvals oversampled (30/50)
 * because the headline number's 380 merges derive from them. Sampling is
 * DETERMINISTIC: each stratum sorted by sha256(a\x1fb), first N taken — fully
 * replayable, no RNG. Measures: agreement rate, false-accept estimate (judge
 * SAME, human DIFF — the recall-damage direction) and false-reject estimate
 * (judge DIFF, human SAME — the lost-lift direction), per band and overall.
 */
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ClaimRecord, type ClaimRecordT } from "../types.js";

interface Judgment {
  a: string;
  b: string;
  same: boolean;
  reason: string;
  score: number;
}

const BANDS: Array<{ name: string; lo: number; hi: number }> = [
  { name: "0.98+", lo: 0.98, hi: 1.01 },
  { name: "0.96-0.98", lo: 0.96, hi: 0.98 },
  { name: "0.94-0.96", lo: 0.94, hi: 0.96 },
  { name: "0.92-0.94", lo: 0.92, hi: 0.94 },
];
// allocation per (band, verdict): [approved (SAME), rejected (DIFF)]
const ALLOCATION: Record<string, [number, number]> = {
  "0.98+": [6, 2],
  "0.96-0.98": [8, 6],
  "0.94-0.96": [8, 6],
  "0.92-0.94": [8, 6],
};

const hashOf = (j: Judgment): string => createHash("sha256").update(`${j.a}\x1f${j.b}`).digest("hex");

export function loadJudgments(path: string): Judgment[] {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Judgment & { kind?: string })
    .filter((o) => o.kind === undefined);
}

/** Deterministic stratified sample: per (band, verdict), sort by content hash, take first N. */
export function sampleStratified(judgments: Judgment[]): Judgment[] {
  const out: Judgment[] = [];
  for (const band of BANDS) {
    const inBand = judgments.filter((j) => j.score >= band.lo && j.score < band.hi);
    const [nSame, nDiff] = ALLOCATION[band.name];
    const pick = (vs: Judgment[], n: number) =>
      [...vs].sort((x, y) => hashOf(x).localeCompare(hashOf(y))).slice(0, n);
    out.push(...pick(inBand.filter((j) => j.same), nSame));
    out.push(...pick(inBand.filter((j) => !j.same), nDiff));
  }
  return out;
}

function bandOf(score: number): string {
  return BANDS.find((b) => score >= b.lo && score < b.hi)?.name ?? "?";
}

function keyContext(claims: ClaimRecordT[], key: string): { subjects: string[]; values: string[] } {
  const subjects: string[] = [];
  const values: string[] = [];
  for (const c of claims) {
    if (c.key !== key) continue;
    if (subjects.length < 3 && !subjects.includes(c.subject)) subjects.push(c.subject);
    const v = String(c.value);
    if (values.length < 3 && !values.includes(v)) values.push(v);
  }
  return { subjects, values };
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      generate: { type: "boolean", default: false },
      score: { type: "boolean", default: false },
      judgments: { type: "string" },
      claims: { type: "string" },
      out: { type: "string" },
      sheet: { type: "string" },
    },
  });
  if (!values.judgments) {
    console.error("--judgments is required");
    return 1;
  }
  const judgments = loadJudgments(String(values.judgments));
  const sample = sampleStratified(judgments);

  if (values.generate) {
    if (!values.claims || !values.out) {
      console.error("--generate needs --claims and --out");
      return 1;
    }
    const lines = readFileSync(String(values.claims), "utf-8").split("\n").filter((l) => l.trim().length > 0);
    const allClaims: ClaimRecordT[] = lines.slice(1).map((l) => ClaimRecord.parse(JSON.parse(l)));

    const sheet: string[] = [
      "# Judge spot-check — BLIND grading sheet",
      "",
      "For each pair: do the two keys denote the SAME attribute slot — i.e. should a",
      "newer value under one supersede an older value under the other? Related-but-",
      "different attributes (e.g. service date vs purchase date) are DIFF.",
      "",
      "Replace each `VERDICT: ___` with exactly one of: SAME / DIFF / UNSURE.",
      "Do not consult the judgments file until scoring. Grade in order; ~1 min/pair.",
      "",
    ];
    sample.forEach((j, i) => {
      const ca = keyContext(allClaims, j.a);
      const cb = keyContext(allClaims, j.b);
      sheet.push(
        `### ${i + 1}.`,
        `- Subject(s): ${[...new Set([...ca.subjects, ...cb.subjects])].join(", ") || "(unknown)"}`,
        `- Key A: "${j.a}" — values: ${ca.values.map((v) => JSON.stringify(v)).join(", ") || "(none)"}`,
        `- Key B: "${j.b}" — values: ${cb.values.map((v) => JSON.stringify(v)).join(", ") || "(none)"}`,
        "",
        "VERDICT: ___",
        "",
      );
    });
    writeFileSync(String(values.out), sheet.join("\n"), "utf8");
    console.log(`sheet written: ${values.out} (${sample.length} pairs, blind)`);
    const byStratum = new Map<string, number>();
    for (const j of sample) {
      const k = `${bandOf(j.score)} ${j.same ? "SAME" : "DIFF"}`;
      byStratum.set(k, (byStratum.get(k) ?? 0) + 1);
    }
    for (const [k, n] of [...byStratum.entries()].sort()) console.log(`  ${k}: ${n}`);
    return 0;
  }

  if (values.score) {
    if (!values.sheet) {
      console.error("--score needs --sheet");
      return 1;
    }
    const sheetText = readFileSync(String(values.sheet), "utf-8");
    const verdicts = [...sheetText.matchAll(/^VERDICT:\s*(\S+)\s*$/gm)].map((m) => m[1].toUpperCase());
    if (verdicts.length !== sample.length) {
      console.error(`sheet has ${verdicts.length} VERDICT lines; expected ${sample.length}`);
      return 1;
    }
    if (verdicts.some((v) => !["SAME", "DIFF", "UNSURE"].includes(v))) {
      console.error(`unfilled or invalid verdicts present (must be SAME/DIFF/UNSURE): ${verdicts.filter((v) => !["SAME", "DIFF", "UNSURE"].includes(v)).join(", ")}`);
      return 1;
    }
    interface Tally { n: number; agree: number; falseAccept: number; falseReject: number; unsure: number }
    const mk = (): Tally => ({ n: 0, agree: 0, falseAccept: 0, falseReject: 0, unsure: 0 });
    const overall = mk();
    const byBand = new Map<string, Tally>(BANDS.map((b) => [b.name, mk()]));
    sample.forEach((j, i) => {
      const human = verdicts[i];
      const t = byBand.get(bandOf(j.score))!;
      for (const tally of [overall, t]) {
        tally.n++;
        if (human === "UNSURE") tally.unsure++;
        else if ((human === "SAME") === j.same) tally.agree++;
        else if (j.same) tally.falseAccept++; // judge SAME, human DIFF → recall-damage direction
        else tally.falseReject++; // judge DIFF, human SAME → lost-lift direction
      }
    });
    const fmt = (t: Tally): string => {
      const graded = t.n - t.unsure;
      const pct = graded > 0 ? `${Math.round((100 * t.agree) / graded)}%` : "—";
      return `n=${t.n} agree=${t.agree}/${graded} (${pct}) falseAccept=${t.falseAccept} falseReject=${t.falseReject} unsure=${t.unsure}`;
    };
    console.log(`OVERALL: ${fmt(overall)}`);
    for (const b of BANDS) console.log(`  ${b.name}: ${fmt(byBand.get(b.name)!)}`);
    console.log(
      "\nfalseAccept = judge approved, human says different (the recall-damage direction)\n" +
        "falseReject = judge rejected, human says same (the lost-lift direction)",
    );
    return 0;
  }

  console.error("pass --generate or --score");
  return 1;
}

import { pathToFileURL } from "node:url";
const isCliEntry = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCliEntry) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
