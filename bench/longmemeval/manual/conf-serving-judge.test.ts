import { describe, it, expect } from "vitest";
import { buildJudgeContext } from "./conf-serving-sweep.js";
import type { Claim } from "../../../src/core/claim.js";
import type { LmeQuestionT } from "../types.js";

function mk(id: string, value: string, session: string, validFrom: number): Claim {
  return {
    id, subject: "user", key: "dest", value,
    valid: { from: validFrom, to: Infinity },
    confidence: { distribution: "scalar", parameters: { p: 1 }, raw: 1 },
    tags: [`session:${session}`], status: "validated",
  } as unknown as Claim;
}

const q = {
  question_id: "k1", question: "trip destination", question_type: "knowledge-update",
  answer: "Paris", answer_session_ids: ["s_old", "s_new"],
  sessions: [
    { sessionId: "s_old", date: "2023/05/01 (Mon) 10:00" },
    { sessionId: "s_new", date: "2023/06/01 (Thu) 10:00" },
  ],
} as unknown as LmeQuestionT;

describe("buildJudgeContext", () => {
  it("renders top-K served context strings per question (pure, no network)", () => {
    const t = 2_000_000_000_000;
    const qstates = [{ q, t, survivors: [mk("a", "Vegas", "s_old", t - 1_000), mk("b", "Paris", "s_new", t - 2_000)] }];
    const out = buildJudgeContext(qstates, 1); // wConf=1 → confidence dominates, latest-session "Paris" first
    expect(out).toHaveLength(1);
    expect(out[0].context.length).toBeGreaterThan(0);
    expect(out[0].context[0]).toContain("Paris");
  });
});
