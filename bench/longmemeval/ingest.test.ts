import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  ingestQuestion,
  corpusIdFor,
  claimsFor,
  mapClaimRecord,
  IngestConservationError,
  AlreadyIngestedError,
} from "./ingest.js";
import { openTmpSession, fixturePath } from "./test-support.js";
import type { LmeQuestionT, ClaimRecordT } from "./types.js";

// ---------------------------------------------------------------------------
// Load fixture data
// ---------------------------------------------------------------------------

function loadFixtureDataset(): LmeQuestionT[] {
  const raw = JSON.parse(readFileSync(fixturePath("dataset.json"), "utf-8")) as unknown[];
  return raw as LmeQuestionT[];
}

function loadFixtureClaims(): ClaimRecordT[] {
  const lines = readFileSync(fixturePath("claims.jsonl"), "utf-8").split("\n").filter(Boolean);
  // line 0 is the header; skip it
  return lines.slice(1).map((line) => JSON.parse(line) as ClaimRecordT);
}

const fixtureQuestions = loadFixtureDataset();
const fixtureClaims = loadFixtureClaims();

const kuFixtureQuestion = fixtureQuestions.find((q) => q.question_id === "fx-ku-1")!;
const trFixtureQuestion = fixtureQuestions.find((q) => q.question_id === "fx-tr-1")!;
const absFixtureQuestion = fixtureQuestions.find((q) => q.question_id === "fx-abs-1_abs")!;

// ---------------------------------------------------------------------------
// corpusIdFor
// ---------------------------------------------------------------------------

describe("corpusIdFor", () => {
  it("prefixes question_id with lme-", () => {
    expect(corpusIdFor("fx-ku-1")).toBe("lme-fx-ku-1");
    expect(corpusIdFor("fx-abs-1_abs")).toBe("lme-fx-abs-1_abs");
  });
});

// ---------------------------------------------------------------------------
// mapClaimRecord
// ---------------------------------------------------------------------------

