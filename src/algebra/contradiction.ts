import type { Corpus } from "./types.js";
import type { Claim } from "../core/claim.js";
import { pointEstimate, type Confidence } from "../core/confidence.js";
import { bindingFor } from "../distribution/registry.js";
import { RULE } from "../distribution/rules.js";

export type ConflictReason = "value-difference"; // §4.8 binary criterion; only reason this detector emits
export interface Resolution { kind: string; resultClaimIds: string[] }
export interface ContradictionPair { left: Claim; right: Claim; conflictReason: ConflictReason; resolution?: Resolution }
export interface ContradictionCluster {
  triple: { subject: string; key: string; scopeHash: string };
  valueGroups: Map<string, Claim[]>;           // keyed by valueHash
  totalClaims: number;
  distinctValues: number;
  agreementRatio: number;                        // largestGroup / total (1.0 = consensus, 1/k = k-way split)
  highestConfidenceGroup?: string;               // valueHash with highest pooled point estimate
  combinedConfidences: Map<string, Confidence>;  // per-value pooled confidence (⊕ evidence_pooled)
}

const eff = (c: Claim) => c.confidence.effective ?? pointEstimate(c.confidence);

export function clustersOf(corpus: Corpus, threshold: number): ContradictionCluster[] {
  // 1. keep claims with eff(claim) > threshold
  const aboveThreshold = corpus.claims.filter(claim => eff(claim) > threshold);

  // 2. group by `${subject} ${key} ${scopeHash}` => within each triple sub-group by valueHash
  const tripleMap = new Map<string, Map<string, Claim[]>>();
  for (const claim of aboveThreshold) {
    const tripleKey = `${claim.subject}\x00${claim.key}\x00${claim.scopeHash}`;
    if (!tripleMap.has(tripleKey)) {
      tripleMap.set(tripleKey, new Map());
    }
    const valueGroups = tripleMap.get(tripleKey)!;
    if (!valueGroups.has(claim.valueHash)) {
      valueGroups.set(claim.valueHash, []);
    }
    valueGroups.get(claim.valueHash)!.push(claim);
  }

  // 3. a triple with >= 2 distinct valueHash groups is a cluster
  const clusters: ContradictionCluster[] = [];

  for (const [tripleKey, valueGroups] of tripleMap) {
    if (valueGroups.size < 2) continue;

    const [subject, key, scopeHash] = tripleKey.split("\x00");

    // Calculate totalClaims and agreementRatio
    let totalClaims = 0;
    let largestGroupSize = 0;
    for (const claims of valueGroups.values()) {
      totalClaims += claims.length;
      if (claims.length > largestGroupSize) {
        largestGroupSize = claims.length;
      }
    }
    const agreementRatio = largestGroupSize / totalClaims;
    const distinctValues = valueGroups.size;

    // 4. per group: pool params left-to-right via bindingFor(dist).combine(RULE.EVIDENCE_POOLED, acc, next)
    const combinedConfidences = new Map<string, Confidence>();
    let highestConfidenceGroup: string | undefined;
    let highestMean = -Infinity;

    for (const [valueHash, claims] of valueGroups) {
      if (claims.length === 0) continue;

      // All claims in one value group must share the same distribution
      const distribution = claims[0].confidence.distribution;
      for (const claim of claims) {
        if (claim.confidence.distribution !== distribution) {
          throw new Error(
            `Mixed distribution types in contradiction cluster: ` +
            `expected "${distribution}" but found "${claim.confidence.distribution}" ` +
            `for subject="${subject}" key="${key}" scopeHash="${scopeHash}" valueHash="${valueHash}"`
          );
        }
      }

      const binding = bindingFor(distribution);

      // Fold left-to-right via EVIDENCE_POOLED
      let pooledParams = claims[0].confidence.parameters;
      for (let i = 1; i < claims.length; i++) {
        pooledParams = binding.combine(RULE.EVIDENCE_POOLED, pooledParams, claims[i].confidence.parameters);
      }

      const pooledMean = binding.mean(pooledParams);
      const combined: Confidence = {
        distribution: distribution as any,
        parameters: pooledParams as any,
        raw: pooledMean,
      };
      combinedConfidences.set(valueHash, combined);

      if (pooledMean > highestMean) {
        highestMean = pooledMean;
        highestConfidenceGroup = valueHash;
      }
    }

    clusters.push({
      triple: { subject, key, scopeHash },
      valueGroups,
      totalClaims,
      distinctValues,
      agreementRatio,
      highestConfidenceGroup,
      combinedConfidences,
    });
  }

  return clusters;
}

export function derivedPairs(clusters: ContradictionCluster[]): ContradictionPair[] {
  const pairs: ContradictionPair[] = [];

  for (const cluster of clusters) {
    // Get all groups as an array of [valueHash, claims[]] entries
    const groupEntries = Array.from(cluster.valueGroups.entries());

    // For each pair of distinct value groups, emit all cross-group claim pairs
    for (let i = 0; i < groupEntries.length; i++) {
      for (let j = i + 1; j < groupEntries.length; j++) {
        const [, claimsI] = groupEntries[i];
        const [, claimsJ] = groupEntries[j];

        for (const left of claimsI) {
          for (const right of claimsJ) {
            pairs.push({
              left,
              right,
              conflictReason: "value-difference",
            });
          }
        }
      }
    }
  }

  return pairs;
}

export const pairsOf = (corpus: Corpus, threshold: number): ContradictionPair[] =>
  derivedPairs(clustersOf(corpus, threshold));
