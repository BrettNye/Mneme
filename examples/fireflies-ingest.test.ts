import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession, pipe, leaf, sigma } from "../src/surface/index.js";
import type { Corpus } from "../src/index.js";
import {
  factToRecord,
  ingestTranscript,
  heuristicExtract,
  type FirefliesTranscript,
} from "./fireflies-ingest.js";

const T1: FirefliesTranscript = {
  id: "m1",
  title: "kickoff",
  date: "2026-06-01T00:00:00Z",
  sentences: [],
};
const T2: FirefliesTranscript = {
  id: "m2",
  title: "review",
  date: "2026-06-15T00:00:00Z",
  sentences: [],
};

const tmpDb = () => join(mkdtempSync(join(tmpdir(), "mneme-fireflies-")), "store.db");

const claimsOf = (session: ReturnType<typeof openSession>, corpus: string, subject: string) =>
  session.mneme.query<Corpus>(corpus, pipe(leaf(corpus), sigma({ op: "subjectEq", value: subject }))).claims;

describe("fireflies ingest", () => {
  it("factToRecord threads the meeting date into valid.from and tags provenance", () => {
    const rec = factToRecord(
      { subject: "client:acme", key: "database.choice", value: "Postgres" },
      T1,
    );
    expect(rec.subject).toBe("client:acme");
    expect(rec.key).toBe("database.choice");
    expect(rec.value).toBe("Postgres");
    expect(rec.source).toBe("llm"); // extracted, not verified → llm trust tier
    expect(rec.confidence).toBe(0.7); // default single-observation confidence
    expect(rec.valid?.from).toBe(Date.parse("2026-06-01T00:00:00Z"));
    expect(rec.tags).toContain("fireflies");
    expect(rec.tags).toContain("meeting:m1");
  });

  it("factToRecord respects an explicit confidence and falls back to from:0 on a bad date", () => {
    const rec = factToRecord(
      { subject: "client:acme", key: "deadline", value: "2026-08-01", confidence: 0.95 },
      { ...T1, date: "not-a-date" },
    );
    expect(rec.confidence).toBe(0.95);
    expect(rec.valid?.from).toBe(0);
  });

  it("ingestTranscript writes each extracted fact as a claim", () => {
    const session = openSession({ dbPath: tmpDb(), writer: "test" });
    session.createCorpus({ id: "c", displayName: "c" });

    const stats = ingestTranscript(session, "c", T1, () => [
      { subject: "client:acme", key: "database.choice", value: "Postgres" },
      { subject: "client:acme", key: "deadline", value: "2026-08-01" },
    ]);

    expect(stats.committed).toBe(2);
    const values = claimsOf(session, "c", "client:acme").map((c) => c.value);
    expect(values).toContain("Postgres");
    expect(values).toContain("2026-08-01");
    session.close();
  });

  it("an evolving decision across two meetings lands both, stamped with each meeting date", () => {
    const session = openSession({ dbPath: tmpDb(), writer: "test" });
    session.createCorpus({ id: "c", displayName: "c" });

    ingestTranscript(session, "c", T1, () => [
      { subject: "client:acme", key: "database.choice", value: "Postgres" },
    ]);
    ingestTranscript(session, "c", T2, () => [
      { subject: "client:acme", key: "database.choice", value: "SQLite" },
    ]);

    const choice = claimsOf(session, "c", "client:acme").filter((c) => c.key === "database.choice");
    const fromByValue = new Map(choice.map((c) => [c.value as string, c.valid.from]));

    // Append-only: both observations retained, each stamped with its meeting's date.
    expect(fromByValue.get("Postgres")).toBe(Date.parse("2026-06-01T00:00:00Z"));
    expect(fromByValue.get("SQLite")).toBe(Date.parse("2026-06-15T00:00:00Z"));
    // The later decision carries the newer valid.from — the signal recency-ranked recall reads.
    expect(fromByValue.get("SQLite")!).toBeGreaterThan(fromByValue.get("Postgres")!);
    session.close();
  });

  it("the offline heuristic extractor parses SUBJECT|KEY|VALUE lines end-to-end", () => {
    const session = openSession({ dbPath: tmpDb(), writer: "test" });
    session.createCorpus({ id: "c", displayName: "c" });

    const stats = ingestTranscript(
      session,
      "c",
      {
        ...T1,
        sentences: [
          { speaker: "Brett", text: "client:acme | database.choice | Postgres" },
          { speaker: "Brett", text: "(chit-chat with no structured fact)" },
        ],
      },
      heuristicExtract,
    );

    expect(stats.committed).toBe(1); // only the structured line becomes a claim
    expect(claimsOf(session, "c", "client:acme").map((c) => c.value)).toContain("Postgres");
    session.close();
  });
});
