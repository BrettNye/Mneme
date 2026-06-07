import { describe, it, expect } from "vitest";
import { uniqueCandidates, parseJudgment, buildJudgePrompt } from "./ratify-judge.js";
import { simJaccard } from "../../../src/algebra/similarity.js";

const jac = (a: string, b: string): number => simJaccard.scoreOne(a, b);

const q = (entries: Array<[string, string, string[]]>) => ({
  keys: new Map(entries.map(([k, subject, values]) => [k, { subject, values }])),
});

describe("uniqueCandidates", () => {
  it("dedupes the same pair across questions, tracking occurrences and max score", () => {
    const perQ = [
      q([["car service date", "user", ["March 15"]], ["service date", "user", ["March 15"]]]),
      q([["car service date", "user", ["April 2"]], ["service date", "user", ["April 2"]]]),
    ];
    const out = uniqueCandidates(perQ, jac, 0.5);
    expect(out).toHaveLength(1);
    expect(out[0].occurrences).toBe(2);
    expect(out[0].a < out[0].b).toBe(true);
    expect(out[0].aValues.length).toBeGreaterThan(0);
  });

  it("filters below the suggest threshold and sorts by score desc", () => {
    const perQ = [
      q([
        ["alpha beta gamma", "s", ["1"]],
        ["alpha beta delta", "s", ["2"]], // 0.5 vs first
        ["unrelated key", "s", ["3"]],
      ]),
    ];
    const out = uniqueCandidates(perQ, jac, 0.4);
    expect(out).toHaveLength(1);
    expect(out[0].score).toBeCloseTo(0.5);
  });

  it("pair identity, score, and occurrences are deterministic across question order", () => {
    const a = q([["k one", "s", ["1"]], ["k two", "s", ["2"]]]);
    const b = q([["k two", "s", ["3"]], ["k one", "s", ["4"]]]);
    const strip = (cs: ReturnType<typeof uniqueCandidates>) =>
      cs.map(({ a, b, score, occurrences }) => ({ a, b, score, occurrences }));
    expect(strip(uniqueCandidates([a, b], jac, 0.3))).toEqual(strip(uniqueCandidates([b, a], jac, 0.3)));
  });
});

describe("parseJudgment", () => {
  it("accepts well-formed verdicts and rejects malformed ones", () => {
    expect(parseJudgment('{"same": true, "reason": "synonyms"}')).toEqual({ same: true, reason: "synonyms" });
    expect(parseJudgment('{"same": "yes"}')).toBeNull();
    expect(parseJudgment("not json")).toBeNull();
  });
});

describe("buildJudgePrompt", () => {
  it("includes both keys, values, and the supersession framing", () => {
    const p = buildJudgePrompt({
      a: "service date", b: "car service date", score: 0.93,
      subjects: ["user"], aValues: ["March 15"], bValues: ["April 2"], occurrences: 2,
    });
    expect(p).toContain('"service date"');
    expect(p).toContain('"car service date"');
    expect(p).toContain("March 15");
    expect(p).toContain("supersede");
  });
});
