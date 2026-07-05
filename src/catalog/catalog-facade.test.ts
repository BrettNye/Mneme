import { createCatalogFacade } from "./catalog-facade.js";
import { Catalog } from "./catalog.js";
import { StagingBuffer } from "../write/staging.js";
import type { Corpus } from "./corpus.js";
import type { ClaimSchema } from "./schema.js";
import type { CandidateClaim } from "../core/claim.js";

const schema: ClaimSchema = {
  version: "1",
  subjects: ["test"],
  scopeFields: {},
  required: [],
  scalarPseudocount: {},
};

const demoCorpus: Corpus = {
  id: "demo-corpus",
  displayName: "Demo Corpus",
  schema,
  defaults: {
    decayPolicy: { kind: "none" },
    confidenceThreshold: 0.5,
    contradictionPolicy: { kind: "always_accept" },
    defaultStatus: [],
  },
  requiredTiers: [{ kind: "core" }],
  metadata: {},
  createdAt: 0,
  updatedAt: 0,
};

const cand: CandidateClaim = {
  workspace: "w" as any,
  profile: "p" as any,
  subject: "repo",
  key: "repo.x",
  scope: {},
  value: 1,
  confidence: { distribution: "beta" as const, parameters: { alpha: 9, beta: 1 }, raw: 0.9 },
  valid: { start: 0 },
  source: "manual" as const,
  provenance: { traceId: "t1" },
  evidence: [],
  tags: [],
  schema: "v1",
} as any;

function makeFacade() {
  const catalog = new Catalog([{ kind: "core" }]);
  const staging = new StagingBuffer();
  return { catalog, staging, facade: createCatalogFacade(catalog, staging) };
}

it("createCorpus delegates to Catalog.createCorpus and returns the corpus", () => {
  const { facade } = makeFacade();
  expect(facade.createCorpus(demoCorpus)).toEqual(demoCorpus);
});

it("deleteCorpus delegates to Catalog.deleteCorpus and throws for an unknown corpus", () => {
  const { facade } = makeFacade();
  facade.createCorpus(demoCorpus);
  facade.deleteCorpus(demoCorpus.id);
  expect(() => facade.deleteCorpus(demoCorpus.id)).toThrow(/unknown corpus/);
});

it("listCorpora delegates to Catalog.listCorpora, honoring an optional filter", () => {
  const { facade } = makeFacade();
  facade.createCorpus(demoCorpus);
  expect(facade.listCorpora()).toEqual([demoCorpus]);
  expect(facade.listCorpora((c) => c.id === "nope")).toEqual([]);
});

it("emitCandidate throws for an unknown corpus and stages for a known one", () => {
  const { facade } = makeFacade();
  facade.createCorpus(demoCorpus);
  expect(() => facade.emitCandidate("nope", cand)).toThrow(/unknown corpus "nope"/);
  const result = facade.emitCandidate(demoCorpus.id, cand);
  expect(result.stagingId).toBeTruthy();
});

it("listStaged reflects a staged candidate, filtered by corpusId when provided", () => {
  const { facade } = makeFacade();
  facade.createCorpus(demoCorpus);
  const { stagingId } = facade.emitCandidate(demoCorpus.id, cand);
  expect(facade.listStaged().map((e) => e.stagingId)).toEqual([stagingId]);
  expect(facade.listStaged(demoCorpus.id).map((e) => e.stagingId)).toEqual([stagingId]);
  expect(facade.listStaged("other-corpus")).toEqual([]);
});

it("discardStaged removes a staged entry and returns true, false when absent", () => {
  const { facade } = makeFacade();
  facade.createCorpus(demoCorpus);
  const { stagingId } = facade.emitCandidate(demoCorpus.id, cand);
  expect(facade.discardStaged(stagingId)).toBe(true);
  expect(facade.listStaged()).toEqual([]);
  expect(facade.discardStaged(stagingId)).toBe(false);
});

it("takeStaged removes and returns the full staged entry that promoteStaged glue relies on", () => {
  const { facade } = makeFacade();
  facade.createCorpus(demoCorpus);
  const { stagingId } = facade.emitCandidate(demoCorpus.id, cand, { idempotencyKey: "my-key" });
  const entry = facade.takeStaged(stagingId);
  expect(entry?.corpusId).toBe(demoCorpus.id);
  expect(entry?.candidate).toBe(cand);
  expect(entry?.idempotencyKey).toBe("my-key");
  expect(facade.listStaged()).toEqual([]);
  expect(facade.takeStaged(stagingId)).toBeUndefined();
});

it("takeAllStaged removes and returns all staged entries for a corpus, the promoteAllStaged glue", () => {
  const { facade } = makeFacade();
  facade.createCorpus(demoCorpus);
  const { stagingId: id1 } = facade.emitCandidate(demoCorpus.id, cand);
  const { stagingId: id2 } = facade.emitCandidate(demoCorpus.id, cand);
  facade.createCorpus({ ...demoCorpus, id: "other-corpus" });
  facade.emitCandidate("other-corpus", cand); // should not be returned

  const taken = facade.takeAllStaged(demoCorpus.id);
  expect(taken.map((e) => e.stagingId).sort()).toEqual([id1, id2].sort());
  expect(facade.listStaged(demoCorpus.id)).toEqual([]);
  expect(facade.listStaged("other-corpus")).toHaveLength(1);
});