describe("mapClaimRecord", () => {
  it("maps subject, key, value from the record", () => {
    const rec: ClaimRecordT = {
      subject: "alice",
      key: "employer",
      value: "Initech",
      validFrom: 1680361200000,
      confidence: 0.95,
      tags: ["session:fx-s1", "turn:0"],
    };
    const wr = mapClaimRecord(rec);
    expect(wr.subject).toBe("alice");
    expect(wr.key).toBe("employer");
    expect(wr.value).toBe("Initech");
  });

  it("maps validFrom to valid.from and valid.to = Infinity", () => {
    const rec: ClaimRecordT = {
      subject: "alice",
      key: "employer",
      value: "Initech",
      validFrom: 1680361200000,
      tags: ["session:fx-s1", "turn:0"],
    };
    const wr = mapClaimRecord(rec);
    expect(wr.valid).toEqual({ from: 1680361200000, to: Infinity });
  });

  it("maps tags through unchanged", () => {
    const rec: ClaimRecordT = {
      subject: "alice",
      key: "employer",
      value: "Initech",
      validFrom: 1680361200000,
      tags: ["session:fx-s1", "turn:0"],
    };
    const wr = mapClaimRecord(rec);
    expect(wr.tags).toEqual(["session:fx-s1", "turn:0"]);
  });

  it("maps confidence when present", () => {
    const rec: ClaimRecordT = {
      subject: "alice",
      key: "employer",
      value: "Initech",
      validFrom: 1680361200000,
      confidence: 0.95,
      tags: ["session:fx-s1", "turn:0"],
    };
    const wr = mapClaimRecord(rec);
    expect(wr.confidence).toBe(0.95);
  });

  it("omits confidence when undefined so Session.defaultConfidence applies", () => {
    const rec: ClaimRecordT = {
      subject: "alice",
      key: "employer",
      value: "Initech",
      validFrom: 1680361200000,
      tags: ["session:fx-s1", "turn:0"],
    };
    const wr = mapClaimRecord(rec);
    expect(wr.confidence).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// claimsFor
// ---------------------------------------------------------------------------

describe("claimsFor", () => {
  it("returns only claims whose session tag belongs to the question's haystack sessions", () => {
    const result = claimsFor(kuFixtureQuestion, fixtureClaims);
    // fx-ku-1 has sessions fx-s1 and fx-s2 → 2 alice employer claims
    expect(result).toHaveLength(2);
    expect(result.every((c) =>
      c.tags.some((t) => t === "session:fx-s1" || t === "session:fx-s2")
    )).toBe(true);
  });

  it("returns only claims for the tr question when filtering by tr sessions", () => {
    const result = claimsFor(trFixtureQuestion, fixtureClaims);
    // fx-tr-1 has sessions fx-s3 and fx-s4 → 2 bob residence claims
    expect(result).toHaveLength(2);
    expect(result.every((c) =>
      c.tags.some((t) => t === "session:fx-s3" || t === "session:fx-s4")
    )).toBe(true);
  });

  it("oracle mode restricts to answer_session_ids only", () => {
    // fx-ku-1 answer_session_ids = ["fx-s1", "fx-s2"] → both are evidence sessions
    const result = claimsFor(kuFixtureQuestion, fixtureClaims, { oracle: true });
    expect(result).toHaveLength(2);
  });

  it("oracle mode excludes non-evidence sessions from tr question", () => {
    // fx-tr-1 answer_session_ids = ["fx-s3"] → only fx-s3 claim (Denver), not fx-s4 (Austin)
    const result = claimsFor(trFixtureQuestion, fixtureClaims, { oracle: true });
    expect(result).toHaveLength(1);
    expect(result[0]!.value).toBe("Denver");
  });

  it("oracle mode returns empty for abstention question with no answer_session_ids", () => {
    const result = claimsFor(absFixtureQuestion, fixtureClaims, { oracle: true });
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ingestQuestion
// ---------------------------------------------------------------------------

describe("ingestQuestion", () => {
  it("commits every fixture claim for the KU question and both contradictory values survive", () => {
    const { session, close } = openTmpSession();
    try {
      const records = claimsFor(kuFixtureQuestion, fixtureClaims);
      const stats = ingestQuestion(session, kuFixtureQuestion, records);

      expect(stats.committed).toBe(records.length);
      expect(stats.committed).toBe(2); // alice Initech + alice Globex

      const corpus = session.q(corpusIdFor("fx-ku-1"), "") as { claims: unknown[] };
      expect(corpus.claims.length).toBe(records.length); // always_accept retains the contradiction
    } finally {
      close();
    }
  });

  it("creates a corpus with ID lme-<question_id>", () => {
    const { session, close } = openTmpSession();
    try {
      const records = claimsFor(kuFixtureQuestion, fixtureClaims);
      ingestQuestion(session, kuFixtureQuestion, records);

      const corpora = session.listCorpora();
      expect(corpora.some((c) => c.id === "lme-fx-ku-1")).toBe(true);
    } finally {
      close();
    }
  });

  it("provenance tags and validFrom survive the round trip", () => {
    const { session, close } = openTmpSession();
    try {
      const records = claimsFor(kuFixtureQuestion, fixtureClaims);
      ingestQuestion(session, kuFixtureQuestion, records);

      const corpus = session.q(corpusIdFor("fx-ku-1"), "") as { claims: Array<{
        tags?: string[];
        valid?: { from: number };
      }> };

      // Every claim should carry session:/turn: tags
      for (const claim of corpus.claims) {
        expect(claim.tags?.some((t) => t.startsWith("session:"))).toBe(true);
        expect(claim.tags?.some((t) => t.startsWith("turn:"))).toBe(true);
        expect(claim.valid?.from).toBeGreaterThan(0);
      }
    } finally {
      close();
    }
  });

  it("throws IngestConservationError if committed !== records", () => {
    // Build a stub Session that returns committed=0 from writeMany,
    // simulating a partial failure (e.g. all claims errored).
    const records = claimsFor(kuFixtureQuestion, fixtureClaims);
    const stubSession = {
      createCorpus: () => undefined,
      listCorpora: () => [],
      writeMany: () => ({
        total: records.length,
        committed: 0, // nothing got through — conservation fails
        rejected: 0,
        duplicate: 0,
        skipped: records.length,
        elapsedMs: 0,
        claimsPerSec: 0,
      }),
    } as unknown as Parameters<typeof ingestQuestion>[0];

    expect(() => ingestQuestion(stubSession, kuFixtureQuestion, records)).toThrow(
      IngestConservationError
    );
  });

  it("IngestConservationError names the question id and delta", () => {
    const records = claimsFor(kuFixtureQuestion, fixtureClaims);
    const committed = 1; // one committed, but we expect 2 → delta = 1
    const stubSession = {
      createCorpus: () => undefined,
      listCorpora: () => [],
      writeMany: () => ({
        total: records.length,
        committed,
        rejected: 0,
        duplicate: 0,
        skipped: records.length - committed,
        elapsedMs: 0,
        claimsPerSec: 0,
      }),
    } as unknown as Parameters<typeof ingestQuestion>[0];

    let error: IngestConservationError | undefined;
    try {
      ingestQuestion(stubSession, kuFixtureQuestion, records);
    } catch (e) {
      if (e instanceof IngestConservationError) {
        error = e;
      }
    }
    expect(error).toBeDefined();
    // message must include the question id
    expect(error!.message).toContain("fx-ku-1");
    // delta = records.length - committed
    expect(error!.delta).toBe(records.length - committed);
  });

  it("throws AlreadyIngestedError on re-ingest of the same question", () => {
    const { session, close } = openTmpSession();
    try {
      const records = claimsFor(kuFixtureQuestion, fixtureClaims);
      ingestQuestion(session, kuFixtureQuestion, records);

      // Second call must throw
      expect(() => ingestQuestion(session, kuFixtureQuestion, records)).toThrow(
        AlreadyIngestedError
      );
    } finally {
      close();
    }
  });

  it("AlreadyIngestedError names the corpus id and corpus still holds only first ingest's claims", () => {
    const { session, close } = openTmpSession();
    try {
      const records = claimsFor(kuFixtureQuestion, fixtureClaims);
      ingestQuestion(session, kuFixtureQuestion, records);

      let error: AlreadyIngestedError | undefined;
      try {
        ingestQuestion(session, kuFixtureQuestion, records);
      } catch (e) {
        if (e instanceof AlreadyIngestedError) {
          error = e;
        }
      }

      expect(error).toBeDefined();
      expect(error!.corpusId).toBe("lme-fx-ku-1");
      expect(error!.message).toContain("lme-fx-ku-1");

      // Corpus was NOT written to a second time — still has exactly the first ingest's claims
      const corpus = session.q(corpusIdFor("fx-ku-1"), "") as { claims: unknown[] };
      expect(corpus.claims.length).toBe(records.length);
    } finally {
      close();
    }
  });

  it("throws IngestConservationError whose message mentions duplicates when writeMany reports duplicate > 0", () => {
    // Simulate the case where writeMany detects duplicate input records (e.g. via
    // idempotency key deduplication). committed < records.length violates conservation,
    // and the duplicate count must appear in the error message for diagnosability.
    // Fixture/extraction records are always unique; a non-zero duplicate count means
    // corrupted input — not a benign skip.
    const records = claimsFor(kuFixtureQuestion, fixtureClaims);
    const dupRecords = [...records, ...records]; // 4 records, 2 unique
    const duplicateCount = records.length; // 2 duplicates detected

    const stubSession = {
      createCorpus: () => undefined,
      listCorpora: () => [],
      writeMany: () => ({
        total: dupRecords.length,
        committed: records.length, // only the unique ones committed
        rejected: 0,
        duplicate: duplicateCount,
        skipped: 0,
        elapsedMs: 0,
        claimsPerSec: 0,
      }),
    } as unknown as Parameters<typeof ingestQuestion>[0];

    let error: IngestConservationError | undefined;
    try {
      ingestQuestion(stubSession, kuFixtureQuestion, dupRecords);
    } catch (e) {
      if (e instanceof IngestConservationError) {
        error = e;
      }
    }
    expect(error).toBeDefined();
    // delta = dupRecords.length - committed = 4 - 2 = 2
    expect(error!.delta).toBe(duplicateCount);
    // message must mention duplicate count for diagnosability
    expect(error!.message).toMatch(/duplicate/i);
    expect(error!.message).toContain(String(duplicateCount));
  });
});
