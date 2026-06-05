import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractClaims, buildPrompt, EXTRACTION_MODEL, PROMPT_VERSION, validateCacheHeader, loadFileCache, NonRetryableLlmError, parseLlmClaims } from "./longmemeval.js";
import type { LmeQuestionT } from "../longmemeval/types.js";
import { ClaimRecord } from "../longmemeval/types.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function oneSessionFixture(
  sessionId = "session-1",
  date = "2024-03-15",
): LmeQuestionT["sessions"][number] {
  return {
    sessionId,
    date,
    turns: [
      { role: "user", content: "I moved to Berlin." },
      { role: "assistant", content: "Got it, I will remember that." },
    ],
  };
}

function oneQuestionFixture(opts: {
  sessionId?: string;
  date?: string;
} = {}): LmeQuestionT {
  return {
    question_id: "q1",
    question_type: "knowledge-update",
    question: "Where does the user live?",
    question_date: "2024-04-01",
    sessions: [oneSessionFixture(opts.sessionId ?? "session-1", opts.date ?? "2024-03-15")],
    answer_session_ids: ["session-1"],
  };
}

/** A valid LLM response for oneSessionFixture */
function validLlmResponse(): string {
  return JSON.stringify([
    { subject: "user", key: "city", value: "Berlin" },
  ]);
}

// ---------------------------------------------------------------------------
// Conservation: extracted + skipped === sessions
// ---------------------------------------------------------------------------

describe("conservation invariant", () => {
  it("counts a session as skipped after retries exhaust on malformed output", async () => {
    const llm = async () => "not json at all";
    const emitted: unknown[] = [];
    const skipped: string[] = [];
    const stats = await extractClaims(
      [oneQuestionFixture()],
      {
        has: () => false,
        emit: (r) => emitted.push(r),
        markSkipped: (id) => skipped.push(id),
      },
      { llm, maxRetries: 1, delayMs: 0 },
    );
    expect(stats.skipped).toBeGreaterThan(0);
    expect(stats.extracted + stats.skipped).toBe(stats.sessions);
  });

  it("counts session as extracted when llm returns valid output", async () => {
    const llm = async () => validLlmResponse();
    const emitted: unknown[] = [];
    const skipped: string[] = [];
    const stats = await extractClaims(
      [oneQuestionFixture()],
      {
        has: () => false,
        emit: (r) => emitted.push(r),
        markSkipped: (id) => skipped.push(id),
      },
      { llm, maxRetries: 1, delayMs: 0 },
    );
    expect(stats.extracted).toBe(1);
    expect(stats.skipped).toBe(0);
    expect(stats.extracted + stats.skipped).toBe(stats.sessions);
  });

  it("handles mixed: some sessions good, some bad", async () => {
    const goodSession = oneSessionFixture("session-good", "2024-01-01");
    const badSession = oneSessionFixture("session-bad", "2024-02-01");

    const q: LmeQuestionT = {
      question_id: "q-mixed",
      question_type: "knowledge-update",
      question: "Test?",
      question_date: "2024-05-01",
      sessions: [goodSession, badSession],
      answer_session_ids: [],
    };

    let callCount = 0;
    const llm = async (_prompt: string) => {
      callCount++;
      // Return valid JSON for first session, garbage for second
      if (callCount === 1) return validLlmResponse();
      return "GARBAGE";
    };

    const emitted: unknown[] = [];
    const skipped: string[] = [];
    const stats = await extractClaims(
      [q],
      {
        has: () => false,
        emit: (r) => emitted.push(r),
        markSkipped: (id) => skipped.push(id),
      },
      { llm, maxRetries: 0, delayMs: 0 },
    );

    expect(stats.extracted).toBe(1);
    expect(stats.skipped).toBe(1);
    expect(stats.extracted + stats.skipped).toBe(stats.sessions);
  });
});

// ---------------------------------------------------------------------------
// Resume: sessions where cache.has(id) is true are skipped
// ---------------------------------------------------------------------------

