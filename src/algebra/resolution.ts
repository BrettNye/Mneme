import type { Corpus } from "./types.js";
import { mapCorpus, corpusOf } from "./types.js";
import type { Claim } from "../core/claim.js";
import { pointEstimate } from "../core/confidence.js";
import { newClaimId } from "../core/ids.js";
import type { ContradictionPair, ContradictionCluster } from "./contradiction.js";

export const CONTRADICTION_FLAG_KEY = "contradiction.flag";

/**
 * Internal helper: returns a new Corpus where all claims with ids in `ids`
 * have status set to "deprecated". Does not mutate any claim or its confidence.
 */
const deprecate = (corpus: Corpus, ids: Set<string>): Corpus =>
  mapCorpus(corpus, (cl) =>
    ids.has(cl.id) ? { ...cl, status: "deprecated" } : cl
  );

/**
 * Internal helper: returns a new Corpus where all claims with ids in `ids`
 * have status set to "validated". Does not mutate any claim or its confidence.
 */
const promote = (corpus: Corpus, ids: Set<string>): Corpus =>
  mapCorpus(corpus, (cl) =>
    ids.has(cl.id) ? { ...cl, status: "validated" } : cl
  );

/**
 * Extracted from resolveFlagForReview; one artifact per pair, status "candidate".
 * Carry over the existing `as any` casts on branded Claim fields.
 */
const flagArtifactFor = (p: ContradictionPair): Claim => ({
  id: newClaimId(),
  profile: "" as any,
  workspace: "" as any,
  subject: "contradiction" as any,
  key: CONTRADICTION_FLAG_KEY as any,
  scope: {} as any,
  scopeHash: "",
  value: { leftId: p.left.id, rightId: p.right.id } as any,
  valueHash: "",
  confidence: {
    distribution: "scalar",
    parameters: { p: 1 },
    raw: 1,
  },
  valid: { from: 0, to: Infinity } as any,
  recorded: Date.now() as any,
  recordedSeq: 0,
  status: "candidate" as const,
  source: "heuristic" as const,
  provenance: {} as any,
  evidence: [],
  audience: {},
  tags: [],
  schema: "contradiction-flag-v1",
});

/**
 * Engine: partition pairs by loserOf; deprecate losers; for tied pairs whose members
 * BOTH survive this pass, append one flag artifact each. Tied pairs with a member
 * deprecated by a decided pair emit nothing (conflict already resolved).
 *
 * loserOf returns the id of the losing claim, or null when the pair is a tie.
 * Using null (not a string sentinel like "tie") prevents collision with a real
 * claim whose id happens to be "tie".
 */
const deprecatePairwise =
  (pairs: ContradictionPair[], loserOf: (p: ContradictionPair) => string | null) =>
  (corpus: Corpus): Corpus => {
    const losers = new Set<string>();
    const tied: ContradictionPair[] = [];
    for (const p of pairs) {
      const l = loserOf(p);
      if (l === null) tied.push(p);
      else losers.add(l);
    }
    const artifacts = tied
      .filter((p) => !losers.has(p.left.id) && !losers.has(p.right.id))
      .map(flagArtifactFor);
    const next = deprecate(corpus, losers);
    return artifacts.length ? corpusOf([...next.claims, ...artifacts]) : next;
  };

/**
 * resolveDeprecateLower — pairwise resolution.
 *
 * For each pair, the claim with the lower pointEstimate becomes "deprecated".
 * Ties: both claims keep their status and exactly one flag artifact is appended
 * per tied-surviving pair.
 */
export const resolveDeprecateLower = (pairs: ContradictionPair[]) =>
  deprecatePairwise(pairs, (p) => {
    const l = pointEstimate(p.left.confidence);
    const r = pointEstimate(p.right.confidence);
    return l < r ? p.left.id : r < l ? p.right.id : null;
  });

/**
 * resolveDeprecateOlder — pairwise resolution.
 *
 * For each pair, the claim with the earlier valid.from becomes "deprecated".
 * Ties: both claims keep their status and exactly one flag artifact is appended
 * per tied-surviving pair.
 */
export const resolveDeprecateOlder = (pairs: ContradictionPair[]) =>
  deprecatePairwise(pairs, (p) => {
    const l = p.left.valid.from;
    const r = p.right.valid.from;
    return l < r ? p.left.id : r < l ? p.right.id : null;
  });

/**
 * resolveKeepBoth — pairwise resolution (identity).
 *
 * Returns the corpus unchanged; both claims are kept live.
 */
export const resolveKeepBoth =
  (_pairs: ContradictionPair[]) =>
  (corpus: Corpus): Corpus =>
    corpus;

/**
 * resolveFlagForReview — pairwise resolution.
 *
 * Appends one artifact Claim per pair recording the conflicting ids.
 * Original claims are unchanged.
 */
export const resolveFlagForReview =
  (pairs: ContradictionPair[]) =>
  (corpus: Corpus): Corpus =>
    corpusOf([...corpus.claims, ...pairs.map(flagArtifactFor)]);

/**
 * resolveDeprecateMinority — cluster-aware resolution.
 *
 * For each cluster, finds the largest value group (ties broken by
 * lexicographically-lower valueHash). Every claim NOT in the largest
 * group becomes "deprecated"; the largest group is left untouched.
 */
export const resolveDeprecateMinority =
  (clusters: ContradictionCluster[]) =>
  (corpus: Corpus): Corpus => {
    const losers = new Set<string>();
    for (const cluster of clusters) {
      const largestValueHash = findLargestGroup(cluster);
      for (const [valueHash, claims] of cluster.valueGroups) {
        if (valueHash !== largestValueHash) {
          for (const cl of claims) {
            losers.add(cl.id);
          }
        }
      }
    }
    return deprecate(corpus, losers);
  };

/**
 * resolvePromoteConsensus — cluster-aware resolution.
 *
 * Deprecates minority-group claims AND sets the largest group's claims
 * status to "validated".
 */
export const resolvePromoteConsensus =
  (clusters: ContradictionCluster[]) =>
  (corpus: Corpus): Corpus => {
    const losers = new Set<string>();
    const winners = new Set<string>();
    for (const cluster of clusters) {
      const largestValueHash = findLargestGroup(cluster);
      for (const [valueHash, claims] of cluster.valueGroups) {
        if (valueHash === largestValueHash) {
          for (const cl of claims) {
            winners.add(cl.id);
          }
        } else {
          for (const cl of claims) {
            losers.add(cl.id);
          }
        }
      }
    }
    // First deprecate losers, then promote winners
    return promote(deprecate(corpus, losers), winners);
  };

/**
 * Internal: finds the valueHash of the largest value group in a cluster.
 * Ties broken by lexicographically-lower valueHash (deterministic).
 */
function findLargestGroup(cluster: ContradictionCluster): string {
  let largestValueHash = "";
  let largestSize = -1;
  for (const [valueHash, claims] of cluster.valueGroups) {
    const size = claims.length;
    if (
      size > largestSize ||
      (size === largestSize && valueHash < largestValueHash)
    ) {
      largestSize = size;
      largestValueHash = valueHash;
    }
  }
  return largestValueHash;
}
