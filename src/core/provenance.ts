import type { ClaimId } from "./ids.js";

export interface DerivationProvenance {
  queryExpression: string;
  corpusState: number;
  combinationRule?: string;
  inputClaims: ClaimId[];
  similarityVersions: Record<string, string>;
  embeddingModelVersions: Record<string, string>;
  evaluationClock: number;
}

export interface Provenance {
  workflow?: string;
  runId?: string;
  nodeId?: string;
  persona?: string;
  artifactId?: string;
  derivedFrom?: DerivationProvenance;
}
