/**
 * LongMemEval benchmark runner — end-to-end deterministic path.
 *
 *   npx tsx bench/longmemeval/run.ts --file <dataset.json> --claims <claims.jsonl> [--k 1,3,10] [--oracle] [--raw]
 */
import { parseArgs } from "node:util";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "../../src/surface/index.js";
import { markdownTable } from "../lib/measure.js";
import {
  LmeQuestion,
  ClaimRecord,
  CacheHeader,
  categoryOf,
  normalizeQuestion,
  type LmeQuestionT,
  type ClaimRecordT,
} from "./types.js";
import {
  ingestQuestion,
  claimsFor,
  IngestConservationError,
  AlreadyIngestedError,
} from "./ingest.js";
import { answerArmA, answerArmB } from "./answer.js";
import { scoreQuestion, aggregate, type ScoreRow, type QuestionScore } from "./score.js";
import {
  EXTRACTION_MODEL,
  PROMPT_VERSION,
} from "../convert/longmemeval.js";

// ---------------------------------------------------------------------------
// Options type for testability
// ---------------------------------------------------------------------------

export interface RunOpts {
  /** Called with each ScoreRow from aggregate — for test introspection. */
  collect?: (rows: ScoreRow[]) => void;
  /** Called with the tmp directory path after it is created — for cleanup assertion in tests. */
  onTmpDir?: (dir: string) => void;
  /** Called for every error message that would go to console.error — for test introspection. */
  onError?: (msg: string) => void;
  /** Called after each successful ingest with the question id and committed count — for test introspection. */
  onIngest?: (questionId: string, committed: number) => void;
}

// ---------------------------------------------------------------------------
// Target categories (the 3 we score)
// ---------------------------------------------------------------------------

