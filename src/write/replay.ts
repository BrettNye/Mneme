import type { Claim } from "../core/claim.js";
import type { ClaimId } from "../core/ids.js";
import type { StorageAdapter } from "../adapters/adapter.js";
import { similarityFn } from "../algebra/similarity.js";

export interface MissingDependency {
  // "embedding_version" is intentionally absent: embedding-version checking is deferred until
  // embedding models and an embedding registry exist (arrives with the deferred `exact`
  // re-execution engine in a later slice). Only the variants this function actually produces
  // are declared here.
  kind: "input" | "similarity_version";
  id: string;
}

export type ReplayStatus =
  | "exact"
  | "unavailable_models"
  | "missing_inputs"
  | "integrity_unknown"
  | "failed";

export interface ReplayResult {
  status: ReplayStatus;
  result?: Claim;
  missingDependencies: MissingDependency[];
}

// NOTE: "exact" requires re-EXECUTING the serialized query — deferred (serializable query AST is a
// later slice). This function reports only the degraded statuses from recorded provenance metadata.
// A derived claim whose inputs and versions all resolve returns "failed" as a placeholder until the
// replay engine (serializable query AST) lands and can verify re-execution.
export function replayStatus(claim: Claim, adapter: StorageAdapter): ReplayResult {
  const d = claim.provenance?.derivedFrom;
  if (!d || d.evaluationClock === undefined) {
    return { status: "integrity_unknown", missingDependencies: [] };
  }

  const missing: MissingDependency[] = [];

  // Check all input claims are still present in the adapter
  for (const id of d.inputClaims) {
    if (!adapter.getClaim(id as ClaimId)) {
      missing.push({ kind: "input", id });
    }
  }
  if (missing.length) {
    return { status: "missing_inputs", missingDependencies: missing };
  }

  // Check similarity versions are available and match
  for (const [name, ver] of Object.entries(d.similarityVersions)) {
    let available = false;
    try {
      available = similarityFn(name).version === ver;
    } catch {
      available = false;
    }
    if (!available) {
      missing.push({ kind: "similarity_version", id: `${name}@${ver}` });
    }
  }
  if (missing.length) {
    return { status: "unavailable_models", missingDependencies: missing };
  }

  // Cannot verify exact without re-executing the serialized query (deferred slice)
  return { status: "failed", missingDependencies: [] };
}
