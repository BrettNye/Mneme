import { deriveClaimFrom } from "./derive.js";

describe("deriveClaimFrom", () => {
  it("captures inputClaims, evaluationClock, and similarity versions into derivedFrom", () => {
    const inputClaim = { id: "in-1", subject: "s", key: "s.k", value: "v", confidence: { distribution: "beta", parameters: { alpha: 9, beta: 1 }, raw: 0.9 }, evidence: [] } as any;
    const derivedClaim = { id: "derived-1", subject: "t", key: "t.k", value: "v-derived", confidence: { distribution: "beta", parameters: { alpha: 9, beta: 1 }, raw: 0.9 }, evidence: [] } as any;
    const adapter = { query: () => [inputClaim] } as any;
    const catalog = { getCorpus: () => ({}) } as any;
    // leafStage returns the input claim; synthesizeStage appends the derived claim last (as a synthesize pipeline would)
    const leafStage: any = (_: any, _ctx: any) => ({ claims: [inputClaim] });
    const synthesizeStage: any = (corp: any, ctx: any) => {
      ctx.usedSimilarityVersions["jaccard"] = "jaccard@1";
      return { claims: [...corp.claims, derivedClaim] };
    };
    const cand = deriveClaimFrom(adapter, catalog, [leafStage, synthesizeStage], { subject: "t", key: "t.k", scope: {}, combination: "rule_weighted_avg", evaluationClock: 1234 });
    // inputClaims are the contributing claims excluding the derived representative (last claim)
    expect(cand.provenance.derivedFrom?.inputClaims).toEqual(["in-1"]);
    expect(cand.provenance.derivedFrom?.evaluationClock).toBe(1234);
    expect(cand.provenance.derivedFrom?.similarityVersions).toEqual({ jaccard: "jaccard@1" });
  });

  it("throws when the pipeline produces an empty corpus", () => {
    const adapter = {} as any;
    const catalog = {} as any;
    const emptyStage: any = (_: any, _ctx: any) => ({ claims: [] });
    expect(() =>
      deriveClaimFrom(adapter, catalog, [emptyStage], { subject: "t", key: "t.k", scope: {}, evaluationClock: 1 })
    ).toThrow("deriveClaimFrom: pipeline produced no claims; cannot derive a representative");
  });

  it("uses the LAST claim as representative and excludes it from inputClaims", () => {
    const claimA = { id: "id-a", subject: "s", key: "k", value: "alpha", confidence: { distribution: "beta", parameters: { alpha: 8, beta: 2 }, raw: 0.8 }, evidence: [] } as any;
    const claimB = { id: "id-b", subject: "s", key: "k", value: "beta", confidence: { distribution: "beta", parameters: { alpha: 9, beta: 1 }, raw: 0.9 }, evidence: [] } as any;
    const adapter = {} as any;
    const catalog = {} as any;
    const twoClaimStage: any = (_: any, _ctx: any) => ({ claims: [claimA, claimB] });
    const cand = deriveClaimFrom(adapter, catalog, [twoClaimStage], { subject: "t", key: "t.k", scope: {}, evaluationClock: 42 });
    // representative is the last claim (claimB)
    expect(cand.value).toBe("beta");
    expect(cand.confidence).toEqual(claimB.confidence);
    // inputClaims contains the contributing claim (claimA) but NOT the representative (claimB)
    expect(cand.provenance.derivedFrom?.inputClaims).toEqual(["id-a"]);
    expect(cand.provenance.derivedFrom?.inputClaims).not.toContain("id-b");
  });
});
