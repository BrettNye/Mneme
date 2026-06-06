import { deriveClaimFrom, stampResolveDefaults } from "./derive.js";
import { leaf, sigma, resolve } from "../algebra/ast.js";
import { serializeExpr, parseExpr } from "../algebra/serialize.js";
import { evaluate } from "../algebra/expression.js";
import { compile } from "../algebra/compile.js";
import type { ExprNode } from "../algebra/ast.js";
import type { Claim } from "../core/claim.js";
import { KEY_ALIAS_KEY, KEY_SUBJECT_PREFIX } from "../retrieval/key-alias.js";
import type { Corpus } from "../algebra/types.js";

// Minimal claim factory
function makeClaim(id: string, value: string, confidence = 0.9): Claim {
  return {
    id,
    subject: "s",
    key: "s.k",
    value,
    confidence: { distribution: "beta", parameters: { alpha: 9, beta: 1 }, raw: confidence },
    evidence: [],
    tags: [],
    source: "workflow",
    status: "active",
    scope: {},
    valueHash: `vh-${value}`,
    corpusId: "test-corpus",
    recorded: 1000,
    recordedSeq: 1,
  } as unknown as Claim;
}

/** Creates a minimal alias-of claim for testing: subject = "key:<variant>", key = "alias-of", value = canonical */
function makeAliasClaim(id: string, variant: string, canonical: string, recordedSeq = 1): Claim {
  return {
    id,
    subject: `${KEY_SUBJECT_PREFIX}${variant}`,
    key: KEY_ALIAS_KEY,
    value: canonical,
    confidence: { distribution: "beta", parameters: { alpha: 9, beta: 1 }, raw: 0.9 },
    evidence: [],
    tags: [],
    source: "workflow",
    status: "active",
    scope: {},
    valueHash: `vh-alias-${variant}`,
    corpusId: "test-corpus",
    recorded: 1000,
    recordedSeq,
    valid: { from: 0, to: Number.MAX_SAFE_INTEGER },
  } as unknown as Claim;
}

// Minimal adapter factory — seeded with a claim list; recordedSeq controls maxRecordedSeq()
function makeAdapter(claims: Claim[] = [], recordedSeq = 42) {
  return {
    query: () => claims,
    getClaim: (id: string) => claims.find((c) => c.id === id),
    maxRecordedSeq: () => recordedSeq,
    insertClaim: () => {},
    deleteClaim: () => {},
    insertBatch: () => {},
    getIdempotencyRecord: () => undefined,
    putIdempotencyRecord: () => {},
    capabilities: () => ({ valuePredicateSupport: {} as any }),
    transaction: <T>(fn: () => T) => fn(),
    appendEvent: () => {},
    readEvents: () => [],
  } as any;
}

// Minimal catalog — getCorpus must not throw for "test-corpus"
const catalog = { getCorpus: (_id: string) => ({}) } as any;

// Rich catalog factory for stamping tests — corpus carries defaults + schema keyCardinality
function makeRichCatalog(opts: {
  confidenceThreshold: number;
  keyCardinality?: Record<string, "single" | "multi">;
}) {
  return {
    getCorpus: (_id: string) => ({
      defaults: { confidenceThreshold: opts.confidenceThreshold },
      schema: { keyCardinality: opts.keyCardinality },
    }),
  } as any;
}

