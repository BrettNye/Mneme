import { Catalog } from "./catalog.js";
import type { Corpus } from "./corpus.js";
import type { ClaimSchema } from "./schema.js";

// Minimal valid ClaimSchema for tests
const schema: ClaimSchema = {
  version: "1",
  subjects: ["test"],
  scopeFields: {},
  required: [],
  scalarPseudocount: {},
};

// Minimal valid Corpus literal
const minimalCorpus: Corpus = {
  id: "test-corpus",
  displayName: "Test Corpus",
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

it("rejects a corpus whose required tier is unavailable at create time", () => {
  const cat = new Catalog([{ kind: "core" }]);
  expect(() =>
    cat.createCorpus({
      requiredTiers: [{ kind: "protocol", name: "dirichlet" }],
    } as any)
  ).toThrow(/dirichlet/);
});

it("accepts createCorpus with requiredTiers=[core] against a core deployment", () => {
  const cat = new Catalog([{ kind: "core" }]);
  const result = cat.createCorpus(minimalCorpus);
  expect(result).toEqual(minimalCorpus);
});

it("retrieves a corpus by id via getCorpus", () => {
  const cat = new Catalog([{ kind: "core" }]);
  cat.createCorpus(minimalCorpus);
  expect(cat.getCorpus("test-corpus")).toEqual(minimalCorpus);
});

it("retrieves a corpus schema via getCorpusSchema", () => {
  const cat = new Catalog([{ kind: "core" }]);
  cat.createCorpus(minimalCorpus);
  expect(cat.getCorpusSchema("test-corpus")).toEqual(schema);
});

it("throws a typed error for getCorpus with unknown id", () => {
  const cat = new Catalog([{ kind: "core" }]);
  expect(() => cat.getCorpus("unknown-id")).toThrow(/unknown corpus "unknown-id"/);
});

it("throws a typed error for getCorpusSchema with unknown id", () => {
  const cat = new Catalog([{ kind: "core" }]);
  expect(() => cat.getCorpusSchema("missing")).toThrow(/unknown corpus "missing"/);
});

it("rejects a corpus requiring an unavailable profile tier", () => {
  const cat = new Catalog([{ kind: "core" }]);
  expect(() =>
    cat.createCorpus({
      ...minimalCorpus,
      requiredTiers: [{ kind: "profile", name: "medical" }],
    } as Corpus)
  ).toThrow(/medical/);
});

// A second corpus fixture for discovery/deletion tests
const secondCorpus: Corpus = {
  ...minimalCorpus,
  id: "second-corpus",
  displayName: "Second Corpus",
  metadata: { kind: "secondary" },
};

it("listCorpora returns all registered corpora", () => {
  const cat = new Catalog([{ kind: "core" }]);
  cat.createCorpus(minimalCorpus);
  cat.createCorpus(secondCorpus);
  const all = cat.listCorpora();
  expect(all).toHaveLength(2);
  expect(all).toEqual(expect.arrayContaining([minimalCorpus, secondCorpus]));
});

it("listCorpora returns an empty array when no corpora exist", () => {
  const cat = new Catalog([{ kind: "core" }]);
  expect(cat.listCorpora()).toEqual([]);
});

it("listCorpora narrows results with a predicate filter", () => {
  const cat = new Catalog([{ kind: "core" }]);
  cat.createCorpus(minimalCorpus);
  cat.createCorpus(secondCorpus);
  const filtered = cat.listCorpora((c) => c.id === "second-corpus");
  expect(filtered).toEqual([secondCorpus]);
});

it("deleteCorpus removes a corpus so listCorpora returns the remainder", () => {
  const cat = new Catalog([{ kind: "core" }]);
  cat.createCorpus(minimalCorpus);
  cat.createCorpus(secondCorpus);
  cat.deleteCorpus("test-corpus");
  expect(cat.listCorpora()).toEqual([secondCorpus]);
});

it("deleteCorpus makes the deleted id unresolvable via getCorpus", () => {
  const cat = new Catalog([{ kind: "core" }]);
  cat.createCorpus(minimalCorpus);
  cat.deleteCorpus("test-corpus");
  expect(() => cat.getCorpus("test-corpus")).toThrow(/unknown corpus "test-corpus"/);
});

it("deleteCorpus throws a typed error for an unknown id", () => {
  const cat = new Catalog([{ kind: "core" }]);
  expect(() => cat.deleteCorpus("nope")).toThrow(/unknown corpus "nope"/);
});