describe("resume / cache.has", () => {
  it("skips sessions already in cache without calling llm", async () => {
    const llm = vi.fn(async () => validLlmResponse());
    const emitted: unknown[] = [];
    const stats = await extractClaims(
      [oneQuestionFixture()],
      {
        has: () => true, // everything already cached
        emit: (r) => emitted.push(r),
        markSkipped: () => {},
      },
      { llm, maxRetries: 1, delayMs: 0 },
    );
    expect(llm).not.toHaveBeenCalled();
    expect(stats.extracted).toBe(0);
    expect(stats.sessions).toBe(1); // session counted even if cached
    expect(emitted).toHaveLength(0);
  });

  it("makes zero llm calls on a complete cache", async () => {
    const questions = [
      oneQuestionFixture({ sessionId: "s1" }),
      oneQuestionFixture({ sessionId: "s2" }),
    ];
    const llm = vi.fn(async () => validLlmResponse());
    const stats = await extractClaims(
      questions,
      {
        has: () => true,
        emit: () => {},
        markSkipped: () => {},
      },
      { llm, delayMs: 0 },
    );
    expect(llm).not.toHaveBeenCalled();
    expect(stats.sessions).toBe(2); // both unique sessions counted
  });

  it("deduplicates sessions that appear in multiple questions", async () => {
    // Same sessionId in two different questions → extracted only once
    const sharedSession = oneSessionFixture("shared-session");
    const q1: LmeQuestionT = {
      ...oneQuestionFixture(),
      question_id: "q1",
      sessions: [sharedSession],
    };
    const q2: LmeQuestionT = {
      ...oneQuestionFixture(),
      question_id: "q2",
      sessions: [sharedSession],
    };

    const llm = vi.fn(async () => validLlmResponse());
    const emitted: unknown[] = [];
    const stats = await extractClaims(
      [q1, q2],
      { has: () => false, emit: (r) => emitted.push(r), markSkipped: () => {} },
      { llm, delayMs: 0 },
    );

    expect(llm).toHaveBeenCalledTimes(1);
    expect(stats.sessions).toBe(1); // deduplicated
    expect(stats.extracted + stats.skipped).toBe(stats.sessions);
  });
});

// ---------------------------------------------------------------------------
// Provenance: emitted records must pass ClaimRecord.parse
// ---------------------------------------------------------------------------

describe("emitted record shape", () => {
  it("every emitted record passes ClaimRecord.parse", async () => {
    const llm = async () => validLlmResponse();
    const emitted: unknown[] = [];
    await extractClaims(
      [oneQuestionFixture()],
      {
        has: () => false,
        emit: (r) => emitted.push(r),
        markSkipped: () => {},
      },
      { llm, delayMs: 0 },
    );

    expect(emitted.length).toBeGreaterThan(0);
    for (const rec of emitted) {
      const result = ClaimRecord.safeParse(rec);
      expect(result.success).toBe(true);
    }
  });

  it("stamps session: and turn: provenance tags (not from llm)", async () => {
    // LLM returns claims with NO tags — the core must add them
    const llm = async () =>
      JSON.stringify([{ subject: "user", key: "city", value: "Berlin" }]);
    const emitted: unknown[] = [];
    await extractClaims(
      [oneQuestionFixture("sess-99", "2024-03-15")],
      {
        has: () => false,
        emit: (r) => emitted.push(r),
        markSkipped: () => {},
      },
      { llm, delayMs: 0 },
    );

    expect(emitted.length).toBeGreaterThan(0);
    const rec = emitted[0] as { tags: string[] };
    expect(rec.tags.some((t) => t.startsWith("session:"))).toBe(true);
    expect(rec.tags.some((t) => t.startsWith("turn:"))).toBe(true);
  });

  it("stamps validFrom from session date (epoch ms)", async () => {
    const llm = async () => validLlmResponse();
    const emitted: unknown[] = [];
    await extractClaims(
      [oneQuestionFixture("s1", "2024-03-15")],
      {
        has: () => false,
        emit: (r) => emitted.push(r),
        markSkipped: () => {},
      },
      { llm, delayMs: 0 },
    );

    const rec = emitted[0] as { validFrom: number };
    expect(Number.isNaN(rec.validFrom)).toBe(false);
    expect(rec.validFrom).toBe(Date.parse("2024-03-15"));
  });

  it("skips (not crashes) when session date is unparseable", async () => {
    const q = oneQuestionFixture();
    q.sessions[0].date = "not-a-date";
    const llm = async () => validLlmResponse();
    const emitted: unknown[] = [];
    const skipped: string[] = [];
    const stats = await extractClaims(
      [q],
      {
        has: () => false,
        emit: (r) => emitted.push(r),
        markSkipped: (id) => skipped.push(id),
      },
      { llm, delayMs: 0 },
    );

    // session with NaN date should be skipped, not crash
    expect(stats.skipped).toBe(1);
    expect(emitted).toHaveLength(0);
    expect(stats.extracted + stats.skipped).toBe(stats.sessions);
  });
});

