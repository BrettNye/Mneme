import { describe, it, expect } from "vitest";
import { ClaimRecord, CacheHeader, LmeQuestion, categoryOf, normalizeQuestion, parseLmeInstant, endOfUtcDay } from "./types.js";

// ---------------------------------------------------------------------------
// parseLmeInstant
// ---------------------------------------------------------------------------

describe("parseLmeInstant", () => {
  it("parses canonical format '2023/05/28 (Sun) 06:47' to exact UTC epoch", () => {
    const result = parseLmeInstant("2023/05/28 (Sun) 06:47");
    expect(result).toBe(new Date("2023-05-28T06:47:00Z").getTime());
  });

  it("parses '2023/06/01 (Thu) 10:00' to exact UTC epoch", () => {
    const result = parseLmeInstant("2023/06/01 (Thu) 10:00");
    expect(result).toBe(new Date("2023-06-01T10:00:00Z").getTime());
  });

  it("throws naming the raw string on garbage input", () => {
    expect(() => parseLmeInstant("not-a-date")).toThrow("not-a-date");
  });

  it("throws when time component is missing (date-only)", () => {
    expect(() => parseLmeInstant("2023/05/28")).toThrow("2023/05/28");
  });

  it("throws when date is missing but time is present", () => {
    expect(() => parseLmeInstant("06:47")).toThrow("06:47");
  });

  it("throws naming the raw string when result would be NaN", () => {
    const raw = "2023/99/99 25:99";
    expect(() => parseLmeInstant(raw)).toThrow(raw);
  });
});

// ---------------------------------------------------------------------------
// endOfUtcDay
// ---------------------------------------------------------------------------

describe("endOfUtcDay", () => {
  it("mid-day input returns 23:59:59.999Z of the same UTC day", () => {
    const midDay = new Date("2023-05-28T12:30:00Z").getTime();
    const result = endOfUtcDay(midDay);
    expect(result).toBe(new Date("2023-05-28T23:59:59.999Z").getTime());
  });

  it("is idempotent: end-of-day input returns same end-of-day value", () => {
    const endOfDay = new Date("2023-05-28T23:59:59.999Z").getTime();
    const result = endOfUtcDay(endOfDay);
    expect(result).toBe(new Date("2023-05-28T23:59:59.999Z").getTime());
  });

  it("start-of-day input returns 23:59:59.999Z of the same UTC day", () => {
    const startOfDay = new Date("2023-06-01T00:00:00.000Z").getTime();
    const result = endOfUtcDay(startOfDay);
    expect(result).toBe(new Date("2023-06-01T23:59:59.999Z").getTime());
  });
});

describe("ClaimRecord", () => {
  it("rejects a claim record without turn: tag", () => {
    const r = ClaimRecord.safeParse({
      subject: "user", key: "city", value: "Paris", validFrom: 1, tags: ["session:s1"],
    });
    expect(r.success).toBe(false); // no turn: tag
  });

  it("passes when both session: and turn: tags are present", () => {
    const r = ClaimRecord.safeParse({
      subject: "user",
      key: "city",
      value: "Paris",
      validFrom: 1,
      tags: ["session:s1", "turn:3"],
    });
    expect(r.success).toBe(true);
  });

  it("rejects when session: tag is missing", () => {
    const r = ClaimRecord.safeParse({
      subject: "user",
      key: "city",
      value: "Paris",
      validFrom: 1,
      tags: ["turn:3"],
    });
    expect(r.success).toBe(false);
  });

  it("rejects when both tags are missing", () => {
    const r = ClaimRecord.safeParse({
      subject: "user",
      key: "city",
      value: "Paris",
      validFrom: 1,
      tags: [],
    });
    expect(r.success).toBe(false);
  });

  it("accepts optional confidence field", () => {
    const r = ClaimRecord.safeParse({
      subject: "user",
      key: "city",
      value: "Paris",
      validFrom: 1,
      confidence: 0.9,
      tags: ["session:s1", "turn:0"],
    });
    expect(r.success).toBe(true);
  });

  it("rejects confidence out of range", () => {
    const r = ClaimRecord.safeParse({
      subject: "user",
      key: "city",
      value: "Paris",
      validFrom: 1,
      confidence: 1.5,
      tags: ["session:s1", "turn:0"],
    });
    expect(r.success).toBe(false);
  });
});

describe("CacheHeader", () => {
  it("accepts a valid header", () => {
    const r = CacheHeader.safeParse({
      kind: "lme-extraction-header",
      model: "gpt-4o",
      promptVersion: "v1",
    });
    expect(r.success).toBe(true);
  });

  it("rejects when kind is wrong", () => {
    const r = CacheHeader.safeParse({
      kind: "something-else",
      model: "gpt-4o",
      promptVersion: "v1",
    });
    expect(r.success).toBe(false);
  });

  it("rejects when kind is missing", () => {
    const r = CacheHeader.safeParse({
      model: "gpt-4o",
      promptVersion: "v1",
    });
    expect(r.success).toBe(false);
  });
});

