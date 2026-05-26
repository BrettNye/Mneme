import type { CandidateClaim } from "../core/claim.js";
import type { Promoter } from "./pipeline.js";
import type { ContradictionPolicy } from "../catalog/corpus.js";

export interface CommitDerivedOptions {
  queryExpression: string;
  corpusState: number;
  writer: string;
  policy?: ContradictionPolicy;
  idempotencyKey?: string;
}

const SIMILARITY_MARKERS = ["rho", "jaccard", "exact", "cosine"];

export function commitDerived(
  promoter: Promoter,
  candidate: CandidateClaim,
  opts: CommitDerivedOptions
): { id: string; status: string } {
  const derivedFrom = candidate.provenance?.derivedFrom;
  if (!derivedFrom) {
    throw new Error("commitDerived: candidate has no derivedFrom provenance");
  }

  // Finalize the recorded query + corpus state
  derivedFrom.queryExpression = opts.queryExpression;
  derivedFrom.corpusState = opts.corpusState;

  // §7.6 mandatory version provenance: if the query referenced similarity ops, versions MUST be present
  const usesSimilarity = SIMILARITY_MARKERS.some((m) => opts.queryExpression.includes(m));
  if (usesSimilarity && Object.keys(derivedFrom.similarityVersions).length === 0) {
    throw new Error(
      "commitDerived: query uses similarity operators but similarityVersions is empty (§7.6 mandatory version provenance)"
    );
  }

  return promoter.commit(candidate, {
    policy: opts.policy ?? { kind: "always_accept" },
    writer: opts.writer,
    idempotencyKey: opts.idempotencyKey,
  });
}