describe("deriveClaimFrom (ExprNode API)", () => {
  it("records a non-empty queryExpression equal to serializeExpr(expr)", () => {
    const inputClaim = makeClaim("in-1", "hello");
    const adapter = makeAdapter([inputClaim], 99);
    const expr: ExprNode = leaf("test-corpus");
    const cand = deriveClaimFrom(adapter, catalog, expr, {
      subject: "t",
      key: "t.k",
      scope: {},
      evaluationClock: 1234,
    });
    expect(cand.provenance!.derivedFrom!.queryExpression).not.toBe("");
    expect(cand.provenance!.derivedFrom!.queryExpression).toBe(serializeExpr(expr));
  });

  it("records corpusState from adapter.maxRecordedSeq()", () => {
    const inputClaim = makeClaim("in-1", "hello");
    const adapter = makeAdapter([inputClaim], 99);
    const expr: ExprNode = leaf("test-corpus");
    const cand = deriveClaimFrom(adapter, catalog, expr, {
      subject: "t",
      key: "t.k",
      scope: {},
      evaluationClock: 1234,
    });
    expect(cand.provenance!.derivedFrom!.corpusState).toBe(99);
  });

  it("captures inputClaims, evaluationClock, and combinationRule into derivedFrom", () => {
    // Two claims: [claimA, claimB]; rep = last (claimB); inputClaims = [claimA.id]
    const claimA = makeClaim("in-1", "v-a");
    const claimB = makeClaim("in-2", "v-b");
    const adapter = makeAdapter([claimA, claimB], 7);
    const expr: ExprNode = leaf("test-corpus");
    const cand = deriveClaimFrom(adapter, catalog, expr, {
      subject: "t",
      key: "t.k",
      scope: {},
      combination: "rule_weighted_avg",
      evaluationClock: 1234,
    });
    // rep is claimB (last), inputClaims is [claimA.id]
    expect(cand.provenance!.derivedFrom?.inputClaims).toEqual(["in-1"]);
    expect(cand.provenance!.derivedFrom?.evaluationClock).toBe(1234);
    expect(cand.provenance!.derivedFrom?.combinationRule).toBe("rule_weighted_avg");
  });

  it("records inputHashes mapping each input claim id to its content valueHash (App H.3 banked prerequisite)", () => {
    // rep = claimB (last, excluded); input = claimA only. inputHashes anchors the
    // input's content so a future erasure/integrity-verifiable replay can survive
    // erasure of the input — irreversible, so it must be recorded at derive time.
    const claimA = makeClaim("in-1", "v-a");
    const claimB = makeClaim("in-2", "v-b");
    const adapter = makeAdapter([claimA, claimB], 7);
    const cand = deriveClaimFrom(adapter, catalog, leaf("test-corpus"), {
      subject: "t",
      key: "t.k",
      scope: {},
      evaluationClock: 1234,
    });
    expect(cand.provenance!.derivedFrom?.inputHashes).toEqual({ "in-1": "vh-v-a" });
  });

  it("throws when the pipeline produces an empty corpus", () => {
    // No claims in adapter -> leaf returns empty corpus
    const adapter = makeAdapter([], 5);
    const expr: ExprNode = leaf("test-corpus");
    expect(() =>
      deriveClaimFrom(adapter, catalog, expr, {
        subject: "t",
        key: "t.k",
        scope: {},
        evaluationClock: 1,
      })
    ).toThrow("deriveClaimFrom: pipeline produced no claims; cannot derive a representative");
  });

  it("uses the LAST claim as representative and excludes it from inputClaims", () => {
    const claimA = makeClaim("id-a", "alpha", 0.8);
    const claimB = makeClaim("id-b", "beta", 0.9);
    const adapter = makeAdapter([claimA, claimB], 10);
    const expr: ExprNode = leaf("test-corpus");
    const cand = deriveClaimFrom(adapter, catalog, expr, {
      subject: "t",
      key: "t.k",
      scope: {},
      evaluationClock: 42,
    });
    // representative is claimB (last)
    expect(cand.value).toBe("beta");
    expect(cand.confidence).toEqual(claimB.confidence);
    // inputClaims contains claimA but NOT claimB
    expect(cand.provenance!.derivedFrom?.inputClaims).toEqual(["id-a"]);
    expect(cand.provenance!.derivedFrom?.inputClaims).not.toContain("id-b");
  });

  it("sigma(subjectEq) filters claims before rep selection", () => {
    // Only claimA matches subject "s"; claimB has subject "other"
    const claimA = makeClaim("id-a", "alpha");
    const claimB = { ...makeClaim("id-b", "beta"), subject: "other" } as unknown as Claim;
    const adapter = makeAdapter([claimA, claimB], 20);
    // sigma filters to only subject "s" claims -> only claimA in corpus
    const expr: ExprNode = sigma({ op: "subjectEq", value: "s" }, leaf("test-corpus"));
    const cand = deriveClaimFrom(adapter, catalog, expr, {
      subject: "t",
      key: "t.k",
      scope: {},
      evaluationClock: 10,
    });
    // Only claimA passed through, so rep = claimA; inputClaims = []
    expect(cand.value).toBe("alpha");
    expect(cand.provenance!.derivedFrom?.inputClaims).toEqual([]);
    expect(cand.provenance!.derivedFrom!.queryExpression).toBe(serializeExpr(expr));
  });
});

