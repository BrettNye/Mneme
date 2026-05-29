import { deriveClaimFrom } from "./derive.js";
import { leaf, sigma } from "../algebra/ast.js";
import { serializeExpr } from "../algebra/serialize.js";
import type { ExprNode } from "../algebra/ast.js";
import type { Claim } from "../core/claim.js";

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
    corpusId: "test-corpus",
    recorded: 1000,
    recordedSeq: 1,
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
