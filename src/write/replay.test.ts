import { replayStatus } from "./replay.js";
import { serializeExpr } from "../algebra/serialize.js";
import { leaf } from "../algebra/ast.js";
import type { Claim } from "../core/claim.js";
import type { StorageAdapter, ExecutionPlan } from "../adapters/adapter.js";
import type { Catalog } from "../catalog/catalog.js";
import { MissingRule } from "../algebra/registries.js";
import * as expression from "../algebra/expression.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeClaim(
  id: string,
  value: unknown,
  overrides: Partial<Claim> = {},
): Claim {
  return {
    id,
    profile: "p1" as any,
    workspace: "w1" as any,
    subject: "s",
    key: "s.k",
    scope: {},
    scopeHash: "scope-hash",
    value,
    valueHash: "val-hash",
    confidence: { distribution: "beta", parameters: { alpha: 9, beta: 1 }, raw: 0.9 },
    valid: { from: 0, to: Number.MAX_SAFE_INTEGER },
    recorded: 1000,
    recordedSeq: 1,
    status: "validated",
    source: "workflow",
    provenance: {},
    evidence: [],
    tags: [],
    schema: "",
    ...overrides,
  } as unknown as Claim;
}

function makeAdapter(): StorageAdapter & {
  _store: Map<string, Claim>;
} {
  const store = new Map<string, Claim>();
  return {
    _store: store,
    insertClaim: (c: Claim) => { store.set(c.id, c); },
    getClaim: (id: string) => store.get(id as any),
    deleteClaim: (id: string) => { store.delete(id as any); },
    insertBatch: (cs: Claim[]) => { for (const c of cs) store.set(c.id, c); },
    // Filter by _corpusId property that test claims carry
    query: (plan: ExecutionPlan) =>
      [...store.values()].filter((c) => (c as any)._corpusId === plan.corpusId),
    getIdempotencyRecord: () => undefined,
    putIdempotencyRecord: () => {},
    capabilities: () => ({
      valuePredicateSupport: {
        equality: "native_indexed",
        range: "native_unindexed",
        set_membership: "fallback_in_memory",
        regex: "unsupported",
        structural_pattern: "fallback_in_memory",
        null_check: "native_indexed",
      },
    }),
    transaction: <T>(fn: () => T) => fn(),
    maxRecordedSeq: () => store.size,
    appendEvent: () => {},
    readEvents: () => [],
  } as any;
}

function makeCatalog(corpusIds: string[]): Catalog {
  return {
    getCorpus: (id: string) => {
      if (corpusIds.includes(id)) return {} as any;
      throw new Error(`unknown corpus "${id}"`);
    },
  } as any;
}

// ─── Pre-existing degraded-path tests ────────────────────────────────────────
// These tests use the 2-arg overload (no catalog) to stay backward-compatible.
// They rely on paths that fire before re-execution (or where re-execution
// throws a non-MissingRule error → "failed").

it("reports integrity_unknown for a claim with no derivedFrom provenance", () => {
  const adapter = { getClaim: (_id: string) => ({ id: _id } as any) } as any;
  const plain = { provenance: {} } as any;
  expect(replayStatus(plain, adapter).status).toBe("integrity_unknown");
});

