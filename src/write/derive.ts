import type { Corpus } from "../algebra/types.js";
import { evaluate, type EvalContext, type Stage } from "../algebra/expression.js";
import type { CandidateClaim } from "../core/claim.js";
import type { StorageAdapter } from "../adapters/adapter.js";
import type { Catalog } from "../catalog/catalog.js";
import type { Scope } from "../core/scope.js";

export interface DeriveOptions {
  subject: string;
  key: string;
  scope: Scope;
  combination?: string;
  evaluationClock?: number;
}

/**
 * Runs the pipeline through a freshly pinned EvalContext, takes the synthesized
 * result claim, and assembles a partial DerivationProvenance (inputs, combination
 * rule, evaluationClock, captured versions). Produces an unpersisted CandidateClaim;
 * persistence is commit_derived's job.
 */
export function deriveClaimFrom(
  adapter: StorageAdapter,
  catalog: Catalog,
  pipeline: Stage<any, any>[],
  opts: DeriveOptions
): CandidateClaim {
  const ctx: EvalContext = {
    adapter,
    catalog,
    evaluationClock: opts.evaluationClock ?? Date.now(),
    usedSimilarityVersions: {},
    usedEmbeddingModelVersions: {},
  };

  const result = evaluate<Corpus>(pipeline, ctx);
  const inputClaims = result.claims.map((c) => c.id);

  // Choose the representative/synthesized claim to carry forward.
  // For a synthesize pipeline that produced one claim, or the top-ranked.
  const rep = result.claims[result.claims.length - 1] ?? result.claims[0];

  return {
    subject: opts.subject,
    key: opts.key,
    scope: opts.scope,
    value: rep?.value,
    confidence: rep?.confidence,
    evidence: rep?.evidence ?? [],
    tags: [],
    source: "workflow",
    // Carry profile/workspace from the representative input claim when available.
    profile: (rep as any)?.profile,
    workspace: (rep as any)?.workspace,
    // valid: carry from rep if present, or leave as placeholder for commit_derived.
    valid: (rep as any)?.valid,
    schema: (rep as any)?.schema ?? "",
    provenance: {
      derivedFrom: {
        queryExpression: "",
        corpusState: 0,
        combinationRule: opts.combination,
        inputClaims: inputClaims as any,
        similarityVersions: { ...ctx.usedSimilarityVersions },
        embeddingModelVersions: { ...ctx.usedEmbeddingModelVersions },
        evaluationClock: ctx.evaluationClock!,
      },
    },
  } as CandidateClaim;
}
