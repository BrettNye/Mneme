import type { Corpus } from "./types.js";
import { mapCorpus, corpusOf, unionEvidence } from "./types.js";
import type { Claim } from "../core/claim.js";
import { newClaimId } from "../core/ids.js";
import { bindingFor } from "../distribution/registry.js";
import { RULE } from "../distribution/rules.js";
import { SOURCE_WEIGHT } from "../core/source-trust.js";
import type { ContradictionCluster } from "./contradiction.js";
import { INFINITY } from "../core/time.js";
import { inputHashesOf } from "../core/provenance.js";

/**
 * resolveSynthesizeBelief (§4.8, core binary case):
 * For each binary cluster (exactly 2 value groups), fuse the two groups' pooled confidences
 * via the supplied rule (default RULE.WEIGHTED_AVG) into one new in-memory derived Claim.
 * Both conflicting groups' claims are marked "deprecated"; the synthesized claim is appended
 * with status "validated". Multi-way clusters (k > 2) are left untouched.
 */
export const resolveSynthesizeBelief =
  (clusters: ContradictionCluster[], rule: string = RULE.WEIGHTED_AVG) =>
  (corpus: Corpus): Corpus => {
    const binary = clusters.filter((cl) => cl.distinctValues === 2);
    const deprecateIds = new Set<string>();
    const synthesized: Claim[] = [];

    for (const cl of binary) {
      const { triple, valueGroups, combinedConfidences, highestConfidenceGroup } = cl;

      // Require exactly two groups (guaranteed by filter, but defensive)
      if (valueGroups.size !== 2 || !highestConfidenceGroup) continue;

      const groupEntries = Array.from(valueGroups.entries());
      const [[hashA, claimsA], [hashB, claimsB]] = groupEntries;

      // Compute group weights from SOURCE_WEIGHT of their constituent claims (sum)
      const weightOf = (claims: Claim[]): number =>
        claims.reduce((sum, claim) => sum + (SOURCE_WEIGHT[claim.source] ?? 1.0), 0);

      const wA = weightOf(claimsA);
      const wB = weightOf(claimsB);
      const wSum = wA + wB;
      // Normalize
      const wAN = wA / wSum;
      const wBN = wB / wSum;

      // Retrieve the pooled confidences for each group
      const confA = combinedConfidences.get(hashA);
      const confB = combinedConfidences.get(hashB);
      if (!confA || !confB) continue;

      // Use the same distribution (all claims in a cluster share one distribution)
      const distribution = confA.distribution;
      const binding = bindingFor(distribution);

      // Fuse the two groups' pooled parameters via the specified rule
      const fusedParams = binding.combine(rule, confA.parameters, confB.parameters, {
        weights: [wAN, wBN],
      });
      const fusedMean = binding.mean(fusedParams);

      // Pick value from the highest confidence group
      const favoredClaims = valueGroups.get(highestConfidenceGroup)!;
      const favoredValue = favoredClaims[0].value;

      // Collect evidence from both groups (union)
      const allEvidence = unionEvidence([
        ...claimsA.map((c) => c.evidence),
        ...claimsB.map((c) => c.evidence),
      ]);

      // Mark all claims in both groups as deprecated
      for (const c of [...claimsA, ...claimsB]) {
        deprecateIds.add(c.id);
      }

      // Build the synthesized in-memory Claim (unpersisted)
      const synth: Claim = {
        id: newClaimId(),
        subject: triple.subject,
        key: triple.key,
        scope: favoredClaims[0].scope,
        scopeHash: triple.scopeHash,
        value: favoredValue,
        valueHash: favoredClaims[0].valueHash,
        confidence: {
          distribution: distribution as any,
          parameters: fusedParams as any,
          raw: fusedMean,
        },
        status: "validated",
        source: "workflow",
        evidence: allEvidence,
        audience: {},
        tags: [],
        schema: favoredClaims[0].schema ?? "",
        profile: favoredClaims[0].profile,
        workspace: favoredClaims[0].workspace,
        valid: favoredClaims[0].valid ?? { from: Date.now(), to: INFINITY },
        recorded: 0,
        recordedSeq: 0,
        provenance: {
          derivedFrom: {
            queryExpression: `synthesize(binary-cluster:${triple.subject}:${triple.key}:${triple.scopeHash})`,
            corpusState: 0,
            combinationRule: rule,
            inputClaims: [...claimsA, ...claimsB].map((c) => c.id),
            inputHashes: inputHashesOf([...claimsA, ...claimsB]),
            similarityVersions: {},
            embeddingModelVersions: {},
            evaluationClock: Date.now(),
          },
        },
      };

      synthesized.push(synth);
    }

    // Deprecate the conflicting claims
    const next = mapCorpus(corpus, (c) =>
      deprecateIds.has(c.id) ? { ...c, status: "deprecated" as const } : c
    );

    return corpusOf([...next.claims, ...synthesized]);
  };
