import { commitDerived } from "./derived-write.js";

it("rejects when the query uses similarity but similarityVersions is empty", () => {
  const promoter = { commit: () => ({ id: "x", status: "committed" }) } as any;
  const candNoVer = { provenance: { derivedFrom: { similarityVersions: {}, embeddingModelVersions: {}, inputClaims: [] } } } as any;
  expect(() => commitDerived(promoter, candNoVer, { queryExpression: "leaf(c) | rho.jaccard(q)", corpusState: 1, writer: "w" })).toThrow(/mandatory version/);
  const candVer = { provenance: { derivedFrom: { similarityVersions: { jaccard: "jaccard@1" }, embeddingModelVersions: {}, inputClaims: [] } } } as any;
  expect(commitDerived(promoter, candVer, { queryExpression: "leaf(c) | rho.jaccard(q)", corpusState: 1, writer: "w" }).status).toBe("committed");
});

it("rejects a candidate with no derivedFrom provenance", () => {
  const promoter = { commit: () => ({ id: "x", status: "committed" }) } as any;
  const candNoDerived = { provenance: {} } as any;
  expect(() => commitDerived(promoter, candNoDerived, { queryExpression: "leaf(c)", corpusState: 1, writer: "w" })).toThrow(/no derivedFrom provenance/);
});

it("commits fine when query has no similarity markers and similarityVersions is empty", () => {
  const promoter = { commit: () => ({ id: "y", status: "committed" }) } as any;
  const candNoSim = { provenance: { derivedFrom: { similarityVersions: {}, embeddingModelVersions: {}, inputClaims: [] } } } as any;
  expect(commitDerived(promoter, candNoSim, { queryExpression: "leaf(c)", corpusState: 5, writer: "w" }).status).toBe("committed");
});

it("sets queryExpression and corpusState on derivedFrom before calling promoter.commit", () => {
  let capturedCandidate: any;
  const promoter = {
    commit: (candidate: any, _opts: any) => {
      capturedCandidate = candidate;
      return { id: "z", status: "committed" };
    },
  } as any;
  const derivedFrom = { similarityVersions: {}, embeddingModelVersions: {}, inputClaims: ["id1"], combinationRule: "max", evaluationClock: 100 };
  const cand = { provenance: { derivedFrom } } as any;
  commitDerived(promoter, cand, { queryExpression: "leaf(c)", corpusState: 42, writer: "alice" });
  expect(capturedCandidate.provenance.derivedFrom.queryExpression).toBe("leaf(c)");
  expect(capturedCandidate.provenance.derivedFrom.corpusState).toBe(42);
  // Full provenance retained
  expect(capturedCandidate.provenance.derivedFrom.inputClaims).toEqual(["id1"]);
  expect(capturedCandidate.provenance.derivedFrom.combinationRule).toBe("max");
  expect(capturedCandidate.provenance.derivedFrom.evaluationClock).toBe(100);
});

it("passes policy and idempotencyKey to promoter.commit", () => {
  let capturedOpts: any;
  const promoter = {
    commit: (_candidate: any, opts: any) => {
      capturedOpts = opts;
      return { id: "q", status: "committed" };
    },
  } as any;
  const cand = { provenance: { derivedFrom: { similarityVersions: {}, embeddingModelVersions: {}, inputClaims: [] } } } as any;
  commitDerived(promoter, cand, {
    queryExpression: "leaf(c)",
    corpusState: 1,
    writer: "bob",
    policy: { kind: "reject_on_contradiction" },
    idempotencyKey: "key-abc",
  });
  expect(capturedOpts.policy).toEqual({ kind: "reject_on_contradiction" });
  expect(capturedOpts.writer).toBe("bob");
  expect(capturedOpts.idempotencyKey).toBe("key-abc");
});

it("defaults policy to always_accept when not provided", () => {
  let capturedOpts: any;
  const promoter = {
    commit: (_candidate: any, opts: any) => {
      capturedOpts = opts;
      return { id: "r", status: "committed" };
    },
  } as any;
  const cand = { provenance: { derivedFrom: { similarityVersions: {}, embeddingModelVersions: {}, inputClaims: [] } } } as any;
  commitDerived(promoter, cand, { queryExpression: "leaf(c)", corpusState: 1, writer: "carol" });
  expect(capturedOpts.policy).toEqual({ kind: "always_accept" });
});
