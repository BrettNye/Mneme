import { replayStatus } from "./replay.js";
import { deriveClaimFrom } from "./derive.js";
import { serializeExpr } from "../algebra/serialize.js";
import { leaf, resolve } from "../algebra/ast.js";
import type { Claim } from "../core/claim.js";
import type { StorageAdapter, ExecutionPlan } from "../adapters/adapter.js";
import type { Catalog } from "../catalog/catalog.js";
import { MissingRule } from "../algebra/registries.js";
import * as expression from "../algebra/expression.js";
import { registerEmbeddingAdapter, embeddingAdapter } from "../algebra/embedding.js";
import { KEY_ALIAS_KEY, KEY_SUBJECT_PREFIX, aliasMapOf } from "../retrieval/key-alias.js";

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

  // Recorded claim has same value+confidence as inputClaim → claimsEquivalent = true.
  // recordedClaim is intentionally NOT in corpus "c" (no _corpusId set) so it doesn't
  // pollute re-execution: only inputClaim feeds the recomputed corpus.
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
  // "aggregate" is in parseExpr's known ops but compile() throws UnsupportedExprOp for it
  const adapter = makeAdapter();
  const catalog = makeCatalog(["c"]);

  const qe = JSON.stringify({
    op: "aggregate",
    fn: "count",
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

it("returns mismatch (not failed) when re-execution produces an empty corpus", () => {
  // A leaf("c") expression over corpus "c" that has no claims → empty corpus
  // The recorded claim cannot be reproduced: status should be "mismatch", not "failed"
  const adapter = makeAdapter();
  const catalog = makeCatalog(["c"]);

  // corpus "c" is intentionally empty — no claims with _corpusId === "c" in adapter

  const expr = leaf("c");
  const qe = serializeExpr(expr);

  const recordedClaim = makeClaim("recorded-empty-corpus-1", "was here", {
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
  // recordedClaim is NOT inserted into the adapter so it doesn't pollute corpus "c" re-execution

  const result = replayStatus(recordedClaim, adapter, catalog);
  expect(result.status).toBe("mismatch");
  expect(result.result).toBeUndefined();
  expect(result.missingDependencies).toHaveLength(0);
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

// ─── New: embedding_version checks ───────────────────────────────────────────

it("reports unavailable_models with kind:embedding_version when the adapter is absent", () => {
  const adapter = { getClaim: (_id: string) => ({ id: _id } as any) } as any;
  // "fake-model" is not registered — embeddingAdapter("fake-model") will throw
  const derived = {
    provenance: {
      derivedFrom: {
        evaluationClock: 1,
        inputClaims: [],
        similarityVersions: {},
        embeddingModelVersions: { "fake-model": "v1" },
      },
    },
  } as any;
  const result = replayStatus(derived, adapter);
  expect(result.status).toBe("unavailable_models");
  expect(result.missingDependencies).toHaveLength(1);
  expect(result.missingDependencies[0].kind).toBe("embedding_version");
  expect(result.missingDependencies[0].id).toBe("fake-model@v1");
});

it("reports unavailable_models with kind:embedding_version when adapter version drifted", () => {
  const adapter = { getClaim: (_id: string) => ({ id: _id } as any) } as any;
  // Register an adapter with version "v2" but the claim recorded "v1"
  registerEmbeddingAdapter({ id: "replay-version-drift", version: "v2", dim: 2, embed: async (t) => t.map(() => [0, 1]) });
  const derived = {
    provenance: {
      derivedFrom: {
        evaluationClock: 1,
        inputClaims: [],
        similarityVersions: {},
        embeddingModelVersions: { "replay-version-drift": "v1" },
      },
    },
  } as any;
  const result = replayStatus(derived, adapter);
  expect(result.status).toBe("unavailable_models");
  expect(result.missingDependencies).toHaveLength(1);
  expect(result.missingDependencies[0].kind).toBe("embedding_version");
  expect(result.missingDependencies[0].id).toBe("replay-version-drift@v1");
});

it("no missing dependency when registered adapter version matches recorded version", () => {
  // Register a fake adapter with matching version
  registerEmbeddingAdapter({ id: "replay-fake", version: "v1", dim: 2, embed: async (t) => t.map(() => [0, 1]) });
  const adapter = makeAdapter();
  const catalog = makeCatalog(["c"]);

  const inputClaim = makeClaim("input-emb-match-1", "val");
  (inputClaim as any)._corpusId = "c";
  adapter.insertBatch([inputClaim]);

  const qe = serializeExpr(leaf("c"));
  const recordedClaim = makeClaim("recorded-emb-match-1", inputClaim.value, {
    confidence: inputClaim.confidence,
    provenance: {
      derivedFrom: {
        queryExpression: qe,
        evaluationClock: 7,
        inputClaims: [inputClaim.id],
        similarityVersions: {},
        embeddingModelVersions: { "replay-fake": "v1" },
        corpusState: 1,
      },
    },
  } as any);
  adapter.insertBatch([recordedClaim]);

  const result = replayStatus(recordedClaim, adapter, catalog);
  // Matching version: should NOT produce unavailable_models for embedding_version
  // Should proceed to re-execution and return exact or mismatch (not unavailable_models with embedding_version)
  expect(result.missingDependencies.some((d) => d.kind === "embedding_version")).toBe(false);
});

it("empty embeddingModelVersions behaves as before (no embedding_version missing dep)", () => {
  const adapter = { getClaim: (_id: string) => ({ id: _id } as any) } as any;
  const derived = {
    provenance: {
      derivedFrom: {
        evaluationClock: 1,
        inputClaims: [],
        similarityVersions: {},
        embeddingModelVersions: {},
      },
    },
  } as any;
  // Should fail for re-execution (no queryExpression) but NOT produce embedding_version deps
  const result = replayStatus(derived, adapter);
  expect(result.missingDependencies.some((d) => d.kind === "embedding_version")).toBe(false);
});

it("absent embeddingModelVersions (legacy claim) behaves as before with no embedding_version deps", () => {
  const adapter = { getClaim: (_id: string) => ({ id: _id } as any) } as any;
  const derived = {
    provenance: {
      derivedFrom: {
        evaluationClock: 1,
        inputClaims: [],
        similarityVersions: {},
        // embeddingModelVersions deliberately absent
      },
    },
  } as any;
  const result = replayStatus(derived, adapter);
  expect(result.missingDependencies.some((d) => d.kind === "embedding_version")).toBe(false);
});

// ─── New: alias snapshot isolation ───────────────────────────────────────────

it("replays exact after the alias is re-pointed post-derivation", () => {
  // Setup: corpus "c" with one input claim and an alias claim preferred_editor→editor.
  // The alias is active at derivation time; after derivation, we supersede it with
  // preferred_editor→ide. The stored queryExpression has the old snapshot, so
  // re-execution uses the snapshotted alias map and returns "exact".

  const adapter = makeAdapter();
  const catalog = makeCatalog(["c"]);

  // Input claim
  const inputClaim = makeClaim("input-alias-replay-1", "vscode");
  (inputClaim as any)._corpusId = "c";
  adapter.insertBatch([inputClaim]);

  // Alias claim: preferred_editor → editor (active at t=5000)
  const aliasClaim = makeClaim("alias-claim-1", "editor", {
    subject: `${KEY_SUBJECT_PREFIX}preferred_editor`,
    key: KEY_ALIAS_KEY,
    valueHash: "alias-hash",
    status: "active",
    valid: { from: 0, to: Number.MAX_SAFE_INTEGER },
    recorded: 5000,
    recordedSeq: 5,
  } as any);
  (aliasClaim as any)._corpusId = "c";
  adapter.insertBatch([aliasClaim]);

  // Derive at evaluationClock=6000 with the resolve node.
  // deriveClaimFrom will snapshot the alias map {preferred_editor:"editor"} into the queryExpression.
  const richCatalog = {
    getCorpus: (_id: string) => ({
      defaults: { confidenceThreshold: 0.1 },
      schema: { keyCardinality: undefined },
    }),
  } as any;

  const derived = deriveClaimFrom(
    adapter,
    richCatalog,
    resolve("resolveDeprecateOlder", leaf("c")),
    { subject: "t", key: "t.k", scope: {}, evaluationClock: 6000 },
  );

  // Verify the snapshot was captured
  const storedExpr = JSON.parse(derived.provenance!.derivedFrom!.queryExpression);
  expect(storedExpr.keyAliases).toEqual({ preferred_editor: "editor" });

  // Now supersede the alias: preferred_editor → ide (re-point post-derivation)
  const newAliasClaim = makeClaim("alias-claim-2", "ide", {
    subject: `${KEY_SUBJECT_PREFIX}preferred_editor`,
    key: KEY_ALIAS_KEY,
    valueHash: "alias-hash-2",
    status: "active",
    valid: { from: 7000, to: Number.MAX_SAFE_INTEGER },
    recorded: 7000,
    recordedSeq: 7,
  } as any);
  (newAliasClaim as any)._corpusId = "c";
  adapter.insertBatch([newAliasClaim]);

  // Insert the derived claim into the adapter as a proper Claim (for replayStatus getClaim checks)
  const storedClaim = makeClaim("derived-alias-replay-1", String(derived.value), {
    confidence: derived.confidence,
    provenance: derived.provenance,
  } as any);
  (storedClaim as any)._corpusId = "c";
  adapter.insertBatch([storedClaim]);

  // replayStatus should return "exact": the stored queryExpression has keyAliases snapshotted,
  // so re-execution uses the old map and reproduces the same result.
  const result = replayStatus(storedClaim, adapter, catalog);
  expect(result.status).toBe("exact");
});

it("replays exact after the alias is un-ratified post-derivation (self-alias supersession)", () => {
  // Setup: corpus "c" with one input claim and an alias claim preferred_editor→editor.
  // The alias is active at derivation time; after derivation, we append a self-alias
  // (preferred_editor→preferred_editor) with a later recorded/valid.from, which supersedes
  // the previous alias under resolveDeprecateOlder and un-ratifies it.
  // The stored queryExpression still has {preferred_editor:"editor"} snapshotted, so
  // re-execution uses the snapshot and returns "exact".

  const adapter = makeAdapter();
  const catalog = makeCatalog(["c"]);

  // Input claim
  const inputClaim = makeClaim("input-alias-unratify-1", "vscode");
  (inputClaim as any)._corpusId = "c";
  adapter.insertBatch([inputClaim]);

  // Alias claim: preferred_editor → editor (active at t=5000)
  const aliasClaim = makeClaim("alias-unratify-claim-1", "editor", {
    subject: `${KEY_SUBJECT_PREFIX}preferred_editor`,
    key: KEY_ALIAS_KEY,
    valueHash: "alias-hash-ur",
    status: "active",
    valid: { from: 0, to: Number.MAX_SAFE_INTEGER },
    recorded: 5000,
    recordedSeq: 5,
  } as any);
  (aliasClaim as any)._corpusId = "c";
  adapter.insertBatch([aliasClaim]);

  // Derive at evaluationClock=6000 with the resolve node.
  // deriveClaimFrom will snapshot the alias map {preferred_editor:"editor"} into the queryExpression.
  const richCatalog = {
    getCorpus: (_id: string) => ({
      defaults: { confidenceThreshold: 0.1 },
      schema: { keyCardinality: undefined },
    }),
  } as any;

  const derived = deriveClaimFrom(
    adapter,
    richCatalog,
    resolve("resolveDeprecateOlder", leaf("c")),
    { subject: "t", key: "t.k", scope: {}, evaluationClock: 6000 },
  );

  // Verify the snapshot was captured
  const storedExpr = JSON.parse(derived.provenance!.derivedFrom!.queryExpression);
  expect(storedExpr.keyAliases).toEqual({ preferred_editor: "editor" });

  // Now un-ratify: append a NEWER self-alias claim (value = the variant itself)
  // This supersedes the previous alias under resolveDeprecateOlder (later valid.from/recorded).
  const selfAliasClaim = makeClaim("alias-unratify-claim-2", "preferred_editor", {
    subject: `${KEY_SUBJECT_PREFIX}preferred_editor`,
    key: KEY_ALIAS_KEY,
    valueHash: "alias-hash-self",
    status: "active",
    valid: { from: 7000, to: Number.MAX_SAFE_INTEGER },
    recorded: 7000,
    recordedSeq: 7,
  } as any);
  (selfAliasClaim as any)._corpusId = "c";
  adapter.insertBatch([selfAliasClaim]);

  // Verify that after un-ratify, aliasMapOf no longer resolves preferred_editor→editor
  // (self-alias is excluded from the map). This confirms the live state has changed.
  const allClaims = [...adapter._store.values()].filter(
    (c: any) => c._corpusId === "c",
  );
  const liveAlias = aliasMapOf(allClaims, { evaluationInstant: 8000 });
  expect(liveAlias.map["preferred_editor"]).toBeUndefined();
  expect(liveAlias.selfAliases).toContain("preferred_editor");

  // Insert the derived claim into the adapter as a proper Claim (for replayStatus getClaim checks)
  const storedClaim = makeClaim("derived-alias-unratify-1", String(derived.value), {
    confidence: derived.confidence,
    provenance: derived.provenance,
  } as any);
  (storedClaim as any)._corpusId = "c";
  adapter.insertBatch([storedClaim]);

  // replayStatus should return "exact": the stored queryExpression has keyAliases snapshotted,
  // so re-execution uses the old map (preferred_editor→editor) and reproduces the same result,
  // even though the live alias map has been un-ratified.
  const result = replayStatus(storedClaim, adapter, catalog);
  expect(result.status).toBe("exact");
});
