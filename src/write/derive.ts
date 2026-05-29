import type { Corpus } from "../algebra/types.js";
import { evaluate, type EvalContext } from "../algebra/expression.js";
import { compile } from "../algebra/compile.js";
import { serializeExpr } from "../algebra/serialize.js";
import type { ExprNode } from "../algebra/ast.js";
import type { Claim, CandidateClaim } from "../core/claim.js";
import type { ClaimId } from "../core/ids.js";
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
  expr: ExprNode,
  opts: DeriveOptions
): CandidateClaim {
  const clock: number = opts.evaluationClock ?? Date.now();
  const ctx: EvalContext = {
    adapter,
    catalog,
    evaluationClock: clock,
    usedSimilarityVersions: {},
    usedEmbeddingModelVersions: {},
  };

  const result = evaluate<Corpus>(compile(expr), ctx);

  if (result.claims.length === 0) {
    throw new Error("deriveClaimFrom: pipeline produced no claims; cannot derive a representative");
  }

  // The representative/synthesized claim is the last in the corpus (synthesize appends the derived claim last).
  const rep: Claim = result.claims[result.claims.length - 1];

  // inputClaims are the contributing claims excluding the derived representative itself.
  const inputClaims: ClaimId[] = result.claims.filter((c) => c !== rep).map((c) => c.id);

  return {
    subject: opts.subject,
    key: opts.key,
    scope: opts.scope,
    value: rep.value,
    confidence: rep.confidence,
    evidence: rep.evidence ?? [],
    tags: [],
    source: "workflow",
    // Carry profile/workspace from the representative input claim when available.
    profile: rep.profile,
    workspace: rep.workspace,
    // valid: carry from rep if present, or leave as placeholder for commit_derived.
    valid: rep.valid,
    schema: rep.schema ?? "",
    provenance: {
      derivedFrom: {
        queryExpression: serializeExpr(expr),
        corpusState: adapter.maxRecordedSeq(),
        combinationRule: opts.combination,
        inputClaims,
        similarityVersions: { ...ctx.usedSimilarityVersions },
        embeddingModelVersions: { ...ctx.usedEmbeddingModelVersions },
        evaluationClock: clock,
      },
    },
  } as CandidateClaim;
}
