import { describe, it, expect, vi } from "vitest";
import { extractClaims, buildPrompt, EXTRACTION_MODEL, PROMPT_VERSION } from "./longmemeval.js";
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
  it("retries up to maxRetries times on malformed output before skipping", async () => {
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

    // 1 initial attempt + 3 retries = 4 total calls
    expect(callCount).toBe(4);
    expect(stats.skipped).toBe(1);
  });

  it("emits (not skips) when valid output arrives after retry", async () => {
    let callCount = 0;
    const llm = async () => {
      callCount++;
      if (callCount < 3) return "BAD JSON";
      return validLlmResponse();
    };

    const emitted: unknown[] = [];
    const stats = await extractClaims(
      [oneQuestionFixture()],
      { has: () => false, emit: (r) => emitted.push(r), markSkipped: () => {} },
      { llm, maxRetries: 3, delayMs: 0 },
    );

    expect(callCount).toBe(3);
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

    // 2 retries → 2 delays; exponential: 100ms, 200ms
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBe(100);
    expect(delays[1]).toBe(200);
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
