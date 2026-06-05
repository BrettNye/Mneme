import type { Corpus } from "../algebra/types.js";
import { evaluate, type EvalContext } from "../algebra/expression.js";
import { compile } from "../algebra/compile.js";
import { serializeExpr } from "../algebra/serialize.js";
import type { ExprNode } from "../algebra/ast.js";
import type { Claim, CandidateClaim } from "../core/claim.js";
import type { ClaimId } from "../core/ids.js";
import { inputHashesOf } from "../core/provenance.js";
import type { StorageAdapter } from "../adapters/adapter.js";
import type { Catalog } from "../catalog/catalog.js";
import type { Scope } from "../core/scope.js";

/**
 * Walks the linear src-chain to the leaf node and returns the leaf's corpusId.
 * All 12 ExprNode variants are linear (every non-leaf has exactly one `src`).
 */
function findLeafCorpusId(expr: ExprNode): string {
  let node: ExprNode = expr;
  while (node.op !== "leaf") {
    node = (node as { src: ExprNode }).src;
  }
  return node.corpusId;
}

/**
 * Pure normalization: rebuild the src-chain, stamping corpus defaults onto resolve
 * nodes that lack them. Explicit node values always win.
 *
 * ASSUMES linear expression chains — every non-leaf ExprNode has exactly one `src`
 * (verified for all 12 variants); the leaf corpus is found by walking `src` down to
 * the leaf and calling catalog.getCorpus(leaf.corpusId). If non-linear expressions
 * are ever introduced, stamping semantics must be revisited.
 */
export function stampResolveDefaults(expr: ExprNode, catalog: Catalog): ExprNode {
  if (expr.op === "leaf") {
    return expr;
  }

  // Recursively stamp the src first
  const srcNode = (expr as { src: ExprNode }).src;
  const stampedSrc = stampResolveDefaults(srcNode, catalog);

  if (expr.op === "resolve") {
    // Find the leaf corpus to get defaults
    const corpusId = findLeafCorpusId(srcNode);
    const corpus = catalog.getCorpus(corpusId);

    // Build a new resolve node — explicit values always win
    const newNode: Extract<ExprNode, { op: "resolve" }> = {
      op: "resolve",
      policy: expr.policy,
      src: stampedSrc,
    };

    // threshold: explicit wins, else stamp from corpus defaults
    newNode.threshold = expr.threshold !== undefined
      ? expr.threshold
      : corpus.defaults?.confidenceThreshold;

    // rule: carry through if present
    if (expr.rule !== undefined) {
      newNode.rule = expr.rule;
    }

    // keyCardinality: explicit wins, else stamp from schema (omit entirely when absent)
    if (expr.keyCardinality !== undefined) {
      newNode.keyCardinality = expr.keyCardinality;
    } else {
      const schemaKC = corpus.schema?.keyCardinality;
      if (schemaKC !== undefined) {
        newNode.keyCardinality = schemaKC;
      }
      // else: omit entirely (field-absent, not undefined-valued)
    }

    return newNode;
  }

  // For all other ops: rebuild with the stamped src
  return { ...expr, src: stampedSrc } as ExprNode;
}

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

  const stamped = stampResolveDefaults(expr, catalog);
  const result = evaluate<Corpus>(compile(stamped), ctx);

  if (result.claims.length === 0) {
    throw new Error("deriveClaimFrom: pipeline produced no claims; cannot derive a representative");
  }

  // The representative/synthesized claim is the last in the corpus (synthesize appends the derived claim last).
  const rep: Claim = result.claims[result.claims.length - 1];

  // inputClaims are the contributing claims excluding the derived representative itself.
  const inputs: Claim[] = result.claims.filter((c) => c !== rep);
  const inputClaims: ClaimId[] = inputs.map((c) => c.id);

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
        queryExpression: serializeExpr(stamped),
        corpusState: adapter.maxRecordedSeq(),
        combinationRule: opts.combination,
        inputClaims,
        inputHashes: inputHashesOf(inputs),
        similarityVersions: { ...ctx.usedSimilarityVersions },
        embeddingModelVersions: { ...ctx.usedEmbeddingModelVersions },
        evaluationClock: clock,
      },
    },
  } as CandidateClaim;
}
