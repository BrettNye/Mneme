/**
 * LongMemEval → claims JSONL converter.
 *
 * Core is pure (no I/O): takes an injected `llm` function so tests are
 * network-free.  The CLI shell at the bottom owns fs/fetch/env.
 *
 * Usage (CLI):
 *   npx tsx bench/convert/longmemeval.ts --in <dataset.json> --out <claims.jsonl>
 */
import { z } from "zod";
import {
  ClaimRecord,
  type ClaimRecordT,
  type LmeQuestionT,
  CacheHeader,
} from "../longmemeval/types.js";
import { readFileSync as _readFileSync, truncateSync as _truncateSync } from "node:fs";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const EXTRACTION_MODEL = "claude-sonnet-4-6";
export const PROMPT_VERSION = "lme-extract-v1";

// ---------------------------------------------------------------------------
// NonRetryableLlmError
// ---------------------------------------------------------------------------

/**
 * Thrown by the LLM function for HTTP 400/401/403 responses (billing, auth,
 * permission errors). Catching this in extractClaims causes an immediate
 * re-throw — no retries, no skipping.
 */
export class NonRetryableLlmError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "NonRetryableLlmError";
    this.status = status;
    // Maintain correct prototype chain in compiled JS
    Object.setPrototypeOf(this, NonRetryableLlmError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ExtractDeps {
  llm: (prompt: string) => Promise<string>;
  maxRetries?: number;  // default 2
  delayMs?: number;     // base delay ms for exponential backoff (default 1000)
  sleep?: (ms: number) => Promise<void>; // injectable for tests (default real setTimeout)
}

export interface ExtractCache {
  has(sessionId: string): boolean;
  emit(rec: ClaimRecordT): void;
  markSkipped(sessionId: string): void;
}

export interface ExtractStats {
  sessions: number;
  extracted: number;
  skipped: number;
  claims: number;
  /**
   * Breakdown of why sessions were skipped.
   * Keys: "nan-date", "unparseable-response", "llm-error: <msg truncated to 80 chars>"
   */
  skipReasons: Record<string, number>;
}

// ---------------------------------------------------------------------------
// buildPrompt: build LLM extraction prompt for a single session
// ---------------------------------------------------------------------------

export function buildPrompt(
  session: LmeQuestionT["sessions"][number],
  sessionId: string,
): string {
  const turnLines = session.turns
    .map(
      (t, i) => `[turn:${i}] ${t.role.toUpperCase()}: ${t.content}`,
    )
    .join("\n");

  return `You are an information extraction assistant.

Extract factual claims from the following conversation session (session id: ${sessionId}, date: ${session.date}).

Each claim must be a JSON object with exactly three string fields:
  - "subject": who or what the claim is about (e.g. "user")
  - "key": the attribute or fact type (e.g. "city", "job", "preference")
  - "value": the value (e.g. "Berlin", "engineer", "coffee")

Return ONLY a JSON array of these objects. Do not include any other text, markdown, or explanation.
If there are no extractable facts, return an empty JSON array: []

Session conversation:
${turnLines}

JSON array of claims:`;
}

// ---------------------------------------------------------------------------
// LLM response schema
// ---------------------------------------------------------------------------

const LlmClaim = z.object({
  subject: z.string(),
  key: z.string(),
  value: z.string(),
});

type LlmClaimT = z.infer<typeof LlmClaim>;

// ---------------------------------------------------------------------------
// extractClaims: pure core
// ---------------------------------------------------------------------------

export async function extractClaims(
  questions: LmeQuestionT[],
  cache: ExtractCache,
  deps: ExtractDeps,
): Promise<ExtractStats> {
  const {
    llm,
    maxRetries = 2,
    delayMs = 1000,
    sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = deps;

  // Deduplicate sessions across all questions by sessionId
  const sessionMap = new Map<string, LmeQuestionT["sessions"][number]>();
  for (const q of questions) {
    for (const session of q.sessions) {
      if (!sessionMap.has(session.sessionId)) {
        sessionMap.set(session.sessionId, session);
      }
    }
  }

  const stats: ExtractStats = {
    sessions: sessionMap.size,
    extracted: 0,
    skipped: 0,
    claims: 0,
    skipReasons: {},
  };

  /** Increment a skip-reason bucket by key */
  const bumpReason = (key: string) => {
    stats.skipReasons[key] = (stats.skipReasons[key] ?? 0) + 1;
  };

  /** Track which llm-error reasons have been logged to stderr (first-occurrence) */
  const loggedLlmErrors = new Set<string>();

  for (const [sessionId, session] of sessionMap) {
    // Skip already-cached sessions
    if (cache.has(sessionId)) {
      continue;
    }

    // Guard: parse the session date up front — NaN date means skip
    const validFrom = Date.parse(session.date);
    if (Number.isNaN(validFrom)) {
      cache.markSkipped(sessionId);
      stats.skipped++;
      bumpReason("nan-date");
      continue;
    }

    // Build prompt
    const prompt = buildPrompt(session, sessionId);

    // Retry loop
    let extracted = false;
    // Track per-session skip reason to record after exhausting retries
    let sessionSkipReason: string | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const waitMs = delayMs * Math.pow(2, attempt - 1);
        await sleep(waitMs);
      }

      let raw: string;
      try {
        raw = await llm(prompt);
      } catch (err) {
        // Non-retryable errors (billing, auth, permission): re-throw immediately
        if (err instanceof NonRetryableLlmError) {
          throw err;
        }
        // Retryable error: bucket it and try again
        const errMsg = (err instanceof Error ? err.message : String(err)).slice(0, 80);
        const reasonKey = `llm-error: ${errMsg}`;
        if (!loggedLlmErrors.has(reasonKey)) {
          loggedLlmErrors.add(reasonKey);
          console.error(`[extractClaims] LLM error (first occurrence): ${reasonKey}`);
        }
        sessionSkipReason = reasonKey;
        continue;
      }

      // Parse LLM response
      let parsed: LlmClaimT[];
      try {
        const jsonVal = JSON.parse(raw);
        if (!Array.isArray(jsonVal)) {
          sessionSkipReason = "unparseable-response";
          continue;
        }
        // Validate each element
        const results = jsonVal.map((item: unknown) => LlmClaim.safeParse(item));
        const valid = results
          .filter((r): r is { success: true; data: LlmClaimT } => r.success)
          .map((r) => r.data);
        parsed = valid;
      } catch {
        sessionSkipReason = "unparseable-response";
        continue;
      }

      for (const rawClaim of parsed) {
        // Build the record with provenance; use turn:0 as the canonical provenance
        // (turn:0 is the first turn — the simplest conservative attribution)
        const record = {
          subject: rawClaim.subject,
          key: rawClaim.key,
          value: rawClaim.value,
          validFrom,
          tags: [`session:${sessionId}`, "turn:0"],
        };

        // Validate via ClaimRecord.parse before emitting
        const parseResult = ClaimRecord.safeParse(record);
        if (!parseResult.success) {
          // Skip this particular claim but don't fail the whole session
          continue;
        }
        cache.emit(parseResult.data);
        stats.claims++;
      }

      extracted = true;
      break;
    }

    if (extracted) {
      stats.extracted++;
    } else {
      cache.markSkipped(sessionId);
      stats.skipped++;
      if (sessionSkipReason !== null) {
        bumpReason(sessionSkipReason);
      }
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// File-cache utilities (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Validate a JSONL header line against the pinned model/promptVersion constants.
 *
 * Throws a descriptive Error naming both the existing value and the expected
 * constant if either field mismatches, so the operator knows what changed.
 * Also throws if the line is not valid JSON or not a well-formed cache header.
 */
export function validateCacheHeader(headerLine: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(headerLine);
  } catch {
    throw new Error(
      `Cache header line is not valid JSON: ${headerLine}`,
    );
  }

  const result = CacheHeader.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Cache header line does not match expected shape: ${headerLine}`,
    );
  }

  const header = result.data;
  if (header.model !== EXTRACTION_MODEL || header.promptVersion !== PROMPT_VERSION) {
    throw new Error(
      `Cache header mismatch. ` +
        `Existing: model=${header.model}, promptVersion=${header.promptVersion}. ` +
        `Expected: model=${EXTRACTION_MODEL}, promptVersion=${PROMPT_VERSION}. ` +
        "Delete the cache file or update the constants.",
    );
  }
}

/**
 * Load a file-backed extraction cache.
 *
 * - Validates the header line via `validateCacheHeader` (throws on mismatch).
 * - Scans subsequent lines to build the set of already-extracted session IDs.
 * - If the last line is not valid JSON (torn write), truncates the file back to
 *   the last complete valid line so the partial session will be re-extracted.
 *
 * Returns `{ extractedSessions }`: the set of sessionIds that are complete.
 */
export function loadFileCache(filePath: string): { extractedSessions: Set<string> } {
  return _loadFileCacheWithFs(filePath, (p) => _readFileSync(p) as Buffer, _truncateSync);
}

/**
 * Testable core of loadFileCache: inject fs operations so tests can use the
 * real filesystem without relying on `require` being available in all runtimes.
 *
 * Reads the file as a raw Buffer to get unambiguous byte positions on every
 * platform (no CRLF encoding drift). JSON.parse receives each line with the
 * optional trailing \r stripped so both LF and CRLF files parse correctly.
 * Byte offsets always come from raw buffer positions, so truncateSync cuts
 * exactly at the byte just past the last valid line's \n — leaving the file
 * properly terminated for subsequent appendFileSync calls.
 *
 * @internal exported for testing only
 */
function _loadFileCacheWithFs(
  filePath: string,
  readFileSync: (path: string) => Buffer,
  truncateSync: (path: string, len: number) => void,
): { extractedSessions: Set<string> } {
  const buf = readFileSync(filePath);

  // Split raw buffer into lines at each \n boundary.
  // For each line we record: start byte offset, end byte offset (exclusive,
  // i.e. the index of the \n or buf.length if no trailing \n), and the
  // string content with any trailing \r stripped for JSON parsing.
  const lines: Array<{ start: number; afterNewline: number; text: string }> = [];
  let lineStart = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === 0x0a /* \n */) {
      const lineEnd = i; // exclusive, points at \n (or past end)
      // Strip trailing \r for string form
      let textEnd = lineEnd;
      if (textEnd > lineStart && buf[textEnd - 1] === 0x0d /* \r */) {
        textEnd--;
      }
      const text = buf.slice(lineStart, textEnd).toString("utf8");
      // afterNewline = byte offset just past the \n (= start of next line)
      const afterNewline = i < buf.length ? i + 1 : i;
      lines.push({ start: lineStart, afterNewline, text });
      lineStart = i + 1;
    }
  }

  // Validate header (throws on mismatch)
  const headerLine = lines[0]?.text ?? "";
  validateCacheHeader(headerLine);

  const extractedSessions = new Set<string>();

  // lastValidTruncPoint: byte offset to which we would truncate if we
  // encounter a torn write. This is the afterNewline of the last valid line —
  // i.e., the file is left with a trailing \n after that line, ready for append.
  let lastValidTruncPoint = lines[0]?.afterNewline ?? 0;

  for (let i = 1; i < lines.length; i++) {
    const { afterNewline, text } = lines[i];

    // Skip blank lines (trailing newline at end of file produces an empty line)
    if (!text.trim()) {
      continue;
    }

    try {
      const parsed = JSON.parse(text) as { tags?: string[] };
      if (parsed.tags) {
        for (const tag of parsed.tags) {
          if (tag.startsWith("session:")) {
            extractedSessions.add(tag.slice("session:".length));
          }
        }
      }
      // Line parsed OK: advance the truncation checkpoint to just past its \n
      lastValidTruncPoint = afterNewline;
    } catch {
      // Torn write: this line is not valid JSON.
      // Truncate the file to the byte just past the last valid line's \n,
      // so the file is properly newline-terminated and ready for append.
      truncateSync(filePath, lastValidTruncPoint);
      break;
    }
  }

  return { extractedSessions };
}

// ---------------------------------------------------------------------------
// CLI shell — only place that touches fs / fetch / env
// ---------------------------------------------------------------------------

// Main guard: only run CLI when invoked directly
import { pathToFileURL } from "node:url";

if (
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runCli();
}

async function runCli(): Promise<void> {
  const { parseArgs } = await import("node:util");
  const { readFileSync, appendFileSync, existsSync, truncateSync } = await import("node:fs");

  const { values } = parseArgs({
    options: {
      in: { type: "string" },
      out: { type: "string" },
    },
  });

  if (!values.in || !values.out) {
    console.error("usage: longmemeval.ts --in <dataset.json> --out <claims.jsonl>");
    process.exit(1);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(
      "Missing ANTHROPIC_API_KEY environment variable. " +
        "Set it before running the converter.",
    );
    process.exit(1);
  }

  // Build real LLM function using Anthropic Messages API
  const realLlm = async (prompt: string): Promise<string> => {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: EXTRACTION_MODEL,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) {
      const status = response.status;
      // Attempt to extract the API's error message from the response body
      let apiMsg = `${response.status} ${response.statusText}`;
      try {
        const errBody = await response.json() as { error?: { message?: string } };
        if (errBody?.error?.message) {
          apiMsg = errBody.error.message;
        }
      } catch {
        // ignore body parse failure; use status text
      }
      const fullMsg = `Anthropic API error: ${apiMsg}`;
      // 400/401/403 are non-retryable (billing, auth, permission)
      if (status === 400 || status === 401 || status === 403) {
        throw new NonRetryableLlmError(fullMsg, status);
      }
      throw new Error(fullMsg);
    }
    const data = (await response.json()) as {
      content: Array<{ type: string; text: string }>;
    };
    const textBlock = data.content.find((b) => b.type === "text");
    if (!textBlock) throw new Error("No text block in Anthropic response");
    return textBlock.text;
  };

  // Load dataset
  let questions: LmeQuestionT[];
  try {
    const raw = JSON.parse(readFileSync(values.in, "utf8")) as unknown[];
    const { normalizeQuestion } = await import("../longmemeval/types.js");
    questions = raw.map(normalizeQuestion);
  } catch (err) {
    console.error(`Failed to load dataset: ${(err as Error).message}`);
    process.exit(1);
  }

  const outPath = values.out;
  const isResume = existsSync(outPath);

  // Build file-backed cache
  let extractedSessions = new Set<string>();

  if (isResume) {
    // Validate header and load extracted session set, recovering from torn writes.
    // validateCacheHeader (called inside _loadFileCacheWithFs) will process.exit if header mismatches.
    try {
      ({ extractedSessions } = _loadFileCacheWithFs(outPath, (p) => readFileSync(p) as Buffer, truncateSync));
    } catch (err) {
      console.error(`Cache resume failed: ${(err as Error).message}`);
      process.exit(1);
    }
  } else {
    // Fresh run: write header
    const header = {
      kind: "lme-extraction-header" as const,
      model: EXTRACTION_MODEL,
      promptVersion: PROMPT_VERSION,
    };
    appendFileSync(outPath, JSON.stringify(header) + "\n", "utf8");
  }

  const fileCache: ExtractCache = {
    has: (sessionId) => extractedSessions.has(sessionId),
    emit: (rec) => {
      appendFileSync(outPath, JSON.stringify(rec) + "\n", "utf8");
      const sessionTag = rec.tags.find((t) => t.startsWith("session:"));
      if (sessionTag) {
        extractedSessions.add(sessionTag.slice("session:".length));
      }
    },
    markSkipped: (_sessionId) => {
      // Skipped sessions are not written to cache; they will be re-tried on next resume
    },
  };

  console.log(
    `Starting extraction: ${questions.length} questions, ` +
      `${isResume ? "resuming" : "fresh run"}`,
  );

  let stats;
  try {
    stats = await extractClaims(questions, fileCache, {
      llm: realLlm,
      maxRetries: 2,
    });
  } catch (err) {
    if (err instanceof NonRetryableLlmError) {
      console.error(`Fatal LLM error (non-retryable, status ${err.status}): ${err.message}`);
      console.error("Aborting — fix the API key / billing issue and re-run.");
      process.exit(1);
    }
    throw err;
  }

  console.log(
    `Done: sessions=${stats.sessions} extracted=${stats.extracted} ` +
      `skipped=${stats.skipped} claims=${stats.claims}`,
  );
  console.log(
    `Conservation check: ${stats.extracted + stats.skipped} === ${stats.sessions}: ` +
      `${stats.extracted + stats.skipped === stats.sessions ? "PASS" : "FAIL"}`,
  );

  if (stats.skipped > 0 && Object.keys(stats.skipReasons).length > 0) {
    console.log("Skip reasons breakdown:");
    for (const [reason, count] of Object.entries(stats.skipReasons)) {
      console.log(`  ${reason}: ${count}`);
    }
  }

  process.exit(stats.extracted + stats.skipped === stats.sessions ? 0 : 1);
}
