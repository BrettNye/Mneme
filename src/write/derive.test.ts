import { deriveClaimFrom } from "./derive.js";

it("captures inputClaims, evaluationClock, and similarity versions into derivedFrom", () => {
  const claim = { id: "in-1", subject: "s", key: "s.k", value: "v", confidence: { distribution: "beta", parameters: { alpha: 9, beta: 1 }, raw: 0.9 }, evidence: [] } as any;
  const adapter = { query: () => [claim] } as any;
  const catalog = { getCorpus: () => ({}) } as any;
  // a leaf-like stage returning the claim, then a manual ctx-aware stage recording a similarity version (stands in for rho)
  const leafStage: any = (_: any, _ctx: any) => ({ claims: [claim] });
  const recordSim: any = (corp: any, ctx: any) => { ctx.usedSimilarityVersions["jaccard"] = "jaccard@1"; return corp; };
  const cand = deriveClaimFrom(adapter, catalog, [leafStage, recordSim], { subject: "t", key: "t.k", scope: {}, combination: "rule_weighted_avg", evaluationClock: 1234 });
  expect(cand.provenance.derivedFrom?.inputClaims).toEqual(["in-1"]);
  expect(cand.provenance.derivedFrom?.evaluationClock).toBe(1234);
  expect(cand.provenance.derivedFrom?.similarityVersions).toEqual({ jaccard: "jaccard@1" });
});
