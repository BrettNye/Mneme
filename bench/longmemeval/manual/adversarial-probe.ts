// Adversarial manual probe: cases designed to make arm A (algebra) LOSE or behave
// questionably. Prints what each arm returns per case + a verdict line.
// Run: npx tsx bench/datasets/longmemeval/adversarial-probe.ts
import { openTmpSession } from "../test-support.js";
import { answerArmA, answerArmB } from "../answer.js";
import type { LmeQuestionT } from "../types.js";
import type { Session } from "../../../src/surface/index.js";

const DAY = 86_400_000;
const T0 = Date.parse("2023-01-01T10:00:00Z");

interface Probe {
  name: string;
  expectation: string;
  question: string;
  claims: Array<{ subject: string; key: string; value: string; daysAfterT0: number; confidence?: number }>;
  keyCardinality?: Record<string, "single" | "multi">;
}

const PROBES: Probe[] = [
  {
    name: "1. false-positive ⊥ — same key, BOTH true (additive facts, not an update)",
    expectation: "FIXED: both hobbies kept (hobby declared multi)",
    question: "What hobbies does the user have, like painting or running?",
    claims: [
      { subject: "user", key: "hobby", value: "painting landscapes", daysAfterT0: 0 },
      { subject: "user", key: "hobby", value: "running marathons", daysAfterT0: 30 },
    ],
    keyCardinality: { hobby: "multi" },
  },
  {
    name: "2. supersede-then-REVERT (back at the original value)",
    expectation: "A should return the revert value (Initech) — latest-wins handles cycles",
    question: "Where does the user work, Initech or Globex?",
    claims: [
      { subject: "user", key: "employer", value: "Initech", daysAfterT0: 0 },
      { subject: "user", key: "employer", value: "Globex", daysAfterT0: 60 },
      { subject: "user", key: "employer", value: "Initech again", daysAfterT0: 120 },
    ],
  },
  {
    name: "3. paraphrase 'contradiction' — same fact, different wording",
    expectation: "expected-fail under jaccard (acronym, token sets disjoint); embedding slice acceptance case — older paraphrase deprecated, fact survives",
    question: "What city does the user live in, New York?",
    claims: [
      { subject: "user", key: "city", value: "NYC", daysAfterT0: 0 },
      { subject: "user", key: "city", value: "New York City", daysAfterT0: 30 },
    ],
  },
  {
    name: "4. contradiction split across DIFFERENT keys (key drift)",
    expectation: "⊥ blind across keys — A returns both contradictory cities, same as B",
    question: "What city does the user live in, Berlin or Munich?",
    claims: [
      { subject: "user", key: "home_city", value: "Berlin", daysAfterT0: 0 },
      { subject: "user", key: "city", value: "Munich", daysAfterT0: 30 },
    ],
  },
  {
    name: "5. timestamp TIE with conflicting values",
    expectation: "tie ⇒ both values returned + flagged for review (no arbitrary winner)",
    question: "What is the user's favorite coffee drink?",
    claims: [
      { subject: "user", key: "favorite_coffee", value: "flat white", daysAfterT0: 10 },
      { subject: "user", key: "favorite_coffee", value: "cortado", daysAfterT0: 10 },
    ],
  },
  {
    name: "6. fresh-but-low-confidence update vs stale-confident fact",
    expectation: "FIXED: floor 0 — Pixel contests; recency rule decides",
    question: "What phone does the user own, iPhone or Pixel?",
    claims: [
      { subject: "user", key: "phone", value: "iPhone 13", daysAfterT0: 0, confidence: 1 },
      { subject: "user", key: "phone", value: "Pixel 8", daysAfterT0: 30, confidence: 0.4 },
    ],
  },
  {
    name: "7. token-overlap paraphrase — same purchase, incrementally described",
    expectation: "merged by dedupe — single claim, latest wording, no deprecation",
    question: "What did the user order from Amazon?",
    claims: [
      { subject: "user", key: "recent_purchase", value: "power bank from Amazon", daysAfterT0: 0 },
      { subject: "user", key: "recent_purchase", value: "power bank from Amazon ordered Feb 13", daysAfterT0: 30 },
    ],
  },
];

function mkQuestion(probe: Probe, idx: number): LmeQuestionT {
  return {
    question_id: `adv-${idx}`,
    question_type: "knowledge-update",
    question: probe.question,
    question_date: "2023/12/01 (Fri) 10:00", // long after all claims
    answer: undefined,
    sessions: probe.claims.map((c, i) => ({
      sessionId: `adv-${idx}-s${i}`,
      date: "2023/01/01 (Sun) 10:00",
      turns: [{ role: "user" as const, content: c.value }],
    })),
    answer_session_ids: [],
  };
}

function seed(session: Session, corpusId: string, probe: Probe, idx: number): void {
  session.createCorpus({ id: corpusId, contradictionPolicy: { kind: "always_accept" } });
  probe.claims.forEach((c, i) => {
    session.write(corpusId, {
      subject: c.subject,
      key: c.key,
      value: c.value,
      valid: { from: T0 + c.daysAfterT0 * DAY, to: Infinity },
      tags: [`session:adv-${idx}-s${i}`, "turn:0"],
      ...(c.confidence !== undefined ? { confidence: c.confidence } : {}),
    });
  });
}

const fmt = (r: { claims: Array<{ value: unknown }>; abstained: boolean }) =>
  r.abstained ? "(abstained)" : r.claims.map((c) => JSON.stringify(c.value)).join(" | ") || "(empty)";

for (const [idx, probe] of PROBES.entries()) {
  const { session, close } = openTmpSession();
  try {
    const corpusId = `adv-${idx}`;
    seed(session, corpusId, probe, idx);
    const q = mkQuestion(probe, idx);
    const a = answerArmA(session, corpusId, q, { k: 5, keyCardinality: probe.keyCardinality });
    const b = answerArmB(session, corpusId, q, { k: 5 });
    console.log(`\n=== ${probe.name}`);
    console.log(`    expectation: ${probe.expectation}`);
    console.log(`    arm A: ${fmt(a)}`);
    console.log(`    arm B: ${fmt(b)}`);
  } finally {
    close();
  }
}
console.log();
