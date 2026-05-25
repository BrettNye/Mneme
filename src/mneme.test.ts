import { createMneme } from "./mneme.js";
import { createSqliteAdapter } from "./adapters/sqlite.js";
import { pipe, leaf, sigma, kappa, tau, rho } from "./mneme.js";
import type { ComposedContext } from "./algebra/types.js";
import type { Corpus as CorpusDef } from "./catalog/corpus.js";
import type { ClaimSchema } from "./catalog/schema.js";

const schema: ClaimSchema = {
  version: "1",
  subjects: ["workspace:canopy"],
  scopeFields: {},
  required: [],
  scalarPseudocount: { manual: 2 },
};

const corpusDef: CorpusDef = {
  id: "workspace:canopy",
  displayName: "Canopy Workspace",
  schema,
  defaults: {
    decayPolicy: { kind: "none" },
    confidenceThreshold: 0.5,
    contradictionPolicy: { kind: "always_accept" },
    defaultStatus: ["validated"],
  },
  requiredTiers: [{ kind: "core" }],
  metadata: {},
  createdAt: 0,
  updatedAt: 0,
};

it("createCorpus stores and returns the corpus definition", () => {
  const m = createMneme({ adapter: createSqliteAdapter(), availableTiers: [{ kind: "core" }] });
  const result = m.createCorpus(corpusDef);
  expect(result.id).toBe("workspace:canopy");
  expect(result.displayName).toBe("Canopy Workspace");
});

it("commit writes a claim and returns status=committed", () => {
  const m = createMneme({ adapter: createSqliteAdapter(), availableTiers: [{ kind: "core" }] });
  m.createCorpus(corpusDef);

  const result = m.commit("workspace:canopy", {
    profile: "profile-1" as any,
    workspace: "workspace:canopy" as any,
    subject: "lineage-block",
    key: "schema",
    scope: {},
    value: "the lineage block schema v1",
    confidence: { distribution: "beta", parameters: { alpha: 9, beta: 1 }, raw: 0.9 },
    valid: { from: 0, to: Infinity },
    source: "manual",
    provenance: {},
    evidence: [],
    tags: [],
    schema: "workspace:canopy@1",
  }, { writer: "test-writer" });

  expect(result.status).toBe("committed");
  expect(typeof result.id).toBe("string");
});

it("query returns a ComposedContext with the committed claim's value", () => {
  const adapter = createSqliteAdapter();
  const m = createMneme({ adapter, availableTiers: [{ kind: "core" }] });
  m.createCorpus(corpusDef);

  m.commit("workspace:canopy", {
    profile: "profile-1" as any,
    workspace: "workspace:canopy" as any,
    subject: "lineage-block",
    key: "schema",
    scope: {},
    value: "the lineage block schema v1",
    confidence: { distribution: "beta", parameters: { alpha: 9, beta: 1 }, raw: 0.9 },
    valid: { from: 0, to: Infinity },
    source: "manual",
    provenance: {},
    evidence: [],
    tags: [],
    schema: "workspace:canopy@1",
  }, { writer: "test-writer" });

  const ctx = m.query<ComposedContext>(
    "workspace:canopy",
    pipe(leaf("workspace:canopy"), rho.jaccard("lineage block schema"), kappa.xml(12000))
  );

  expect(ctx.format).toBe("xml");
  expect(ctx.tokenCount).toBeLessThanOrEqual(12000);
  expect(ctx.content).toContain("lineage block schema v1");
});