describe("stampResolveDefaults", () => {
  it("stamps corpus confidenceThreshold and keyCardinality onto an unstamped resolve node", () => {
    const richCatalog = makeRichCatalog({
      confidenceThreshold: 0.5,
      keyCardinality: { hobby: "multi" },
    });
    const expr = resolve("resolveDeprecateOlder", leaf("test-corpus"));
    const stamped = stampResolveDefaults(expr, richCatalog);
    expect((stamped as any).threshold).toBe(0.5);
    expect((stamped as any).keyCardinality).toEqual({ hobby: "multi" });
  });

  it("does NOT add keyCardinality when schema has none — field must be absent", () => {
    const richCatalog = makeRichCatalog({ confidenceThreshold: 0.7 });
    // no keyCardinality in schema
    const expr = resolve("resolveDeprecateOlder", leaf("test-corpus"));
    const stamped = stampResolveDefaults(expr, richCatalog);
    expect((stamped as any).threshold).toBe(0.7);
    expect("keyCardinality" in stamped).toBe(false);
  });

  it("explicit threshold wins over corpus default — corpus default NOT applied", () => {
    const richCatalog = makeRichCatalog({
      confidenceThreshold: 0.5,
      keyCardinality: { k: "single" },
    });
    const expr = resolve("resolveDeprecateOlder", leaf("test-corpus"), undefined, 0.9, { k: "single" });
    const stamped = stampResolveDefaults(expr, richCatalog);
    expect((stamped as any).threshold).toBe(0.9);
    expect((stamped as any).keyCardinality).toEqual({ k: "single" });
  });

  it("explicit keyCardinality wins over schema default — corpus schema NOT applied", () => {
    const richCatalog = makeRichCatalog({
      confidenceThreshold: 0.5,
      keyCardinality: { k: "multi" },
    });
    const expr = resolve("resolveDeprecateOlder", leaf("test-corpus"), undefined, 0.9, { k: "single" });
    const stamped = stampResolveDefaults(expr, richCatalog);
    // explicit k: "single" wins, not corpus schema k: "multi"
    expect((stamped as any).keyCardinality).toEqual({ k: "single" });
  });

  it("is pure: does not mutate the input expression", () => {
    const richCatalog = makeRichCatalog({
      confidenceThreshold: 0.5,
      keyCardinality: { hobby: "multi" },
    });
    const expr = resolve("resolveDeprecateOlder", leaf("test-corpus"));
    const exprBefore = JSON.parse(JSON.stringify(expr));
    stampResolveDefaults(expr, richCatalog);
    expect(expr).toEqual(exprBefore);
  });

  it("passes through non-resolve nodes unchanged (rebuilds with stamped src)", () => {
    const richCatalog = makeRichCatalog({ confidenceThreshold: 0.5, keyCardinality: { k: "multi" } });
    // sigma wrapping a resolve — sigma should pass through, resolve gets stamped
    const inner = resolve("resolveDeprecateOlder", leaf("test-corpus"));
    const expr = sigma({ op: "subjectEq", value: "s" }, inner);
    const stamped = stampResolveDefaults(expr, richCatalog);
    expect((stamped as any).op).toBe("sigma");
    expect((stamped as any).src.threshold).toBe(0.5);
    expect((stamped as any).src.keyCardinality).toEqual({ k: "multi" });
  });

  it("stamped expression parses cleanly (parseExpr succeeds with threshold present)", () => {
    const richCatalog = makeRichCatalog({ confidenceThreshold: 0.42 });
    const expr = resolve("resolveDeprecateOlder", leaf("test-corpus"));
    const stamped = stampResolveDefaults(expr, richCatalog);
    // serializeExpr + parseExpr round-trip must succeed
    const parsed = parseExpr(serializeExpr(stamped));
    expect((parsed as any).threshold).toBe(0.42);
  });
});

