import type { Corpus } from "./types.js";
import { corpusOf, claimTripleKey, partitionBy, unionEvidence } from "./types.js";
import type { Claim } from "../core/claim.js";
import { bindingFor } from "../distribution/registry.js";
import { assertSupportsRule } from "../distribution/protocol.js";
import { assertNotDeprecatedRule, RULE } from "../distribution/rules.js";
import { SOURCE_WEIGHT } from "../core/source-trust.js";
import { similarityFn } from "./similarity.js";

/** Shared similarity-config shape — single owner; ast.ts type-imports this (DRY). */
export interface SimilarityConfig {
  fn: string;
  cutoff: number;
}

export interface DedupeOptions {
  /** Sub-partition each (subject, key, scopeHash) group by value similarity before merging. */
  similarity?: SimilarityConfig;
}

/**
 * Fold a group's claims through the pairwise combine(). For weighted_avg, thread the accumulated
 * source-weight so the fold equals the full normalized weighted average; max rules pre-sort by
 * claim id so the first-arg-wins tie-break is lexicographic; evidence_pooled folds exactly.
 */
export const oplusDedupe =
  (ruleId: string, params?: unknown, opts?: DedupeOptions) =>
  (c: Corpus): Corpus => {
    assertNotDeprecatedRule(ruleId);

    // Validate similarity config eagerly (before any grouping work)
    if (opts?.similarity) {
      const { fn, cutoff } = opts.similarity;
      // This throws /no similarity fn/ if unregistered
      similarityFn(fn);
      if (cutoff < 0 || cutoff > 1) {
        throw new Error(`similarity cutoff ${cutoff} is outside [0, 1]`);
      }
    }

    // Group claims by (subject, key, scopeHash)
    const groups = partitionBy(c.claims as Claim[], (cl) =>
      claimTripleKey(cl.subject, cl.key, cl.scopeHash)
    );

    const out: Claim[] = [];
    for (const group of groups.values()) {
      for (const part of subPartitions(group, opts)) {
        out.push(combineGroup(ruleId, part, params));
      }
    }
    return corpusOf(out);
  };

/**
 * No similarity configured → [group] (today's behavior, untouched).
 * Similarity mode: single-link clusters (transitive closure over pairwise
 * fn.scoreOne(a.value, b.value) >= cutoff — note >=, boundary scores merge).
 * BOTH sorts happen INSIDE this function (callers pass groups as-is):
 *   1. sort group by id ASC before clustering → deterministic under input reordering;
 *   2. sort each resulting cluster by valid.from DESC (id ASC tie-break) before
 *      returning, so combineGroup's fold rules (weighted_avg, evidence_pooled,
 *      dempster) take the LATEST member as the base/representative ("keep richest"
 *      pinned rule), while max rules still return their true winner (combineGroup
 *      semantics untouched — its own needsSort re-sorts; no chimera claims).
 * Throws: unregistered fn (via similarityFn), cutoff outside [0, 1].
 */
function subPartitions(group: Claim[], opts?: DedupeOptions): Claim[][] {
  if (!opts?.similarity) {
    return [group];
  }

  const { fn: fnName, cutoff } = opts.similarity;
  const simFn = similarityFn(fnName);

  // 1. Sort by id ASC for determinism
  const sorted = [...group].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const n = sorted.length;
  // Union-Find for single-link clustering
  const parent = Array.from({ length: n }, (_, i) => i);

  function find(i: number): number {
    if (parent[i] !== i) parent[i] = find(parent[i]);
    return parent[i];
  }

  function union(i: number, j: number): void {
    const pi = find(i);
    const pj = find(j);
    if (pi !== pj) parent[pi] = pj;
  }

  // Pairwise similarity check — single-link: any edge merges two components
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const score = simFn.scoreOne(sorted[i].value, sorted[j].value);
      if (score >= cutoff) {
        union(i, j);
      }
    }
  }

  // Collect clusters by root
  const clusterMap = new Map<number, Claim[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!clusterMap.has(root)) clusterMap.set(root, []);
    clusterMap.get(root)!.push(sorted[i]);
  }

  // 2. Sort each cluster by valid.from DESC (id ASC tie-break)
  //    so sorted[0] in the cluster is the latest-valid.from representative
  const result: Claim[][] = [];
  for (const cluster of clusterMap.values()) {
    cluster.sort((a, b) => {
      const af = (a as any).valid?.from ?? 0;
      const bf = (b as any).valid?.from ?? 0;
      if (bf !== af) return bf - af; // DESC by valid.from
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // ASC by id as tie-break
    });
    result.push(cluster);
  }

  return result;
}

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
    const evidenceUnion = unionEvidence(claims.map((cl) => cl.evidence));

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
