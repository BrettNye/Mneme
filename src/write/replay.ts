import type { Claim } from "../core/claim.js";
import type { ClaimId } from "../core/ids.js";
import type { StorageAdapter } from "../adapters/adapter.js";
import type { Catalog } from "../catalog/catalog.js";
import { similarityFn } from "../algebra/similarity.js";
import { embeddingAdapter } from "../algebra/embedding.js";
import { compile, UnsupportedExprOp } from "../algebra/compile.js";
import { parseExpr } from "../algebra/serialize.js";
import { MissingRule } from "../algebra/registries.js";
import * as expression from "../algebra/expression.js";
import type { Corpus } from "../algebra/types.js";
import type { Value } from "../core/value.js";

export interface MissingDependency {
  kind: "input" | "similarity_version" | "embedding_version" | "rule";
  id: string;
}

export type ReplayStatus =
  | "exact"
  | "mismatch"
  | "unavailable_models"
  | "missing_inputs"
  | "integrity_unknown"
  | "failed";

export interface ReplayResult {
  status: ReplayStatus;
  result?: Claim;
  missingDependencies: MissingDependency[];
}

/**
 * Compare two Values deeply, treating numeric leaves as equal within epsilon.
 */
function valuesEquivalent(a: Value, b: Value, eps: number): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= eps;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a === "object" && typeof b === "object") {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      return a.every((v, i) => valuesEquivalent(v, (b as Value[])[i], eps));
    }
    // Both plain objects
    const aObj = a as Record<string, Value>;
    const bObj = b as Record<string, Value>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => k in bObj && valuesEquivalent(aObj[k], bObj[k], eps));
  }
  return false;
}

/**
 * Compare two claims for semantic equivalence (value + confidence parameters) within eps.
 * Ignores id, recorded, valid, provenance, tags.
 */
function claimsEquivalent(a: Claim, b: Claim, eps = 1e-9): boolean {
  if (!valuesEquivalent(a.value, b.value, eps)) return false;
  const ca = a.confidence;
  const cb = b.confidence;
  if (ca.distribution !== cb.distribution) return false;
  if (ca.distribution === "beta" && cb.distribution === "beta") {
    return (
      Math.abs(ca.parameters.alpha - cb.parameters.alpha) <= eps &&
      Math.abs(ca.parameters.beta - cb.parameters.beta) <= eps
    );
  }
  if (ca.distribution === "scalar" && cb.distribution === "scalar") {
    return Math.abs(ca.parameters.p - cb.parameters.p) <= eps;
  }
  throw new Error(`claimsEquivalent: unhandled confidence distribution "${ca.distribution}"`);
}

/**
 * Evaluate the serialized query expression under a pinned evaluationClock, compare the
 * last claim of the recomputed corpus against the recorded claim, and return the replay status.
 *
 * Degraded-path order (unchanged):
 *   1. No derivedFrom or no evaluationClock → integrity_unknown
 *   2. queryExpression === "" (v0.1-era, no AST recorded) → integrity_unknown
 *   3. Missing input claims → missing_inputs
 *   4. Unavailable similarity versions → unavailable_models
 *   5. Re-execute → exact | mismatch | unavailable_models (MissingRule) | failed
 */
export function replayStatus(
  claim: Claim,
  adapter: StorageAdapter,
  /**
   * Optional catalog for corpus resolution during re-execution.
   * Re-execution requires a catalog; omitting it will cause the leaf stage to throw,
   * which surfaces as status "failed" via the catch block.
   */
  catalog?: Catalog,
): ReplayResult {
  const d = claim.provenance?.derivedFrom;
  if (!d || d.evaluationClock === undefined) {
    return { status: "integrity_unknown", missingDependencies: [] };
  }

  // v0.1-era claims: no query AST recorded — cannot re-execute
  if (d.queryExpression === "") {
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

  // Check embedding model versions are available and match.
  // NOTE: the `?? {}` is deliberate defense for stored claims written before the field existed,
  // even though the current DerivationProvenance type requires it — keep it with this comment.
  for (const [id, ver] of Object.entries(d.embeddingModelVersions ?? {})) {
    let available = false;
    try {
      available = embeddingAdapter(id).version === ver;
    } catch {
      available = false;
    }
    if (!available) missing.push({ kind: "embedding_version", id: `${id}@${ver}` });
  }
  if (missing.length) {
    return { status: "unavailable_models", missingDependencies: missing };
  }

  // Re-execute the serialized query under the pinned evaluationClock
  const effectiveCatalog: Catalog = catalog ?? ({
    getCorpus: (id: string) => { throw new Error(`unknown corpus "${id}"`); },
  } as unknown as Catalog);

  try {
    const stages = compile(parseExpr(d.queryExpression));
    const recomputed = expression.evaluate<Corpus>(stages, {
      adapter,
      catalog: effectiveCatalog,
      evaluationClock: d.evaluationClock,
    });
    const rep = recomputed.claims[recomputed.claims.length - 1];
    // Empty corpus: the derivation no longer reproduces any claim → definite mismatch
    if (rep === undefined) {
      return { status: "mismatch", result: undefined, missingDependencies: [] };
    }
    return claimsEquivalent(rep, claim)
      ? { status: "exact", result: rep, missingDependencies: [] }
      : { status: "mismatch", result: rep, missingDependencies: [] };
  } catch (e) {
    if (e instanceof MissingRule) {
      return {
        status: "unavailable_models",
        missingDependencies: [{ kind: "rule", id: `${e.family}:${e.ruleName}` }],
      };
    }
    if (e instanceof UnsupportedExprOp) {
      return { status: "failed", missingDependencies: [] };
    }
    return { status: "failed", missingDependencies: [] };
  }
}
