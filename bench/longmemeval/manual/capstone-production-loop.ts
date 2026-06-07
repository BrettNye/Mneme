/**
 * Capstone: the key-matching benchmark through the LITERAL production loop.
 *
 *   npx tsx bench/longmemeval/manual/capstone-production-loop.ts \
 *     --file <oracle_target.json> --claims <oracle-claims.jsonl> \
 *     --judgments <key-ratify-judgments.jsonl> [--limit N] \
 *     [--expect-update-correct 0.528]
 *
 * Per question, over a REAL MCP server (in-process transport, real SQLite db):
 *   1. every extraction claim written via the `remember` tool;
 *   2. `key_census` generates candidates (production detect);
 *   3. committed judgments ratify approved pairs — alias claims written via
 *      `remember` (production declare: supersedable ledger claims);
 *   4. one `recall` per question exercises the production read path (the
 *      scalar-pooling fix's no-crash guarantee);
 *   5. scoring reads the SAME db: aliasMapOf over the ledger's alias claims
 *      (exactly recall's internals) → answerArmA → scoreQuestion.
 * Assert: KU updateCorrect reproduces the harness ratified row.
 *
 * Differences from the harness (documented): census candidates come from LIVE
 * post-pipeline keys (production) rather than raw record keys; canonical-rule
 * key counts come from census output. Divergences, if any, are reported — a
 * mismatch is a finding, not a silent pass.
 */
import { parseArgs } from "node:util";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMnemeMcpServer } from "../../../src/mcp/server.js";
import { openSession, pipe, leaf } from "../../../src/surface/index.js";
import { canonicalReadStages } from "../../../src/retrieval/read-pipeline.js";
import { markdownTable } from "../../lib/measure.js";
import {
  CacheHeader,
  ClaimRecord,
  normalizeQuestion,
  categoryOf,
  type LmeQuestionT,
  type ClaimRecordT,
} from "../types.js";
import { claimsFor, corpusIdFor } from "../ingest.js";
import { answerArmA } from "../answer.js";
import { scoreQuestion, aggregate, type QuestionScore } from "../score.js";
import { MANUAL_KEY_CARDINALITY } from "../run.js";
import { KEY_ALIAS_KEY, aliasMapOf } from "../../../src/retrieval/key-alias.js";
import { RULE } from "../../../src/distribution/rules.js";
import { autoRatify } from "./key-alias-auto.js";

const TARGET_CATEGORIES = new Set(["knowledge-update", "temporal-reasoning", "abstention"]);
const KS = [1, 3, 10];
const SUGGEST_THETA = 0.92;