describe("deriveClaimFrom stamping integration", () => {
  it("stamps corpus confidenceThreshold and keyCardinality into queryExpression", () => {
    const richCatalog = makeRichCatalog({
      confidenceThreshold: 0.5,
      keyCardinality: { hobby: "multi" },
    });
    const inputClaim = makeClaim("in-1", "hello");
    const adapter = makeAdapter([inputClaim], 42);
    const cand = deriveClaimFrom(
      adapter,
      richCatalog,
      resolve("resolveDeprecateOlder", leaf("test-corpus")),
      { subject: "t", key: "t.k", scope: {}, evaluationClock: 1000 },
    );
    const expr = JSON.parse(cand.provenance!.derivedFrom!.queryExpression);
    expect(expr.threshold).toBe(0.5);
    expect(expr.keyCardinality).toEqual({ hobby: "multi" });
  });

  it("replay determinism: mutating corpus default does not affect stored queryExpression threshold", () => {
    const corpusObj = {
      defaults: { confidenceThreshold: 0.5 },
      schema: { keyCardinality: undefined as Record<string, "single" | "multi"> | undefined },
    };
    const mutableCatalog = { getCorpus: (_id: string) => corpusObj } as any;
    const inputClaim = makeClaim("in-1", "hello");
    const adapter = makeAdapter([inputClaim], 42);
    const cand = deriveClaimFrom(
      adapter,
      mutableCatalog,
      resolve("resolveDeprecateOlder", leaf("test-corpus")),
      { subject: "t", key: "t.k", scope: {}, evaluationClock: 1000 },
    );
    const originalThreshold = JSON.parse(cand.provenance!.derivedFrom!.queryExpression).threshold;
    // mutate corpus default AFTER derive
    corpusObj.defaults.confidenceThreshold = 0.99;
    // stored value must not change
    const storedExpr = JSON.parse(cand.provenance!.derivedFrom!.queryExpression);
    expect(storedExpr.threshold).toBe(originalThreshold);
    expect(storedExpr.threshold).toBe(0.5);

    // AC5 end-to-end replay fidelity: re-running the stored expression with the
    // recorded evaluationClock reproduces the original result claims, even though
    // the corpus default has since been mutated to 0.99.
    const storedClock = cand.provenance!.derivedFrom!.evaluationClock!;
    const replayCtx = { adapter, catalog: mutableCatalog, evaluationClock: storedClock };
    const replayResult = evaluate<Corpus>(
      compile(parseExpr(cand.provenance!.derivedFrom!.queryExpression)),
      replayCtx,
    );
    const replayRep = replayResult.claims[replayResult.claims.length - 1];
    expect(replayRep.value).toEqual(cand.value);
    expect(replayRep.confidence.raw).toBe(cand.confidence.raw);
  });

  it("old-format expression (threshold present, no keyCardinality) evaluates identically", () => {
    // Pre-stamped expr — no change in behavior expected
    const oldStyleExpr = resolve("resolveDeprecateOlder", leaf("test-corpus"), undefined, 0.75);
    const richCatalog = makeRichCatalog({ confidenceThreshold: 0.5 });
    const inputClaim = makeClaim("in-1", "hello");
    const adapter = makeAdapter([inputClaim], 42);
    const cand = deriveClaimFrom(
      adapter,
      richCatalog,
      oldStyleExpr,
      { subject: "t", key: "t.k", scope: {}, evaluationClock: 1000 },
    );
    // threshold is explicit 0.75, corpus default 0.5 NOT applied
    const expr = JSON.parse(cand.provenance!.derivedFrom!.queryExpression);
    expect(expr.threshold).toBe(0.75);
    expect("keyCardinality" in expr).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task: task-derive-snapshot
// New tests for keyAliases carry-through in stampResolveDefaults and
// alias-map snapshotting in deriveClaimFrom.
// ─────────────────────────────────────────────────────────────────────────────

describe("stampResolveDefaults — keyAliases carry-through", () => {
  it("carries explicit keyAliases through the rebuild (does NOT drop the field)", () => {
    const richCatalog = makeRichCatalog({ confidenceThreshold: 0.5 });
    const aliases = { preferred_editor: "editor" };
    // Pass aliases as 6th param of resolve() builder
    const expr = resolve("resolveDeprecateOlder", leaf("test-corpus"), undefined, undefined, undefined, aliases);
    const stamped = stampResolveDefaults(expr, richCatalog);
    expect((stamped as any).keyAliases).toEqual(aliases);
  });

  it("carries an explicit empty keyAliases ({}) through the rebuild unchanged", () => {
    const richCatalog = makeRichCatalog({ confidenceThreshold: 0.5 });
    const expr = resolve("resolveDeprecateOlder", leaf("test-corpus"), undefined, undefined, undefined, {});
    const stamped = stampResolveDefaults(expr, richCatalog);
    // must be present AND equal to {}
    expect("keyAliases" in stamped).toBe(true);
    expect((stamped as any).keyAliases).toEqual({});
  });

  it("does NOT set keyAliases when the node has none (field absent, not {})", () => {
    const richCatalog = makeRichCatalog({ confidenceThreshold: 0.5 });
    const expr = resolve("resolveDeprecateOlder", leaf("test-corpus"));
    const stamped = stampResolveDefaults(expr, richCatalog);
    expect("keyAliases" in stamped).toBe(false);
  });
});

describe("deriveClaimFrom — alias-map snapshot", () => {
  it("snapshots the active alias map into the resolve node's keyAliases when aliases exist", () => {
    const richCatalog = makeRichCatalog({ confidenceThreshold: 0.5 });
    const inputClaim = makeClaim("in-1", "hello");
    const aliasClaim = makeAliasClaim("alias-1", "preferred_editor", "editor");
    const adapter = makeAdapter([inputClaim, aliasClaim], 42);
    const cand = deriveClaimFrom(
      adapter,
      richCatalog,
      resolve("resolveDeprecateOlder", leaf("test-corpus")),
      { subject: "t", key: "t.k", scope: {}, evaluationClock: 1000 },
    );
    const expr = JSON.parse(cand.provenance!.derivedFrom!.queryExpression);
    expect(expr.keyAliases).toEqual({ preferred_editor: "editor" });
  });

  it("does NOT add keyAliases field when the alias map is empty (serialized expression unchanged)", () => {
    const richCatalog = makeRichCatalog({ confidenceThreshold: 0.5 });
    const inputClaim = makeClaim("in-1", "hello");
    // No alias claims in adapter
    const adapter = makeAdapter([inputClaim], 42);
    const exprNode = resolve("resolveDeprecateOlder", leaf("test-corpus"));
    const cand = deriveClaimFrom(
      adapter,
      richCatalog,
      exprNode,
      { subject: "t", key: "t.k", scope: {}, evaluationClock: 1000 },
    );
    const storedExpr = JSON.parse(cand.provenance!.derivedFrom!.queryExpression);
    expect("keyAliases" in storedExpr).toBe(false);
  });

  it("does NOT overwrite an explicit keyAliases already on the resolve node", () => {
    const richCatalog = makeRichCatalog({ confidenceThreshold: 0.5 });
    const inputClaim = makeClaim("in-1", "hello");
    const aliasClaim = makeAliasClaim("alias-1", "preferred_editor", "editor");
    const adapter = makeAdapter([inputClaim, aliasClaim], 42);
    const explicitAliases = { my_key: "canonical_key" };
    const exprNode = resolve(
      "resolveDeprecateOlder",
      leaf("test-corpus"),
      undefined,
      undefined,
      undefined,
      explicitAliases,
    );
    const cand = deriveClaimFrom(
      adapter,
      richCatalog,
      exprNode,
      { subject: "t", key: "t.k", scope: {}, evaluationClock: 1000 },
    );
    const storedExpr = JSON.parse(cand.provenance!.derivedFrom!.queryExpression);
    // explicit wins; corpus alias (preferred_editor→editor) must NOT appear
    expect(storedExpr.keyAliases).toEqual(explicitAliases);
    expect(storedExpr.keyAliases).not.toHaveProperty("preferred_editor");
  });

  it("does NOT overwrite an explicit empty keyAliases ({}) on the resolve node", () => {
    const richCatalog = makeRichCatalog({ confidenceThreshold: 0.5 });
    const inputClaim = makeClaim("in-1", "hello");
    const aliasClaim = makeAliasClaim("alias-1", "preferred_editor", "editor");
    const adapter = makeAdapter([inputClaim, aliasClaim], 42);
    const exprNode = resolve(
      "resolveDeprecateOlder",
      leaf("test-corpus"),
      undefined,
      undefined,
      undefined,
      {},
    );
    const cand = deriveClaimFrom(
      adapter,
      richCatalog,
      exprNode,
      { subject: "t", key: "t.k", scope: {}, evaluationClock: 1000 },
    );
    const storedExpr = JSON.parse(cand.provenance!.derivedFrom!.queryExpression);
    expect("keyAliases" in storedExpr).toBe(true);
    expect(storedExpr.keyAliases).toEqual({});
  });
});