it("query with sigma filters by subject", () => {
  const adapter = createSqliteAdapter();
  const m = createMneme({ adapter, availableTiers: [{ kind: "core" }] });
  m.createCorpus(corpusDef);

  m.commit("workspace:canopy", {
    profile: "profile-1" as any,
    workspace: "workspace:canopy" as any,
    subject: "lineage-block",
    key: "schema",
    scope: {},
    value: "lineage block value",
    confidence: { distribution: "beta", parameters: { alpha: 9, beta: 1 }, raw: 0.9 },
    valid: { from: 0, to: Infinity },
    source: "manual",
    provenance: {},
    evidence: [],
    tags: [],
    schema: "workspace:canopy@1",
  }, { writer: "test-writer" });

  m.commit("workspace:canopy", {
    profile: "profile-1" as any,
    workspace: "workspace:canopy" as any,
    subject: "other-block",
    key: "schema",
    scope: {},
    value: "other block value",
    confidence: { distribution: "beta", parameters: { alpha: 9, beta: 1 }, raw: 0.9 },
    valid: { from: 0, to: Infinity },
    source: "manual",
    provenance: {},
    evidence: [],
    tags: [],
    schema: "workspace:canopy@1",
  }, { writer: "test-writer" });

  const ctx = m.query<ComposedContext>(
    "workspace:canopy",
    pipe(
      leaf("workspace:canopy"),
      sigma({ op: "subjectEq", value: "lineage-block" }),
      rho.jaccard("lineage block"),
      kappa.xml(12000)
    )
  );

  expect(ctx.content).toContain("lineage block value");
  expect(ctx.content).not.toContain("other block value");
});

it("commit uses corpus defaults.contradictionPolicy when policy is not specified", () => {
  const adapter = createSqliteAdapter();
  const m = createMneme({ adapter, availableTiers: [{ kind: "core" }] });
  m.createCorpus(corpusDef); // defaults to always_accept

  const r1 = m.commit("workspace:canopy", {
    profile: "profile-1" as any,
    workspace: "workspace:canopy" as any,
    subject: "subject-a",
    key: "k",
    scope: {},
    value: "first",
    confidence: { distribution: "beta", parameters: { alpha: 5, beta: 1 }, raw: 0.8 },
    valid: { from: 0, to: Infinity },
    source: "manual",
    provenance: {},
    evidence: [],
    tags: [],
    schema: "workspace:canopy@1",
  }, { writer: "w" });

  const r2 = m.commit("workspace:canopy", {
    profile: "profile-1" as any,
    workspace: "workspace:canopy" as any,
    subject: "subject-a",
    key: "k",
    scope: {},
    value: "second",
    confidence: { distribution: "beta", parameters: { alpha: 5, beta: 1 }, raw: 0.8 },
    valid: { from: 0, to: Infinity },
    source: "manual",
    provenance: {},
    evidence: [],
    tags: [],
    schema: "workspace:canopy@1",
  }, { writer: "w" });

  // always_accept => both committed
  expect(r1.status).toBe("committed");
  expect(r2.status).toBe("committed");
});

it("query throws when corpus is unknown", () => {
  const m = createMneme({ adapter: createSqliteAdapter(), availableTiers: [{ kind: "core" }] });
  expect(() => m.query("nonexistent", pipe(leaf("nonexistent"), kappa.xml(1000)))).toThrow();
});

it("tau.now() filters out claims not currently valid", () => {
  const adapter = createSqliteAdapter();
  const m = createMneme({ adapter, availableTiers: [{ kind: "core" }] });
  m.createCorpus(corpusDef);

  // claim valid in the distant past only
  m.commit("workspace:canopy", {
    profile: "profile-1" as any,
    workspace: "workspace:canopy" as any,
    subject: "past-subject",
    key: "k",
    scope: {},
    value: "past claim",
    confidence: { distribution: "beta", parameters: { alpha: 9, beta: 1 }, raw: 0.9 },
    valid: { from: 0, to: 1 }, // expired
    source: "manual",
    provenance: {},
    evidence: [],
    tags: [],
    schema: "workspace:canopy@1",
  }, { writer: "w" });

  const ctx = m.query<ComposedContext>(
    "workspace:canopy",
    pipe(leaf("workspace:canopy"), tau.now(), rho.jaccard("past claim"), kappa.xml(12000))
  );

  // The expired claim should be filtered out, so content should be empty (just wrapper tags)
  expect(ctx.content).not.toContain("past claim");
});
