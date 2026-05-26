import type { Corpus } from "./types.js";
import { corpusOf } from "./types.js";
import type { Claim } from "../core/claim.js";
import { bindingFor } from "../distribution/registry.js";
import { assertSupportsRule } from "../distribution/protocol.js";
import { assertNotDeprecatedRule, RULE } from "../distribution/rules.js";
import { SOURCE_WEIGHT } from "../write/source-weight.js";

/**
 * Fold a group's claims through the pairwise combine(). For weighted_avg, thread the accumulated
 * source-weight so the fold equals the full normalized weighted average; max rules pre-sort by
 * claim id so the first-arg-wins tie-break is lexicographic; evidence_pooled folds exactly.
 */
export const oplusDedupe =
  (ruleId: string, params?: unknown) =>
  (c: Corpus): Corpus => {
    assertNotDeprecatedRule(ruleId);

    // Group claims by (subject, key, scopeHash)
    const groups = new Map<string, Claim[]>();
    for (const cl of c.claims) {
      const key = JSON.stringify([cl.subject, cl.key, cl.scopeHash]);
      const group = groups.get(key);
      if (group) {
        group.push(cl as Claim);
      } else {
        groups.set(key, [cl as Claim]);
      }
    }

    const out: Claim[] = [];
    for (const group of groups.values()) {
      out.push(combineGroup(ruleId, group, params));
    }
    return corpusOf(out);
  };

/**
 * Returns an UNPERSISTED synthesized Claim: confidence from the rule, evidence = union of inputs',
 * scope = inputs' shared scope fields. Persisting it (id/recorded/provenance) is the derived-writes slice.
 */
export const oplusSynthesizeAs =
  (subject: string, key: string, ruleId: string, params?: unknown) =>
  (c: Corpus): Claim => {
    assertNotDeprecatedRule(ruleId);

    const claims = c.claims as Claim[];
    const folded = combineGroup(ruleId, [...claims], params);

    // Union of all input evidence
    const evidenceUnion = [
      ...new Map(
        claims.flatMap((cl) => cl.evidence.map((e) => [JSON.stringify(e), e]))
      ).values(),
    ];

    // Build an unpersisted Claim (no id, recorded, provenance)
    return {
      subject,
      key,
      confidence: folded.confidence,
      evidence: evidenceUnion,
      // Use shared scope fields from the first claim if available
      scope: claims[0]?.scope ?? {},
      scopeHash: folded.scopeHash,
      value: folded.value,
      valueHash: folded.valueHash,
      source: folded.source,
      tags: [],
      schema: folded.schema,
      status: "candidate",
      // Intentionally leave id, recorded, recordedSeq, profile, workspace, valid, provenance unset
    } as unknown as Claim;
  };

function combineGroup(ruleId: string, claims: Claim[], params?: unknown): Claim {
  if (claims.length === 0) {
    throw new Error("combineGroup called with empty group");
  }

  const binding = bindingFor(claims[0].confidence.distribution);
  assertSupportsRule(binding, ruleId);

  // For max rules, sort by claim id lexicographically so first-arg-wins tie-break is deterministic
  const needsSort = ruleId === RULE.MAX_MEAN || ruleId === RULE.MAX_CONCENTRATION;
  const sorted = needsSort
    ? [...claims].sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0))
    : claims;

  if (sorted.length === 1) {
    return sorted[0];
  }

  if (ruleId === RULE.WEIGHTED_AVG) {
    // For weighted_avg, fold through with accumulated weights for a normalized weighted average
    let accParams = sorted[0].confidence.parameters;
    let accWeight = SOURCE_WEIGHT[sorted[0].source] ?? 1.0;

    for (let i = 1; i < sorted.length; i++) {
      const nextWeight = SOURCE_WEIGHT[sorted[i].source] ?? 1.0;
      const nextParams = sorted[i].confidence.parameters;
      accParams = binding.combine(ruleId, accParams, nextParams, {
        weights: [accWeight, nextWeight] as [number, number],
      });
      accWeight = accWeight + nextWeight;
    }

    const foldedConfidence = {
      ...sorted[0].confidence,
      parameters: accParams,
      raw: binding.mean(accParams),
    } as Claim["confidence"];

    return {
      ...sorted[0],
      confidence: foldedConfidence,
    };
  }

  // For max rules: fold over whole Claim objects, return the actual winner claim
  // betaBinding.combine returns one of its two param arguments BY REFERENCE for max rules,
  // so reference-equality tells us which claim won.
  if (ruleId === RULE.MAX_MEAN || ruleId === RULE.MAX_CONCENTRATION) {
    let winner = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      const kept = binding.combine(ruleId, winner.confidence.parameters, sorted[i].confidence.parameters, params);
      if (kept !== winner.confidence.parameters) winner = sorted[i];
    }
    return winner; // the winning claim, whole — no spread, no chimera
  }

  // For all other rules (evidence_pooled, dempster):
  // simple left-fold through pairwise combine
  let accParams = sorted[0].confidence.parameters;
  for (let i = 1; i < sorted.length; i++) {
    accParams = binding.combine(ruleId, accParams, sorted[i].confidence.parameters, params);
  }

  const foldedConfidence = {
    ...sorted[0].confidence,
    parameters: accParams,
    raw: binding.mean(accParams),
  } as Claim["confidence"];

  return {
    ...sorted[0],
    confidence: foldedConfidence,
  };
}