it("reports missing_inputs when a recorded input claim is absent from the adapter", () => {
  const adapter = { getClaim: (id: string) => (id === "present" ? ({ id } as any) : undefined) } as any;
  // NOTE: no queryExpression field → undefined; does NOT trigger the "" early-return guard.
  const derived = {
    provenance: {
      derivedFrom: {
        evaluationClock: 1,
        inputClaims: ["gone"],
        similarityVersions: {},
        embeddingModelVersions: {},
      },
    },
  } as any;
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

it("returns failed when all inputs/versions resolve and queryExpression is absent (re-execution parse fails)", () => {
  // queryExpression is undefined → parseExpr(undefined) throws → catch → "failed"
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

it("never returns exact status for legacy/degraded-path claims", () => {
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

// ─── New: empty queryExpression ("") → integrity_unknown ─────────────────────

it("returns integrity_unknown when queryExpression is empty string (v0.1-era, no AST recorded)", () => {
  const adapter = makeAdapter();
  const catalog = makeCatalog([]);
  const derived = {
    provenance: {
      derivedFrom: {
        evaluationClock: 1,
        inputClaims: [],
        similarityVersions: {},
        embeddingModelVersions: {},
        queryExpression: "",
      },
    },
  } as any;
  const result = replayStatus(derived, adapter, catalog);
  expect(result.status).toBe("integrity_unknown");
  expect(result.missingDependencies).toHaveLength(0);
});

// ─── New: re-execution integration tests ─────────────────────────────────────

it("returns exact when re-execution reproduces the recorded claim value+confidence", () => {
  const adapter = makeAdapter();
  const catalog = makeCatalog(["c"]);

  // One input claim in corpus "c"
  const inputClaim = makeClaim("input-exact-1", "hello");
  (inputClaim as any)._corpusId = "c";
  adapter.insertBatch([inputClaim]);

  // leaf("c") evaluates to corpus [inputClaim]; representative = last = inputClaim
  const expr = leaf("c");
  const qe = serializeExpr(expr);

  // Recorded claim has same value+confidence as inputClaim → claimsEquivalent = true
  const recordedClaim = makeClaim("recorded-exact-1", inputClaim.value, {
    confidence: inputClaim.confidence,
    provenance: {
      derivedFrom: {
        queryExpression: qe,
        evaluationClock: 7,
        inputClaims: [inputClaim.id],
        similarityVersions: {},
        embeddingModelVersions: {},
        corpusState: 1,
      },
    },
  } as any);
  adapter.insertBatch([recordedClaim]);

  const result = replayStatus(recordedClaim, adapter, catalog);
  expect(result.status).toBe("exact");
  expect(result.result).toBeDefined();
  expect(result.missingDependencies).toHaveLength(0);
});

it("returns mismatch with recomputed claim when a contributing claim is perturbed after recording", () => {
  const adapter = makeAdapter();
  const catalog = makeCatalog(["c"]);

  // Original input claim
  const inputClaim = makeClaim("input-mismatch-1", "original value");
  (inputClaim as any)._corpusId = "c";
  adapter.insertBatch([inputClaim]);

  const expr = leaf("c");
  const qe = serializeExpr(expr);

  // Recorded claim has "original value"
  const recordedClaim = makeClaim("recorded-mismatch-1", "original value", {
    confidence: inputClaim.confidence,
    provenance: {
      derivedFrom: {
        queryExpression: qe,
        evaluationClock: 7,
        inputClaims: [inputClaim.id],
        similarityVersions: {},
        embeddingModelVersions: {},
        corpusState: 1,
      },
    },
  } as any);
  adapter.insertBatch([recordedClaim]);

  // Perturb: replace the input claim with a different value (same id)
  const mutatedInput = makeClaim("input-mismatch-1", "perturbed value");
  (mutatedInput as any)._corpusId = "c";
  adapter._store.set(mutatedInput.id, mutatedInput);

  const result = replayStatus(recordedClaim, adapter, catalog);
  expect(result.status).toBe("mismatch");
  expect(result.result).toBeDefined();
});

it("returns failed when queryExpression encodes an unsupported op (UnsupportedExprOp from compile)", () => {
  // "resolve" is in parseExpr's known ops but compile() throws UnsupportedExprOp for it
  const adapter = makeAdapter();
  const catalog = makeCatalog(["c"]);

  const qe = JSON.stringify({
    op: "resolve",
    policy: "resolveKeepBoth",
    src: { op: "leaf", corpusId: "c" },
  });

  const recordedClaim = makeClaim("recorded-unsupported-1", "val", {
    provenance: {
      derivedFrom: {
        queryExpression: qe,
        evaluationClock: 7,
        inputClaims: [],
        similarityVersions: {},
        embeddingModelVersions: {},
        corpusState: 1,
      },
    },
  } as any);
  adapter.insertBatch([recordedClaim]);

  const result = replayStatus(recordedClaim, adapter, catalog);
  expect(result.status).toBe("failed");
});

it("returns unavailable_models with kind:rule when evaluate throws MissingRule", () => {
  // No current supported compile op throws MissingRule from registries.ts, so we spy on
  // expression.evaluate to simulate a future synthesis/resolution op that throws it.
  // replay.ts uses `import * as expression` so vi.spyOn can intercept the call.
  const adapter = makeAdapter();
  const catalog = makeCatalog(["c"]);

  const inputClaim = makeClaim("input-missing-rule-1", "val");
  (inputClaim as any)._corpusId = "c";
  adapter.insertBatch([inputClaim]);

  const qe = serializeExpr(leaf("c"));

  const recordedClaim = makeClaim("recorded-missing-rule-1", "val", {
    provenance: {
      derivedFrom: {
        queryExpression: qe,
        evaluationClock: 7,
        inputClaims: [],
        similarityVersions: {},
        embeddingModelVersions: {},
        corpusState: 1,
      },
    },
  } as any);

  const spy = vi.spyOn(expression, "evaluate").mockImplementationOnce(() => {
    throw new MissingRule("synthesis", "nonexistent_rule");
  });

  try {
    const result = replayStatus(recordedClaim, adapter, catalog);
    expect(result.status).toBe("unavailable_models");
    expect(result.missingDependencies).toHaveLength(1);
    expect(result.missingDependencies[0].kind).toBe("rule");
    expect(result.missingDependencies[0].id).toBe("synthesis:nonexistent_rule");
  } finally {
    spy.mockRestore();
  }
});

it("uses evaluationClock from provenance (not wall-clock) for re-execution", () => {
  // Spy on expression.evaluate to capture the ctx passed in
  const adapter = makeAdapter();
  const catalog = makeCatalog(["c"]);

  const inputClaim = makeClaim("input-clock-1", "clocked");
  (inputClaim as any)._corpusId = "c";
  adapter.insertBatch([inputClaim]);

  const pinnedClock = 12345;
  const qe = serializeExpr(leaf("c"));

  const recordedClaim = makeClaim("recorded-clock-1", "clocked", {
    confidence: inputClaim.confidence,
    provenance: {
      derivedFrom: {
        queryExpression: qe,
        evaluationClock: pinnedClock,
        inputClaims: [inputClaim.id],
        similarityVersions: {},
        embeddingModelVersions: {},
        corpusState: 1,
      },
    },
  } as any);
  adapter.insertBatch([recordedClaim]);

  let capturedClock: number | undefined;
  const realEvaluate = expression.evaluate;
  const spy = vi.spyOn(expression, "evaluate").mockImplementationOnce((stages: any, ctx: any) => {
    capturedClock = ctx.evaluationClock;
    return realEvaluate(stages, ctx);
  });

  try {
    replayStatus(recordedClaim, adapter, catalog);
    expect(capturedClock).toBe(pinnedClock);
  } finally {
    spy.mockRestore();
  }
});