// ---------------------------------------------------------------------------
// Retry with backoff
// ---------------------------------------------------------------------------

describe("retry backoff", () => {
  it("retries unparseable output at most once (not maxRetries times) before skipping", async () => {
    let callCount = 0;
    const llm = async () => {
      callCount++;
      return "not json";
    };

    const stats = await extractClaims(
      [oneQuestionFixture()],
      { has: () => false, emit: () => {}, markSkipped: () => {} },
      { llm, maxRetries: 3, delayMs: 0 },
    );

    // 1 initial attempt + 1 retry = 2 total calls (unparseable capped at 1 retry)
    expect(callCount).toBe(2);
    expect(stats.skipped).toBe(1);
  });

  it("emits (not skips) when valid output arrives on the one allowed retry", async () => {
    let callCount = 0;
    const llm = async () => {
      callCount++;
      if (callCount < 2) return "BAD JSON"; // fail once, succeed on retry
      return validLlmResponse();
    };

    const emitted: unknown[] = [];
    const stats = await extractClaims(
      [oneQuestionFixture()],
      { has: () => false, emit: (r) => emitted.push(r), markSkipped: () => {} },
      { llm, maxRetries: 3, delayMs: 0 },
    );

    // 1 failure + 1 retry = 2 calls
    expect(callCount).toBe(2);
    expect(stats.extracted).toBe(1);
    expect(stats.skipped).toBe(0);
    expect(emitted.length).toBeGreaterThan(0);
  });

  it("respects delayMs between retries (injectable sleep)", async () => {
    const delays: number[] = [];
    const fakeSleep = async (ms: number) => {
      delays.push(ms);
    };

    let callCount = 0;
    const llm = async () => {
      callCount++;
      return "BAD JSON";
    };

    await extractClaims(
      [oneQuestionFixture()],
      { has: () => false, emit: () => {}, markSkipped: () => {} },
      { llm, maxRetries: 2, delayMs: 100, sleep: fakeSleep },
    );

    // Unparseable is capped at 1 retry → 1 delay of 100ms (not 2)
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// buildPrompt
// ---------------------------------------------------------------------------

describe("buildPrompt", () => {
  it("includes the session id in the prompt", () => {
    const q = oneQuestionFixture("unique-session-id");
    const prompt = buildPrompt(q.sessions[0], "unique-session-id");
    expect(prompt).toContain("unique-session-id");
  });

  it("includes turn content in the prompt", () => {
    const q = oneQuestionFixture();
    const prompt = buildPrompt(q.sessions[0], q.sessions[0].sessionId);
    expect(prompt).toContain("I moved to Berlin");
  });

  it("asks for JSON array output", () => {
    const q = oneQuestionFixture();
    const prompt = buildPrompt(q.sessions[0], q.sessions[0].sessionId);
    // Prompt should instruct LLM to return JSON
    expect(prompt.toLowerCase()).toContain("json");
  });
});

// ---------------------------------------------------------------------------
// Constants exported
// ---------------------------------------------------------------------------

describe("exported constants", () => {
  it("EXTRACTION_MODEL is a non-empty string", () => {
    expect(typeof EXTRACTION_MODEL).toBe("string");
    expect(EXTRACTION_MODEL.length).toBeGreaterThan(0);
  });

  it("PROMPT_VERSION is a non-empty string", () => {
    expect(typeof PROMPT_VERSION).toBe("string");
    expect(PROMPT_VERSION.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Header pinning: validateCacheHeader
// ---------------------------------------------------------------------------

describe("validateCacheHeader", () => {
  function makeHeaderLine(model: string, promptVersion: string): string {
    return JSON.stringify({ kind: "lme-extraction-header", model, promptVersion });
  }

  it("accepts a header that matches the pinned constants", () => {
    const line = makeHeaderLine(EXTRACTION_MODEL, PROMPT_VERSION);
    // Should not throw
    expect(() => validateCacheHeader(line)).not.toThrow();
  });

  it("throws (and names both values) when model differs from EXTRACTION_MODEL", () => {
    const wrongModel = "some-other-model";
    const line = makeHeaderLine(wrongModel, PROMPT_VERSION);
    expect(() => validateCacheHeader(line)).toThrowError(
      new RegExp(`${wrongModel}.*${EXTRACTION_MODEL}|${EXTRACTION_MODEL}.*${wrongModel}`, "s"),
    );
  });

  it("throws (and names both values) when promptVersion differs from PROMPT_VERSION", () => {
    const wrongVersion = "lme-extract-v99";
    const line = makeHeaderLine(EXTRACTION_MODEL, wrongVersion);
    expect(() => validateCacheHeader(line)).toThrowError(
      new RegExp(`${wrongVersion}.*${PROMPT_VERSION}|${PROMPT_VERSION}.*${wrongVersion}`, "s"),
    );
  });

  it("throws when the header line is not valid JSON", () => {
    expect(() => validateCacheHeader("{not json")).toThrow();
  });

  it("throws when the header is valid JSON but not a cache header shape", () => {
    expect(() => validateCacheHeader(JSON.stringify({ foo: "bar" }))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Torn-write recovery: loadFileCache
// ---------------------------------------------------------------------------

describe("loadFileCache", () => {
  /** Build a real temp JSONL file and return its path */
  function makeTempCache(lines: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "lme-test-"));
    const filePath = join(dir, "cache.jsonl");
    writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
    return filePath;
  }

  function headerLine(): string {
    return JSON.stringify({ kind: "lme-extraction-header", model: EXTRACTION_MODEL, promptVersion: PROMPT_VERSION });
  }

  function claimLine(sessionId: string): string {
    return JSON.stringify({
      subject: "user",
      key: "city",
      value: "Berlin",
      validFrom: Date.parse("2024-03-15"),
      tags: [`session:${sessionId}`, "turn:0"],
    });
  }

  it("returns the set of extracted sessionIds from a clean cache", () => {
    const filePath = makeTempCache([headerLine(), claimLine("sess-A")]);
    const { extractedSessions } = loadFileCache(filePath);
    expect(extractedSessions.has("sess-A")).toBe(true);
  });

  it("returns empty set when only the header line is present", () => {
    const filePath = makeTempCache([headerLine()]);
    const { extractedSessions } = loadFileCache(filePath);
    expect(extractedSessions.size).toBe(0);
  });

  it("truncates the file when the last line is a torn write (invalid JSON)", () => {
    const filePath = makeTempCache([
      headerLine(),
      claimLine("sess-A"),
      '{"subject":"user","key":"city","value":"Berlin","validFrom":17', // truncated
    ]);

    const { extractedSessions } = loadFileCache(filePath);

    // sess-A is complete — it must be in the set
    expect(extractedSessions.has("sess-A")).toBe(true);

    // The file must now end at the last valid line (no partial JSON)
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    // Only header + sess-A line should remain
    expect(lines).toHaveLength(2);
    // Every line must be parseable JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("does NOT include the torn session in extractedSessions (so it will be re-extracted)", () => {
    const filePath = makeTempCache([
      headerLine(),
      claimLine("sess-A"),
      '{"subject":"user","key":"city","value":"Berlin","validFrom":17', // torn sess-B write
    ]);

    const { extractedSessions } = loadFileCache(filePath);

    // sess-A is done; torn sess-B is not in the set
    expect(extractedSessions.has("sess-A")).toBe(true);
    // sess-B was never completed, so it should NOT appear
    // (in practice the torn line had no session tag extracted, so the set size is 1)
    expect(extractedSessions.size).toBe(1);
  });

  it("works when there are multiple valid claim lines before the torn write", () => {
    const filePath = makeTempCache([
      headerLine(),
      claimLine("sess-A"),
      claimLine("sess-B"),
      '{"partial":true', // torn
    ]);

    const { extractedSessions } = loadFileCache(filePath);

    expect(extractedSessions.has("sess-A")).toBe(true);
    expect(extractedSessions.has("sess-B")).toBe(true);
    expect(extractedSessions.size).toBe(2);

    // File should be truncated to just header + 2 valid lines
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(3);
  });

  it("handles CRLF-terminated cache file: torn last line removed, all valid lines retained", () => {
    const dir = mkdtempSync(join(tmpdir(), "lme-test-crlf-"));
    const filePath = join(dir, "cache-crlf.jsonl");
    // Write file with CRLF line endings (as Windows tools might produce)
    const crlfContent = [headerLine(), claimLine("sess-A"), '{"partial":true'].join("\r\n") + "\r\n";
    writeFileSync(filePath, Buffer.from(crlfContent, "utf8"));

    const { extractedSessions } = loadFileCache(filePath);

    // sess-A is valid and should be retained
    expect(extractedSessions.has("sess-A")).toBe(true);

    // File should only have header + valid claim line
    const rawContent = readFileSync(filePath);
    const rawStr = rawContent.toString("utf8");
    // Split on LF to get lines (stripping \r from each)
    const lines = rawStr.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("after torn-write truncation, appending a new JSONL line yields no concatenated lines", () => {
    const filePath = makeTempCache([
      headerLine(),
      claimLine("sess-A"),
      '{"partial":true', // torn write
    ]);

    // Perform truncation recovery
    loadFileCache(filePath);

    // Append a new valid line (the way the real CLI does it)
    appendFileSync(filePath, claimLine("sess-B") + "\n", "utf8");

    // Now verify every line in the file is valid JSON and no lines are concatenated
    const finalContent = readFileSync(filePath, "utf8");
    const lines = finalContent.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(3); // header + sess-A + sess-B
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    // sess-B must be a standalone JSON object (not concatenated with previous line)
    const lastLine = lines[lines.length - 1];
    expect(JSON.parse(lastLine)).toMatchObject({ tags: expect.arrayContaining(["session:sess-B"]) });
  });
});

// ---------------------------------------------------------------------------
// NonRetryableLlmError: class export and behavior
// ---------------------------------------------------------------------------

describe("NonRetryableLlmError", () => {
  it("is an instance of Error", () => {
    const err = new NonRetryableLlmError("billing error", 400);
    expect(err).toBeInstanceOf(Error);
  });

  it("carries the status code", () => {
    const err = new NonRetryableLlmError("auth failed", 401);
    expect(err.status).toBe(401);
  });

  it("carries the message", () => {
    const err = new NonRetryableLlmError("credit balance is too low", 400);
    expect(err.message).toBe("credit balance is too low");
  });

  it("is an instance of NonRetryableLlmError (named class, not plain Error)", () => {
    const err = new NonRetryableLlmError("test", 403);
    expect(err instanceof NonRetryableLlmError).toBe(true);
    expect(err.name).toBe("NonRetryableLlmError");
  });
});

// ---------------------------------------------------------------------------
// extractClaims fail-fast on NonRetryableLlmError
// ---------------------------------------------------------------------------

describe("extractClaims fail-fast on NonRetryableLlmError", () => {
  it("re-throws NonRetryableLlmError immediately without retrying (llm called exactly once)", async () => {
    let callCount = 0;
    const llm = async () => {
      callCount++;
      throw new NonRetryableLlmError("Anthropic API error: 400 Bad Request – credit balance is too low", 400);
    };

    await expect(
      extractClaims(
        [oneQuestionFixture()],
        { has: () => false, emit: () => {}, markSkipped: () => {} },
        { llm, maxRetries: 3, delayMs: 0 },
      ),
    ).rejects.toBeInstanceOf(NonRetryableLlmError);

    // Must not retry — only one call
    expect(callCount).toBe(1);
  });

  it("does not process subsequent sessions after NonRetryableLlmError", async () => {
    const sessions = [
      oneSessionFixture("sess-1", "2024-01-01"),
      oneSessionFixture("sess-2", "2024-02-01"),
    ];
    const q: LmeQuestionT = {
      question_id: "q1",
      question_type: "knowledge-update",
      question: "Test?",
      question_date: "2024-05-01",
      sessions,
      answer_session_ids: [],
    };

    let callCount = 0;
    const llm = async () => {
      callCount++;
      throw new NonRetryableLlmError("credit balance is too low", 400);
    };

    await expect(
      extractClaims(
        [q],
        { has: () => false, emit: () => {}, markSkipped: () => {} },
        { llm, maxRetries: 2, delayMs: 0 },
      ),
    ).rejects.toBeInstanceOf(NonRetryableLlmError);

    // Only one LLM call total — second session never attempted
    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// extractClaims skipReasons tracking
// ---------------------------------------------------------------------------

describe("extractClaims skipReasons in stats", () => {
  it("includes skipReasons field in returned stats", async () => {
    const llm = async () => validLlmResponse();
    const stats = await extractClaims(
      [oneQuestionFixture()],
      { has: () => false, emit: () => {}, markSkipped: () => {} },
      { llm, delayMs: 0 },
    );
    expect(stats).toHaveProperty("skipReasons");
    expect(typeof stats.skipReasons).toBe("object");
  });

  it("records nan-date in skipReasons when session date is unparseable", async () => {
    const q = oneQuestionFixture();
    q.sessions[0].date = "not-a-date";
    const llm = async () => validLlmResponse();
    const stats = await extractClaims(
      [q],
      { has: () => false, emit: () => {}, markSkipped: () => {} },
      { llm, delayMs: 0 },
    );
    expect(stats.skipReasons["nan-date"]).toBe(1);
  });

  it("records llm-error bucket in skipReasons when llm throws retryable error", async () => {
    const errorMsg = "Anthropic API error: 429 Too Many Requests";
    const llm = async () => {
      throw new Error(errorMsg);
    };
    const stats = await extractClaims(
      [oneQuestionFixture()],
      { has: () => false, emit: () => {}, markSkipped: () => {} },
      { llm, maxRetries: 1, delayMs: 0 },
    );
    // Should have an llm-error entry for the retryable error
    const llmErrorKey = Object.keys(stats.skipReasons).find((k) => k.startsWith("llm-error:"));
    expect(llmErrorKey).toBeDefined();
    expect(stats.skipReasons[llmErrorKey!]).toBeGreaterThan(0);
    // Message should appear (truncated to ~80 chars)
    expect(llmErrorKey).toContain("Anthropic API error: 429");
  });

  it("records unparseable-response in skipReasons when llm returns invalid JSON", async () => {
    const llm = async () => "not json";
    const stats = await extractClaims(
      [oneQuestionFixture()],
      { has: () => false, emit: () => {}, markSkipped: () => {} },
      { llm, maxRetries: 0, delayMs: 0 },
    );
    expect(stats.skipReasons["unparseable-response"]).toBe(1);
  });

  it("accumulates multiple nan-date skips", async () => {
    const q1 = oneQuestionFixture({ sessionId: "s1" });
    q1.sessions[0].date = "INVALID_DATE_1";
    const q2 = oneQuestionFixture({ sessionId: "s2" });
    q2.sessions[0].date = "INVALID_DATE_2";

    const llm = async () => validLlmResponse();
    const stats = await extractClaims(
      [q1, q2],
      { has: () => false, emit: () => {}, markSkipped: () => {} },
      { llm, delayMs: 0 },
    );
    expect(stats.skipReasons["nan-date"]).toBe(2);
  });

  it("returns empty skipReasons when all sessions extracted successfully", async () => {
    const llm = async () => validLlmResponse();
    const stats = await extractClaims(
      [oneQuestionFixture()],
      { has: () => false, emit: () => {}, markSkipped: () => {} },
      { llm, delayMs: 0 },
    );
    expect(Object.keys(stats.skipReasons)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Existing stats assertions updated to include skipReasons
// ---------------------------------------------------------------------------
// (The existing tests use individual field access, not whole-object equality,
// so they should pass after the skipReasons field is added to ExtractStats.
// The tests below confirm whole-object shape for completeness.)

// ---------------------------------------------------------------------------
// parseLlmClaims — Fix 2: lenient response parsing
// ---------------------------------------------------------------------------

describe("parseLlmClaims", () => {
  it("parses a bare JSON array", () => {
    const result = parseLlmClaims(
      JSON.stringify([{ subject: "user", key: "city", value: "Berlin" }]),
    );
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({ subject: "user", key: "city", value: "Berlin" });
  });

  it("parses an object wrapper with claims key", () => {
    const result = parseLlmClaims(
      JSON.stringify({ claims: [{ subject: "user", key: "job", value: "engineer" }] }),
    );
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({ subject: "user", key: "job", value: "engineer" });
  });

  it("parses a markdown-fenced JSON array", () => {
    const fenced = "```json\n[{\"subject\":\"user\",\"key\":\"city\",\"value\":\"Berlin\"}]\n```";
    const result = parseLlmClaims(fenced);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({ subject: "user", key: "city", value: "Berlin" });
  });

  it("parses a markdown-fenced object wrapper", () => {
    const fenced = "```json\n{\"claims\":[{\"subject\":\"user\",\"key\":\"job\",\"value\":\"engineer\"}]}\n```";
    const result = parseLlmClaims(fenced);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({ subject: "user", key: "job", value: "engineer" });
  });

  it("falls back to bracket-slice when there is leading prose", () => {
    const prose =
      'Here are the claims:\n[{"subject":"user","key":"city","value":"Berlin"}]';
    const result = parseLlmClaims(prose);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({ subject: "user", key: "city", value: "Berlin" });
  });

  it("falls back to brace-slice when response is object-wrapped with prose prefix", () => {
    const prose =
      'Here are the claims:\n{"claims":[{"subject":"user","key":"city","value":"Berlin"}]}';
    const result = parseLlmClaims(prose);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({ subject: "user", key: "city", value: "Berlin" });
  });

  it("returns null for a genuinely unparseable string", () => {
    expect(parseLlmClaims("not json at all")).toBeNull();
    expect(parseLlmClaims("")).toBeNull();
    expect(parseLlmClaims("{ broken json")).toBeNull();
  });

  it("drops invalid elements and keeps valid ones", () => {
    const mixed = JSON.stringify([
      { subject: "user", key: "city", value: "Berlin" },
      { subject: "user" }, // missing key and value
      { subject: "user", key: "job", value: "engineer" },
    ]);
    const result = parseLlmClaims(mixed);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
  });

  it("returns empty array for an empty array input", () => {
    const result = parseLlmClaims("[]");
    expect(result).not.toBeNull();
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extractClaims: lenient parsing handles fenced and object-wrapped responses
// ---------------------------------------------------------------------------

describe("extractClaims with lenient parsing", () => {
  it("succeeds when mock llm returns a fenced JSON array", async () => {
    const llm = async () =>
      "```json\n[{\"subject\":\"user\",\"key\":\"city\",\"value\":\"Berlin\"}]\n```";
    const emitted: unknown[] = [];
    const stats = await extractClaims(
      [oneQuestionFixture()],
      { has: () => false, emit: (r) => emitted.push(r), markSkipped: () => {} },
      { llm, delayMs: 0 },
    );
    expect(stats.extracted).toBe(1);
    expect(stats.skipped).toBe(0);
    expect(emitted).toHaveLength(1);
  });

  it("succeeds when mock llm returns object-wrapped claims", async () => {
    const llm = async () =>
      JSON.stringify({ claims: [{ subject: "user", key: "city", value: "Berlin" }] });
    const emitted: unknown[] = [];
    const stats = await extractClaims(
      [oneQuestionFixture()],
      { has: () => false, emit: (r) => emitted.push(r), markSkipped: () => {} },
      { llm, delayMs: 0 },
    );
    expect(stats.extracted).toBe(1);
    expect(stats.skipped).toBe(0);
    expect(emitted).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Fix 3: unparseable-response retried at most ONCE (not maxRetries times)
// ---------------------------------------------------------------------------

describe("unparseable-response retry cap", () => {
  it("retries unparseable response at most once (llm called at most 2 times)", async () => {
    let callCount = 0;
    const llm = async () => {
      callCount++;
      return "not json at all — deterministic formatting failure";
    };

    const stats = await extractClaims(
      [oneQuestionFixture()],
      { has: () => false, emit: () => {}, markSkipped: () => {} },
      { llm, maxRetries: 5, delayMs: 0 }, // maxRetries=5 but unparseable should cap at 1 retry
    );

    // 1 initial attempt + 1 retry = 2 total calls (not 6)
    expect(callCount).toBe(2);
    expect(stats.skipped).toBe(1);
    expect(stats.skipReasons["unparseable-response"]).toBe(1);
  });

  it("still retries llm-errors up to maxRetries times", async () => {
    let callCount = 0;
    const llm = async () => {
      callCount++;
      throw new Error("429 Too Many Requests");
    };

    await extractClaims(
      [oneQuestionFixture()],
      { has: () => false, emit: () => {}, markSkipped: () => {} },
      { llm, maxRetries: 3, delayMs: 0 },
    );

    // 1 initial + 3 retries = 4 total calls (no cap on retryable errors)
    expect(callCount).toBe(4);
  });
});