describe("categoryOf", () => {
  it("returns abstention for _abs-suffixed question_id", () => {
    const q = LmeQuestion.parse({
      question_id: "q42_abs",
      question_type: "knowledge-update",
      question: "What?",
      question_date: "2024-01-01",
      sessions: [],
      answer_session_ids: [],
    });
    expect(categoryOf(q)).toBe("abstention");
  });

  it("returns knowledge-update for knowledge-update question_type", () => {
    const q = LmeQuestion.parse({
      question_id: "q10",
      question_type: "knowledge-update",
      question: "What?",
      question_date: "2024-01-01",
      sessions: [],
      answer_session_ids: [],
    });
    expect(categoryOf(q)).toBe("knowledge-update");
  });

  it("returns temporal-reasoning for temporal-reasoning question_type", () => {
    const q = LmeQuestion.parse({
      question_id: "q20",
      question_type: "temporal-reasoning",
      question: "When?",
      question_date: "2024-01-01",
      sessions: [],
      answer_session_ids: [],
    });
    expect(categoryOf(q)).toBe("temporal-reasoning");
  });

  it("returns other for an unknown question_type", () => {
    const q = LmeQuestion.parse({
      question_id: "q30",
      question_type: "some-unknown-type",
      question: "Hmm?",
      question_date: "2024-01-01",
      sessions: [],
      answer_session_ids: [],
    });
    expect(categoryOf(q)).toBe("other");
  });

  it("_abs suffix takes precedence over question_type mapping", () => {
    const q = LmeQuestion.parse({
      question_id: "q50_abs",
      question_type: "temporal-reasoning",
      question: "When?",
      question_date: "2024-01-01",
      sessions: [],
      answer_session_ids: [],
    });
    expect(categoryOf(q)).toBe("abstention");
  });
});

describe("normalizeQuestion", () => {
  const rawRecord = {
    question_id: "q1",
    question_type: "knowledge-update",
    question: "What is the user's city?",
    answer: "Paris",
    question_date: "2024-06-01",
    haystack_session_ids: ["session-A", "session-B"],
    haystack_dates: ["2024-01-01", "2024-02-01"],
    haystack_sessions: [
      [
        { role: "user", content: "Hi", has_answer: false },
        { role: "assistant", content: "Hello!" },
      ],
      [
        { role: "user", content: "I live in Paris", has_answer: true },
        { role: "assistant", content: "Got it." },
      ],
    ],
    answer_session_ids: ["session-B"],
  };

  it("round-trips through LmeQuestion.parse without error", () => {
    const normalized = normalizeQuestion(rawRecord);
    expect(() => LmeQuestion.parse(normalized)).not.toThrow();
  });

  it("preserves question_id", () => {
    const normalized = normalizeQuestion(rawRecord);
    expect(normalized.question_id).toBe("q1");
  });

  it("maps sessions with correct sessionId and date", () => {
    const normalized = normalizeQuestion(rawRecord);
    expect(normalized.sessions).toHaveLength(2);
    expect(normalized.sessions[0].sessionId).toBe("session-A");
    expect(normalized.sessions[0].date).toBe("2024-01-01");
    expect(normalized.sessions[1].sessionId).toBe("session-B");
    expect(normalized.sessions[1].date).toBe("2024-02-01");
  });

  it("maps turns with role and content", () => {
    const normalized = normalizeQuestion(rawRecord);
    expect(normalized.sessions[0].turns).toHaveLength(2);
    expect(normalized.sessions[0].turns[0].role).toBe("user");
    expect(normalized.sessions[0].turns[0].content).toBe("Hi");
  });

  it("preserves has_answer on turns", () => {
    const normalized = normalizeQuestion(rawRecord);
    expect(normalized.sessions[1].turns[0].has_answer).toBe(true);
  });

  it("maps answer_session_ids correctly", () => {
    const normalized = normalizeQuestion(rawRecord);
    expect(normalized.answer_session_ids).toEqual(["session-B"]);
  });

  it("preserves has_answer: false on turns", () => {
    const normalized = normalizeQuestion(rawRecord);
    expect(normalized.sessions[0].turns[0].has_answer).toBe(false);
  });

  it("throws on array-length mismatch between haystack arrays", () => {
    const bad = {
      ...rawRecord,
      haystack_dates: ["2024-01-01"], // length 1 vs ids/sessions length 2
    };
    expect(() => normalizeQuestion(bad)).toThrow(/length mismatch/i);
  });
});
