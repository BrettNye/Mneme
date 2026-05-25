import type { DerivationProvenance, Provenance } from "./provenance.js";

it("DerivationProvenance requires all mandatory fields", () => {
  const dp: DerivationProvenance = {
    queryExpression: "SELECT * WHERE ...",
    corpusState: 1234567890,
    inputClaims: [] as import("./ids.js").ClaimId[],
    similarityVersions: { "model-a": "1.0.0" },
    embeddingModelVersions: { "embed-v1": "2.3.1" },
    evaluationClock: 1700000000000,
  };

  expect(dp.queryExpression).toBe("SELECT * WHERE ...");
  expect(dp.corpusState).toBe(1234567890);
  expect(dp.evaluationClock).toBe(1700000000000);
  expect(dp.inputClaims).toEqual([]);
  expect(dp.similarityVersions).toEqual({ "model-a": "1.0.0" });
  expect(dp.embeddingModelVersions).toEqual({ "embed-v1": "2.3.1" });
});

it("DerivationProvenance optional combinationRule defaults to undefined", () => {
  const dp: DerivationProvenance = {
    queryExpression: "match-all",
    corpusState: 0,
    inputClaims: [] as import("./ids.js").ClaimId[],
    similarityVersions: {},
    embeddingModelVersions: {},
    evaluationClock: 0,
  };

  expect(dp.combinationRule).toBeUndefined();
});

it("DerivationProvenance combinationRule can be set", () => {
  const dp: DerivationProvenance = {
    queryExpression: "query",
    corpusState: 1,
    combinationRule: "max-pooling",
    inputClaims: [] as import("./ids.js").ClaimId[],
    similarityVersions: {},
    embeddingModelVersions: {},
    evaluationClock: 1,
  };

  expect(dp.combinationRule).toBe("max-pooling");
});

it("Provenance can be empty", () => {
  const p: Provenance = {};
  expect(p.workflow).toBeUndefined();
  expect(p.derivedFrom).toBeUndefined();
});

it("Provenance carries all optional fields", () => {
  const dp: DerivationProvenance = {
    queryExpression: "q",
    corpusState: 1,
    inputClaims: [] as import("./ids.js").ClaimId[],
    similarityVersions: {},
    embeddingModelVersions: {},
    evaluationClock: 1,
  };

  const p: Provenance = {
    workflow: "enrich",
    runId: "run-abc",
    nodeId: "node-1",
    persona: "default",
    artifactId: "artifact-xyz",
    derivedFrom: dp,
  };

  expect(p.workflow).toBe("enrich");
  expect(p.runId).toBe("run-abc");
  expect(p.nodeId).toBe("node-1");
  expect(p.persona).toBe("default");
  expect(p.artifactId).toBe("artifact-xyz");
  expect(p.derivedFrom).toBe(dp);
});