type CensusStructured = {
  structuredContent?: {
    keys: { key: string; claims: number }[];
    candidates: { a: string; b: string; score: number }[];
    rankFn: string;
  };
};
type RecallStructured = {
  structuredContent?: {
    abstained: boolean;
    rankFn: string;
    matches: { value: unknown }[];
  };
};

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const pairKey = (a: string, b: string): string => (a < b ? `${a}\x1f${b}` : `${b}\x1f${a}`);

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      file: { type: "string" },
      claims: { type: "string" },
      judgments: { type: "string" },
      limit: { type: "string" },
      "expect-update-correct": { type: "string" },
    },
  });
  if (!values.file || !values.claims || !values.judgments) {
    console.error("--file, --claims, --judgments are required");
    return 1;
  }
  const limit = values.limit !== undefined ? parseInt(String(values.limit), 10) : Infinity;
  const expect =
    values["expect-update-correct"] !== undefined
      ? parseFloat(String(values["expect-update-correct"]))
      : undefined;

  // --- inputs ---
  const datasetRaw = JSON.parse(readFileSync(values.file, "utf-8")) as unknown[];
  const questions: LmeQuestionT[] = datasetRaw
    .map(normalizeQuestion)
    .filter((q) => TARGET_CATEGORIES.has(categoryOf(q)))
    .slice(0, limit === Infinity ? undefined : limit);
  const lines = readFileSync(values.claims, "utf-8").split("\n").filter((l) => l.trim().length > 0);
  CacheHeader.parse(JSON.parse(lines[0]));
  const allClaims: ClaimRecordT[] = lines.slice(1).map((l) => ClaimRecord.parse(JSON.parse(l)));

  const approved = new Set<string>();
  for (const line of readFileSync(String(values.judgments), "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)) {
    const obj = JSON.parse(line) as { kind?: string; a?: string; b?: string; same?: boolean };
    if (obj.kind === undefined && obj.same && obj.a && obj.b) approved.add(pairKey(obj.a, obj.b));
  }
  console.log(`questions: ${questions.length}; judged-approved pairs: ${approved.size}`);

  // --- real MCP server, real db ---
  const dir = mkdtempSync(join(tmpdir(), "mneme-capstone-"));
  const dbPath = join(dir, "store.db");
  const { server } = createMnemeMcpServer({ dbPath, defaultCorpus: "capstone" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "capstone", version: "0.0.0" });
  await client.connect(clientTransport);

  let aliasWrites = 0;
  let censusHybrid = 0;
  let recallOk = 0;
  // Hardening state: per-corpus expected write counts + recall served values
  const expectedWrites = new Map<string, number>(); // corpus → records + alias writes
  const recallValues = new Map<string, unknown[]>(); // corpus → recall match values

  try {
    for (let qi = 0; qi < questions.length; qi++) {
      const q = questions[qi];
      const corpus = corpusIdFor(q.question_id);
      const records = claimsFor(q, allClaims, { oracle: true });

      // 1. production writes
      for (const rec of records) {
        await client.callTool({
          name: "remember",
          arguments: {
            subject: rec.subject,
            key: rec.key,
            value: String(rec.value),
            corpus,
            tags: rec.tags,
            validFrom: new Date(rec.validFrom).toISOString(),
            ...(rec.confidence !== undefined ? { confidence: rec.confidence } : {}),
          },
        });
      }

      // 2. production detect
      const census = (await client.callTool({
        name: "key_census",
        arguments: { corpus, limit: 100000 },
      })) as CensusStructured;
      const sc = census.structuredContent;
      if (!sc) throw new Error(`census returned no structuredContent for ${corpus}`);
      if (sc.rankFn === "hybrid") censusHybrid++;

      // 3. ratify approved candidates (production declare — ledger claims)
      const keyCounts = new Map(sc.keys.map((k) => [k.key, k.claims]));
      const inBand = sc.candidates.filter((c) => c.score >= SUGGEST_THETA);
      const indicator = (a: string, b: string): number => {
        const pk = pairKey(a, b);
        return inBand.some((c) => pairKey(c.a, c.b) === pk) && approved.has(pk) ? 1 : 0;
      };
      const { map } = autoRatify(keyCounts, indicator, 1);
      for (const [variant, canonical] of Object.entries(map)) {
        await client.callTool({
          name: "remember",
          arguments: { subject: `key:${variant}`, key: KEY_ALIAS_KEY, value: canonical, corpus },
        });
        aliasWrites++;
      }

      // 4. production read path exercised (no-crash guarantee incl. pooling fix)
      const recall = (await client.callTool({
        name: "recall",
        arguments: { about: q.question, corpus, limit: 10 },
      })) as RecallStructured;
      if (recall.structuredContent && recall.structuredContent.abstained === false) recallOk++;
      recallValues.set(corpus, (recall.structuredContent?.matches ?? []).map((m) => m.value));
      expectedWrites.set(corpus, records.length + Object.keys(map).length);

      if ((qi + 1) % 25 === 0) console.log(`progress: ${qi + 1}/${questions.length} questions through the loop`);
    }

    // 5. scoring over the SAME db — alias maps from the LEDGER (recall's internals)
    // Single pinned instant for all alias-map loads: deterministic within the run
    // (must only be >= all write times; alias claims are valid to Infinity).
    const scoringInstant = Date.now();
    const scoringSession = openSession({ dbPath, writer: "capstone-scorer" });
    try {
      const scores: QuestionScore[] = [];
      let conservationFailures = 0;
      let servingDivergences = 0;
      for (const q of questions) {
        const corpus = corpusIdFor(q.question_id);
        const allCorpusClaims = scoringSession.mneme.read(corpus, { corpusId: corpus });
        // Hardening A: write conservation — every remember call landed in the ledger
        const expected = expectedWrites.get(corpus) ?? -1;
        if (allCorpusClaims.length !== expected) {
          console.error(`CONSERVATION FAIL ${corpus}: ledger has ${allCorpusClaims.length}, expected ${expected}`);
          conservationFailures++;
        }
        const aliasClaims = allCorpusClaims.filter((c) => c.key === KEY_ALIAS_KEY);
        const { map } = aliasMapOf(aliasClaims, { evaluationInstant: scoringInstant });
        const result = answerArmA(scoringSession, corpus, q, {
          k: 10,
          keyCardinality: MANUAL_KEY_CARDINALITY,
          keyAliases: map,
          evidencePoolingRule: RULE.MAX_MEAN,
        });
        // Hardening B: serving equivalence — every value the recall TOOL served must
        // be a value the same canonical pipeline serves AT A MATCHED CLOCK. Two
        // deliberate differences are excluded from the comparison: (1) ranking —
        // recall ranks with the server's rankFn (hybrid) vs the scorer's jaccard,
        // so we compare survivor SETS, not order; (2) the evaluation instant —
        // recall reads at wall-clock NOW (production semantics: everything visible)
        // while METRIC scoring reads at the question date (benchmark τ_known).
        // The first hardened run compared mismatched clocks and "caught" exactly
        // that designed τ difference on 2 questions with post-question-date
        // evidence — verified expected, so equivalence now compares at NOW.
        const survivorCorpus = scoringSession.mneme.query<{ claims: { value: unknown }[] }>(
          corpus,
          pipe(
            leaf(corpus),
            ...canonicalReadStages({
              evaluationInstant: scoringInstant,
              keyCardinality: MANUAL_KEY_CARDINALITY,
              keyAliases: map,
              evidencePoolingRule: RULE.MAX_MEAN,
            }),
          ),
          { evaluationClock: scoringInstant },
        );
        const survivors = new Set(survivorCorpus.claims.map((c) => JSON.stringify(c.value)));
        for (const v of recallValues.get(corpus) ?? []) {
          if (!survivors.has(JSON.stringify(v))) {
            console.error(`SERVING DIVERGENCE ${corpus}: recall served ${JSON.stringify(v)} absent from scorer survivors`);
            servingDivergences++;
          }
        }
        scores.push(scoreQuestion(q, result, KS));
      }
      console.log(`hardening: conservation failures ${conservationFailures}; serving divergences ${servingDivergences}`);
      if (conservationFailures > 0 || servingDivergences > 0) {
        console.error("CAPSTONE HARDENING FAILED — see lines above");
        return 1;
      }
      const rows = aggregate(scores, KS);
      const tableRows = rows
        .filter((r) => r.arm === "A")
        .map((r) => ({ category: r.category, metric: r.metric, value: r3(r.value), n: r.n }));
      console.log(`\nalias claims written via remember: ${aliasWrites}; census hybrid: ${censusHybrid}/${questions.length}; recalls ok: ${recallOk}/${questions.length}`);
      console.log("\n" + markdownTable(tableRows) + "\n");

      if (expect !== undefined) {
        const ku = rows.find((r) => r.category === "knowledge-update" && r.metric === "updateCorrect" && r.arm === "A");
        if (!ku) {
          console.error("CAPSTONE: no KU updateCorrect row produced");
          return 1;
        }
        if (r3(ku.value) === r3(expect)) {
          console.log(`CAPSTONE MATCH: production-loop KU updateCorrect ${r3(ku.value)} === harness ratified row ${r3(expect)} ✓`);
        } else {
          console.error(`CAPSTONE DIVERGENCE: production-loop KU updateCorrect ${r3(ku.value)} !== harness ${r3(expect)} — investigate (a divergence is a finding)`);
          return 1;
        }
      }
      return 0;
    } finally {
      scoringSession.close();
    }
  } finally {
    await client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
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
