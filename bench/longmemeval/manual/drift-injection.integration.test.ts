/**
 * Drift-injection round-trip integration test.
 *
 * Proves that injectDrift composes through the real pipeline
 * (injectDrift → claimsFor → ingestQuestion → answerArmA) and that the oracle
 * alias map recovers the newest value that drift otherwise leaves un-contested.
 *
 * Seed "rt" is chosen because it deterministically splits the two employer
 * claims onto DISTINCT variant keys (Initech→preferred_employer,
 * Globex→primary_employer), which is required for the "both survive" assertion
 * in the no-alias case. Verified by tracing pickVariant(seed+"|var|"+identity)
 * for each claim at fraction=1.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "../../../src/surface/index.js";
import { injectDrift } from "./drift-injector.js";
import { ingestQuestion, claimsFor } from "../ingest.js";
import { answerArmA } from "../answer.js";
import { MANUAL_KEY_CARDINALITY } from "../run.js";
import type { ClaimRecordT, LmeQuestionT } from "../types.js";

// One synthetic KU question: alice's employer Initech → Globex over two sessions.
// turns: [] satisfies the LmeSession schema (turns is required but may be empty for
// synthetic fixtures that bypass the extraction step).
const Q: LmeQuestionT = {
  question_id: "drift-rt-1",
  question_type: "knowledge-update",
  question: "Where does alice work now?",
  question_date: "2023/07/01 (Sat) 10:00",
  answer: "Globex",
  sessions: [
    { sessionId: "s-old", date: "2023/05/01 (Mon) 10:00", turns: [] },
    { sessionId: "s-new", date: "2023/06/01 (Thu) 10:00", turns: [] },
  ],
  answer_session_ids: ["s-old", "s-new"],
};

const CLAIMS: ClaimRecordT[] = [
  {
    subject: "alice",
    key: "employer",
    value: "Initech",
    validFrom: Date.UTC(2023, 4, 1), // 2023-05-01T00:00:00Z
    tags: ["session:s-old", "turn:0"],
  },
  {
    subject: "alice",
    key: "employer",
    value: "Globex",
    validFrom: Date.UTC(2023, 5, 1), // 2023-06-01T00:00:00Z
    tags: ["session:s-new", "turn:0"],
  },
];

function run(aliased: boolean) {
  // seed "rt": Initech → preferred_employer, Globex → primary_employer (distinct keys).
  // With fraction=1 both claims drift; the two variant keys don't contest without aliases.
  const { claims, aliasMap } = injectDrift(CLAIMS, {
    mode: "morph",
    fraction: 1,
    seed: "rt",
    multiKeys: MANUAL_KEY_CARDINALITY,
  });

  const dir = mkdtempSync(join(tmpdir(), "drift-rt-"));
  const session = openSession({
    dbPath: join(dir, "lme.db"),
    writer: "drift-rt",
    source: "imported",
  });
  try {
    // oracle: true restricts to answer_session_ids (both sessions here)
    const records = claimsFor(Q, claims, { oracle: true });
    ingestQuestion(session, Q, records);
    const res = answerArmA(session, `lme-${Q.question_id}`, Q, {
      k: 10,
      keyCardinality: MANUAL_KEY_CARDINALITY,
      abstainBelowTop: 0,
      relevanceFloor: 0,
      keyAliases: aliased ? aliasMap : undefined,
    });
    return res.claims.map((c) => c.value);
  } finally {
    session.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("drift-injection round-trip (fixture)", () => {
  it("WITHOUT alias map: drifted lineage does not fully contest (stale survives)", () => {
    const values = run(false);
    // employer split across variant keys → both Initech and Globex reachable
    expect(values).toContain("Globex");
    expect(values).toContain("Initech");
  });

  it("WITH oracle alias map: newest wins, stale deprecated", () => {
    const values = run(true);
    expect(values).toContain("Globex");
    expect(values).not.toContain("Initech");
  });
});
