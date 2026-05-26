import { replayStatus } from "./replay.js";

it("reports integrity_unknown for a claim with no derivedFrom provenance", () => {
  const adapter = { getClaim: (_id: string) => ({ id: _id } as any) } as any;
  const plain = { provenance: {} } as any;
  expect(replayStatus(plain, adapter).status).toBe("integrity_unknown");
});

it("reports missing_inputs when a recorded input claim is absent from the adapter", () => {
  const adapter = { getClaim: (id: string) => (id === "present" ? ({ id } as any) : undefined) } as any;
  const derived = { provenance: { derivedFrom: { evaluationClock: 1, inputClaims: ["gone"], similarityVersions: {}, embeddingModelVersions: {} } } } as any;
  expect(replayStatus(derived, adapter).status).toBe("missing_inputs");
});

it("reports unavailable_models when a similarity version is not in registry or version differs", () => {
  const adapter = { getClaim: (_id: string) => ({ id: _id } as any) } as any;
  const derived = {
    provenance: {
      derivedFrom: {
        evaluationClock: 1,
        inputClaims: [],
        similarityVersions: { jaccard: "99.0.0" },
        embeddingModelVersions: {},
      },
    },
  } as any;
  const result = replayStatus(derived, adapter);
  expect(result.status).toBe("unavailable_models");
  expect(result.missingDependencies).toHaveLength(1);
  expect(result.missingDependencies[0].kind).toBe("similarity_version");
  expect(result.missingDependencies[0].id).toBe("jaccard@99.0.0");
});

it("reports unavailable_models when a similarity name is unknown", () => {
  const adapter = { getClaim: (_id: string) => ({ id: _id } as any) } as any;
  const derived = {
    provenance: {
      derivedFrom: {
        evaluationClock: 1,
        inputClaims: [],
        similarityVersions: { nonexistent_fn: "1.0.0" },
        embeddingModelVersions: {},
      },
    },
  } as any;
  const result = replayStatus(derived, adapter);
  expect(result.status).toBe("unavailable_models");
  expect(result.missingDependencies[0].id).toBe("nonexistent_fn@1.0.0");
});

it("returns failed (not exact) when all inputs and versions resolve — exact is deferred", () => {
  // All inputs present, no similarity versions to check
  const adapter = { getClaim: (_id: string) => ({ id: _id } as any) } as any;
  const derived = {
    provenance: {
      derivedFrom: {
        evaluationClock: 1,
        inputClaims: ["a", "b"],
        similarityVersions: {},
        embeddingModelVersions: {},
      },
    },
  } as any;
  const result = replayStatus(derived, adapter);
  expect(result.status).toBe("failed");
  expect(result.missingDependencies).toHaveLength(0);
});

it("never returns exact status", () => {
  const adapter = { getClaim: (_id: string) => ({ id: _id } as any) } as any;
  const scenarios = [
    { provenance: {} } as any,
    {
      provenance: {
        derivedFrom: {
          evaluationClock: 1,
          inputClaims: [],
          similarityVersions: {},
          embeddingModelVersions: {},
        },
      },
    } as any,
  ];
  for (const scenario of scenarios) {
    expect(replayStatus(scenario, adapter).status).not.toBe("exact");
  }
});
