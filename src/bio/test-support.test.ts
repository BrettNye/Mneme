import { makeBioMneme } from "./test-support.js";

it("makeBioMneme yields a Mneme that can commit to its corpus", () => {
  const { mneme, corpusId } = makeBioMneme();
  const res = mneme.commit(
    corpusId,
    {
      profile: "profile-bio-test" as any,
      workspace: "bio-test" as any,
      subject: "test-subject",
      key: "test.key",
      scope: {},
      value: "test-value",
      confidence: { distribution: "beta", parameters: { alpha: 9, beta: 1 }, raw: 0.9 },
      valid: { from: 0, to: Infinity },
      source: "manual",
      provenance: {},
      evidence: [],
      tags: [],
      schema: "bio-test@1",
    },
    { writer: "t" }
  );
  expect(res.status).toBe("committed");
});

it("makeBioMneme returns a stable corpusId string", () => {
  const { corpusId } = makeBioMneme();
  expect(typeof corpusId).toBe("string");
  expect(corpusId.length).toBeGreaterThan(0);
});
