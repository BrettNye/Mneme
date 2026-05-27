import { RULE } from "../distribution/rules.js";

export interface BioPolicy {
  evidence?: { usageWeight?: number; outcomeWeight?: number; scalarPseudocount?: number };
  dreaming?: { prior?: { alpha?: number; beta?: number }; maxDepth?: number; maxInputClaims?: number };
  consolidation?: {
    promoteThresholds?: { provisional?: number; validated?: number };
    lowerBoundK?: number;
    foldRule?: string;
    foldThreshold?: number;
  };
}

export const DEFAULT_BIO_POLICY = {
  evidence: { usageWeight: 0.5, outcomeWeight: 2.0, scalarPseudocount: 2 },
  dreaming: { prior: { alpha: 1, beta: 3 }, maxDepth: 3, maxInputClaims: 200 },
  consolidation: {
    promoteThresholds: { provisional: 0.5, validated: 0.65 },
    lowerBoundK: 1.645,
    foldRule: RULE.WEIGHTED_AVG,
    foldThreshold: 3,
  },
} as const;

// Deep-merge each sub-policy so a partial override never drops sibling defaults.
export function resolvePolicy(p?: BioPolicy): {
  evidence: { usageWeight: number; outcomeWeight: number; scalarPseudocount: number };
  dreaming: { prior: { alpha: number; beta: number }; maxDepth: number; maxInputClaims: number };
  consolidation: {
    promoteThresholds: { provisional: number; validated: number };
    lowerBoundK: number;
    foldRule: string;
    foldThreshold: number;
  };
} {
  return {
    evidence: { ...DEFAULT_BIO_POLICY.evidence, ...p?.evidence },
    dreaming: {
      ...DEFAULT_BIO_POLICY.dreaming,
      ...p?.dreaming,
      prior: { ...DEFAULT_BIO_POLICY.dreaming.prior, ...p?.dreaming?.prior },
    },
    consolidation: {
      ...DEFAULT_BIO_POLICY.consolidation,
      ...p?.consolidation,
      promoteThresholds: {
        ...DEFAULT_BIO_POLICY.consolidation.promoteThresholds,
        ...p?.consolidation?.promoteThresholds,
      },
    },
  };
}
