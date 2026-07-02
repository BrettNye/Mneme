/**
 * Mneme ingest example — Fireflies meeting transcripts → typed claims.
 *
 * This is a CONSUMER of Mneme, not part of the library. Mneme's core stays
 * source-agnostic (a claim algebra); vendor-specific ingest lives here in
 * `examples/`. Copy this file, swap the transcript shape and the extractor, and
 * you have ingest for any source (SQL rows, Mongo docs, …).
 *
 * Two boundaries are kept deliberately at the edge:
 *
 *   1. FETCH stays OUT. This takes a transcript OBJECT (a fixture), it never calls
 *      the Fireflies API. Pull transcripts via an MCP server or a small script and
 *      hand the object to `ingestTranscript`. Mneme never learns what "Fireflies" is.
 *
 *   2. EXTRACTION is PLUGGABLE. `ExtractFn` turns a transcript into facts. In
 *      production you pass an LLM-backed extractor; the default `heuristicExtract`
 *      here is a deterministic stand-in so the example runs and tests OFFLINE with
 *      no API key.
 *
 * The digestion (dedup, confidence, recency-ranked recall, contradiction) is all
 * Mneme's existing core — this file only writes claims; it never re-implements any
 * of that. Run: `npx tsx examples/fireflies-ingest.ts`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openSession, pipe, leaf, rho, kappa } from "../src/surface/index.js";
import type { Session, WriteRecord, ImportStats } from "../src/surface/index.js";
import type { ComposedContext } from "../src/index.js";

// ── The source shape ────────────────────────────────────────────────────────
// A Fireflies transcript, trimmed to the fields ingest uses. This is the only
// vendor-specific type; it lives here, never in `src/`.
export interface FirefliesTranscript {
  /** Meeting id — becomes provenance (`meeting:<id>` tag). */
  id: string;
  title: string;
  /** ISO-8601 meeting time. Becomes each claim's `valid.from` so recency-ranked
   *  recall favors what was said most recently. */
  date: string;
  sentences: { speaker: string; text: string }[];
}

// ── What extraction produces ────────────────────────────────────────────────
// A source-agnostic typed fact. An extractor's whole job is to turn transcript
// prose into these; everything downstream is plain Mneme.
export interface ExtractedFact {
  /** Typed entity, e.g. "client:acme", "project:mneme". */
  subject: string;
  /** kebab-case predicate, e.g. "decision", "deadline", "database.choice". */
  key: string;
  value: string;
  /** 0..1. Default 0.7 — a single LLM-extracted observation, not verified. */
  confidence?: number;
}

/** The extraction step. Pluggable so the mapper is offline- and test-friendly:
 *  pass an LLM-backed extractor in production, a deterministic one in tests. */
export type ExtractFn = (transcript: FirefliesTranscript) => ExtractedFact[];

// ── The mapper: fact → Mneme write record ───────────────────────────────────
/**
 * Map one extracted fact to a `WriteRecord`. Two deliberate choices:
 *   - `valid.from` = the meeting date, so the substrate's temporal signal (which
 *     recency-ranked recall reads) reflects when the fact was actually stated.
 *   - `source: "llm"` — extracted, not verified → the llm trust tier (low
 *     pseudocount). Provenance rides on tags since `WriteRecord` has no
 *     provenance field.
 */
export function factToRecord(fact: ExtractedFact, t: FirefliesTranscript): WriteRecord {
  const meetingMs = Date.parse(t.date);
  return {
    subject: fact.subject,
    key: fact.key,
    value: fact.value,
    confidence: fact.confidence ?? 0.7, // bare number => scalar p
    source: "llm",
    valid: { from: Number.isFinite(meetingMs) ? meetingMs : 0, to: Infinity },
    tags: ["fireflies", `meeting:${t.id}`],
  };
}

/**
 * Ingest one transcript: extract facts, map each to a record, write the batch.
 * This is the whole reusable core — extraction and writing, nothing else. Returns
 * Mneme's `ImportStats` (committed / rejected / duplicate).
 */
export function ingestTranscript(
  session: Session,
  corpus: string,
  transcript: FirefliesTranscript,
  extract: ExtractFn,
): ImportStats {
  const records = extract(transcript).map((f) => factToRecord(f, transcript));
  return session.writeMany(corpus, records);
}

// ── Default offline extractor (stand-in for an LLM) ──────────────────────────
/**
 * Deterministic, dependency-free stand-in for an LLM extractor. Parses structured
 * lines of the form `SUBJECT | KEY | VALUE` out of the transcript. A real extractor
 * would read natural prose and TYPE the subject itself — replace this with an
 * LLM-backed `ExtractFn` in production; the rest of the pipeline is unchanged.
 */
export const heuristicExtract: ExtractFn = (t) => {
  const facts: ExtractedFact[] = [];
  for (const s of t.sentences) {
    const m = /^\s*([\w:-]+)\s*\|\s*([\w.-]+)\s*\|\s*(.+)$/.exec(s.text);
    if (!m) continue;
    facts.push({ subject: m[1], key: m[2].toLowerCase(), value: m[3].trim(), confidence: 0.7 });
  }
  return facts;
};

// ── Runnable demo ────────────────────────────────────────────────────────────
// Two meetings a fortnight apart evolve the same decision. After ingest, a recall
// surfaces the corpus as a token-bounded, similarity-ranked context — the same
// "digestion" the OpenClaw plugin serves, here via the offline jaccard ranker.
const SAMPLE_TRANSCRIPTS: FirefliesTranscript[] = [
  {
    id: "mtg-001",
    title: "Acme kickoff",
    date: "2026-06-01T15:00:00Z",
    sentences: [
      { speaker: "Brett", text: "client:acme | database.choice | Postgres" },
      { speaker: "Brett", text: "client:acme | deadline | 2026-08-01" },
    ],
  },
  {
    id: "mtg-002",
    title: "Acme architecture review",
    date: "2026-06-15T15:00:00Z",
    sentences: [
      { speaker: "Brett", text: "client:acme | database.choice | SQLite" },
    ],
  },
];

export interface FirefliesDemoResult {
  committed: number;
  recallMentionsLatest: boolean;
}

export function runFirefliesIngestExample(): FirefliesDemoResult {
  const corpus = "meetings:acme";
  const dbPath = join(mkdtempSync(join(tmpdir(), "mneme-fireflies-")), "store.db");
  const session = openSession({ dbPath, writer: "fireflies-ingest" });
  session.createCorpus({ id: corpus, displayName: "Acme meetings" });

  let committed = 0;
  for (const t of SAMPLE_TRANSCRIPTS) {
    committed += ingestTranscript(session, corpus, t, heuristicExtract).committed;
  }

  // Serve it back as a token-bounded, ranked context (offline jaccard ranker).
  const ctx = session.mneme.query<ComposedContext>(
    corpus,
    pipe(leaf(corpus), rho.jaccard("which database did we choose for acme"), kappa.markdown(2000)),
  );
  session.close();

  return { committed, recallMentionsLatest: ctx.content.includes("SQLite") };
}

// Script entry: `npx tsx examples/fireflies-ingest.ts`.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = runFirefliesIngestExample();
  console.log("Mneme ingest example — Fireflies transcripts → claims\n");
  console.log(`  claims committed from 2 meetings:   ${r.committed}`);
  console.log(`  recall context mentions "SQLite":   ${r.recallMentionsLatest}`);
}
