import { describe, it, expect } from "vitest";
import type { Claim } from "../../../src/core/claim.js";
import { pointEstimate } from "../../../src/core/confidence.js";
import type { LmeQuestionT } from "../types.js";
import { HI, LO, seededUnit, injectedConfidenceValue, injectConfidence } from "./conf-inject.js";

function mkClaim(id: string, session: string): Claim {
  return {
    id, subject: "user", key: "k", value: "v",
    valid: { from: 1000, to: Infinity },
    confidence: { distribution: "scalar", parameters: { p: 1 }, raw: 1 },
    tags: [`session:${session}`], status: "validated",
  } as unknown as Claim;
}

// q with two sessions; sess_b is later → latest answer session.
const q = {
  question_id: "q1",
  answer_session_ids: ["sess_a", "sess_b"],
  sessions: [
    { sessionId: "sess_a", date: "2023/05/01 (Mon) 10:00" },
    { sessionId: "sess_b", date: "2023/06/01 (Thu) 10:00" },
  ],
} as unknown as LmeQuestionT;

describe("seededUnit", () => {
  it("is deterministic and in [0,1)", () => {
    const u = seededUnit("q1", "c1");
    expect(u).toBe(seededUnit("q1", "c1"));
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThan(1);
  });
  it("differs across inputs", () => {
    expect(seededUnit("q1", "c1")).not.toBe(seededUnit("q1", "c2"));
  });
});

describe("injectedConfidenceValue", () => {
  it("p=1: HI on the latest-session claim, LO otherwise", () => {
    expect(injectedConfidenceValue(mkClaim("c1", "sess_b"), q, 1)).toBe(HI);
    expect(injectedConfidenceValue(mkClaim("c2", "sess_a"), q, 1)).toBe(LO);
  });
  it("is deterministic across calls at p<1", () => {
    const c = mkClaim("c3", "sess_b");
    expect(injectedConfidenceValue(c, q, 0.5)).toBe(injectedConfidenceValue(c, q, 0.5));
  });
});

describe("injectConfidence", () => {
  it("overrides confidence without changing claim identity/order", () => {
    const survivors = [mkClaim("c1", "sess_b"), mkClaim("c2", "sess_a")];
    const out = injectConfidence(survivors, q, 1);
    expect(out.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(pointEstimate(out[0].confidence)).toBe(HI);
    expect(pointEstimate(out[1].confidence)).toBe(LO);
  });
});