const TARGET_CATEGORIES = new Set(["knowledge-update", "temporal-reasoning", "abstention"]);

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(argv: string[], opts?: RunOpts): Promise<number> {
  // Unified error logger: mirrors to console.error and the optional onError hook.
  const logError = (msg: string): void => {
    console.error(msg);
    opts?.onError?.(msg);
  };

  // --- parse args ---
  let parsedArgs: ReturnType<typeof parseArgs>;
  try {
    parsedArgs = parseArgs({
      args: argv,
      options: {
        file: { type: "string" },
        claims: { type: "string" },
        k: { type: "string", default: "1,3,10" },
        oracle: { type: "boolean", default: false },
        raw: { type: "boolean", default: false },
      },
    });
  } catch (err) {
    logError(`Argument error: ${(err as Error).message}`);
    return 1;
  }

  const { values } = parsedArgs;

  if (!values.file) {
    logError("--file <dataset.json> is required");
    return 1;
  }
  if (!values.claims) {
    logError("--claims <claims.jsonl> is required");
    return 1;
  }

  const ks = String(values.k ?? "1,3,10")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n) && n > 0);

  if (ks.length === 0) {
    logError("--k must be a comma-separated list of positive integers");
    return 1;
  }

  const maxK = Math.max(...ks);
  const oracle = Boolean(values.oracle);
  const raw = Boolean(values.raw);

  // --- load dataset ---
  let datasetRaw: unknown[];
  try {
    const text = readFileSync(values.file, "utf-8");
    datasetRaw = JSON.parse(text) as unknown[];
  } catch (err) {
    logError(`Failed to read dataset file "${values.file}": ${(err as Error).message}`);
    return 1;
  }

  // --- parse questions ---
  let questions: LmeQuestionT[];
  try {
    const parsed = raw
      ? datasetRaw.map(normalizeQuestion)
      : datasetRaw.map((r) => LmeQuestion.parse(r));
    questions = parsed.filter((q) => TARGET_CATEGORIES.has(categoryOf(q)));
  } catch (err) {
    logError(`Failed to parse dataset: ${(err as Error).message}`);
    return 1;
  }

  // --- load and validate claims cache ---
  let allClaims: ClaimRecordT[];
  {
    let lines: string[];
    try {
      const text = readFileSync(values.claims, "utf-8");
      lines = text.split("\n").filter((l) => l.trim().length > 0);
    } catch (err) {
      logError(`Failed to read claims file "${values.claims}": ${(err as Error).message}`);
      return 1;
    }

    if (lines.length === 0) {
      logError("Claims file is empty — expected a header line");
      return 1;
    }

    // Validate header BEFORE creating any state
    let headerObj: unknown;
    try {
      headerObj = JSON.parse(lines[0]);
    } catch {
      logError("Claims file: first line is not valid JSON (expected header)");
      return 1;
    }

    const headerResult = CacheHeader.safeParse(headerObj);
    if (!headerResult.success) {
      logError(`Claims file: invalid header — ${headerResult.error.message}`);
      return 1;
    }

    const header = headerResult.data;
    const mismatches: string[] = [];
    if (header.model !== EXTRACTION_MODEL) {
      mismatches.push(`model: expected "${EXTRACTION_MODEL}", got "${header.model}"`);
    }
    if (header.promptVersion !== PROMPT_VERSION) {
      mismatches.push(`promptVersion: expected "${PROMPT_VERSION}", got "${header.promptVersion}"`);
    }
    if (mismatches.length > 0) {
      logError(`Claims cache header mismatch: ${mismatches.join("; ")}`);
      return 1;
    }

    // Parse claim records; malformed line = failed check (tracked later)
    allClaims = [];
    const parseErrors: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      let obj: unknown;
      try {
        obj = JSON.parse(lines[i]);
      } catch {
        parseErrors.push(`line ${i + 1}: not valid JSON`);
        continue;
      }
      const result = ClaimRecord.safeParse(obj);
      if (!result.success) {
        parseErrors.push(`line ${i + 1}: ${result.error.message}`);
        continue;
      }
      allClaims.push(result.data);
    }

    if (parseErrors.length > 0) {
      // Report but continue — each parse error is a failed check
      for (const e of parseErrors) {
        logError(`Claims parse error: ${e}`);
      }
    }
  }

  // --- create tmp DB ---
  const dir = mkdtempSync(join(tmpdir(), "mneme-lme-"));
  opts?.onTmpDir?.(dir);

  const session = openSession({
    dbPath: join(dir, "lme.db"),
    writer: "lme-bench",
    source: "imported",
  });

  // Track checks: each is { name, pass }
  const checks: Array<{ name: string; pass: boolean }> = [];

  const scoreRows: QuestionScore[] = [];

  try {
    for (const q of questions) {
      const qid = q.question_id;
      const records = claimsFor(q, allClaims, { oracle });

      // Ingest
      let ingestOk = false;
      try {
        const stats = ingestQuestion(session, q, records);
        ingestOk = true;
        opts?.onIngest?.(qid, stats.committed);
        checks.push({ name: `ingest-conservation:${qid}`, pass: true });
      } catch (err) {
        if (err instanceof IngestConservationError) {
          logError(`IngestConservationError for ${qid}: ${err.message}`);
          checks.push({ name: `ingest-conservation:${qid}`, pass: false });
        } else if (err instanceof AlreadyIngestedError) {
          logError(`AlreadyIngestedError for ${qid}: ${err.message}`);
          checks.push({ name: `ingest-conservation:${qid}`, pass: false });
        } else {
          logError(`Unexpected ingest error for ${qid}: ${(err as Error).message}`);
          checks.push({ name: `ingest-conservation:${qid}`, pass: false });
        }
        // keep-going semantics: continue to next question
        continue;
      }

      if (!ingestOk) continue;

      // Answer both arms
      const corpusId = `lme-${qid}`;

      let resultA;
      try {
        resultA = answerArmA(session, corpusId, q, { k: maxK });
        const scoreA = scoreQuestion(q, resultA, ks);
        scoreRows.push(scoreA);
        checks.push({ name: `score-A:${qid}`, pass: true });
      } catch (err) {
        logError(`Error in arm A for ${qid}: ${(err as Error).message}`);
        checks.push({ name: `score-A:${qid}`, pass: false });
      }

      let resultB;
      try {
        resultB = answerArmB(session, corpusId, q, { k: maxK });
        const scoreB = scoreQuestion(q, resultB, ks);
        scoreRows.push(scoreB);
        checks.push({ name: `score-B:${qid}`, pass: true });
      } catch (err) {
        logError(`Error in arm B for ${qid}: ${(err as Error).message}`);
        checks.push({ name: `score-B:${qid}`, pass: false });
      }
    }

    // Aggregate scores
    const aggregated = aggregate(scoreRows, ks);
    opts?.collect?.(aggregated);

    // Print markdown table
    if (aggregated.length > 0) {
      const tableRows = aggregated.map((r) => ({
        category: r.category,
        arm: r.arm,
        metric: r.metric,
        value: Math.round(r.value * 1000) / 1000,
        n: r.n,
      }));
      console.log("\n" + markdownTable(tableRows) + "\n");
    } else {
      console.log("(no score rows)");
    }

    // checks summary
    const failures = checks.filter((c) => !c.pass);
    const total = checks.length;
    const passed = total - failures.length;
    console.log(`checks ${passed}/${total}`);

    if (failures.length > 0) {
      logError(`  failed checks: ${failures.map((f) => f.name).join(", ")}`);
    }

    return failures.length > 0 ? 1 : 0;
  } finally {
    session.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

// ---------------------------------------------------------------------------
// CLI shell
// ---------------------------------------------------------------------------

if (
  typeof import.meta !== "undefined" &&
  import.meta.url === new URL(process.argv[1], "file://").href
) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
