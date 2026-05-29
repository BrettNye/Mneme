import type { ClaimId } from "./ids.js";

export interface DerivationProvenance {
  queryExpression: string;
  corpusState: number;
  combinationRule?: string;
  inputClaims: ClaimId[];
  /**
   * Content hash of each input claim at derivation time, keyed by claim id.
   * Mandatory per Appendix H.3: recording it is irreversible at write time — a
   * derivation committed without it can never gain it — so it is banked now to
   * keep future integrity-verifiable replay / erasure auditing possible even
   * after an input is erased. Anchored to each input's canonical `valueHash`.
   */
  inputHashes: Record<string, string>;
  similarityVersions: Record<string, string>;
  embeddingModelVersions: Record<string, string>;
  evaluationClock: number;
}

/**
 * Build the inputHashes map from a set of input claims, anchoring each to its
 * canonical content hash (`valueHash`). Used by every derivation site so the
 * App H.3 banked prerequisite is recorded uniformly.
 */
export function inputHashesOf(
  claims: { id: ClaimId; valueHash: string }[]
): Record<string, string> {
  const m: Record<string, string> = {};
  for (const c of claims) m[String(c.id)] = c.valueHash;
  return m;
}

export interface Provenance {
  workflow?: string;
  runId?: string;
  nodeId?: string;
  persona?: string;
  artifactId?: string;
  derivedFrom?: DerivationProvenance;
}
