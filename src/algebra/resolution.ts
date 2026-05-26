import type { Corpus } from "./types.js";
import { mapCorpus, corpusOf } from "./types.js";
import type { Claim } from "../core/claim.js";
import { pointEstimate } from "../core/confidence.js";
import { newClaimId } from "../core/ids.js";
import type { ContradictionPair, ContradictionCluster } from "./contradiction.js";

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
 * resolveDeprecateLower — pairwise resolution.
 *
 * For each pair, the claim with the lower pointEstimate becomes "deprecated".
 * Ties are broken by deprecating the lexicographically-higher claim id.
 */
export const resolveDeprecateLower =
  (pairs: ContradictionPair[]) =>
  (corpus: Corpus): Corpus => {
    const losers = new Set<string>();
    for (const p of pairs) {
      const leftEff = pointEstimate(p.left.confidence);
      const rightEff = pointEstimate(p.right.confidence);
      if (leftEff < rightEff) {
        losers.add(p.left.id);
      } else if (rightEff < leftEff) {
        losers.add(p.right.id);
      } else {
        // Tie: deprecate the lexicographically-higher id
        if (p.left.id > p.right.id) {
          losers.add(p.left.id);
        } else {
          losers.add(p.right.id);
        }
      }
    }
    return deprecate(corpus, losers);
  };

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
  (corpus: Corpus): Corpus => {
    const artifacts: Claim[] = pairs.map((p) => ({
      id: newClaimId(),
      profile: "" as any,
      workspace: "" as any,
      subject: "contradiction" as any,
      key: "contradiction.flag" as any,
      scope: {} as any,
      scopeHash: "",
      value: { leftId: p.left.id, rightId: p.right.id } as any,
      valueHash: "",
      confidence: {
        distribution: "scalar",
        parameters: { p: 1 },
        raw: 1,
      },
      valid: { start: null, end: null } as any,
      recorded: Date.now() as any,
      recordedSeq: 0,
      status: "candidate" as const,
      source: "heuristic" as const,
      provenance: {} as any,
      evidence: [],
      tags: [],
      schema: "contradiction-flag-v1",
    }));
    return corpusOf([...corpus.claims, ...artifacts]);
  };

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
