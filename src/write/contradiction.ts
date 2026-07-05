import type { Claim } from "../core/claim.js";
import type { ContradictionPolicy } from "../catalog/corpus.js";
import type { StorageAdapter } from "../adapters/adapter.js";
import { pointEstimate } from "../core/confidence.js";

export interface ContradictionOutcome {
  decision: "accept" | "reject";
  markArtifact?: boolean;
  /** id of the currently-validated claim the candidate conflicts with — set when markArtifact is true. */
  conflictId?: string;
  deprecateIds?: string[];
}

/** Defense in depth: the candidate's enforced corpus, when present, MUST match the
 *  corpus we are enforcing under. A mismatch means a decoupling bug upstream — fail
 *  loudly rather than silently scoping the contradiction query to the wrong corpus. */
function assertCorpusMatch(candidate: Claim, corpusId: string): void {
  if (candidate.corpusId !== undefined && candidate.corpusId !== corpusId) {
    throw new Error(
      `corpus mismatch: candidate.corpusId "${candidate.corpusId}" !== enforced corpusId "${corpusId}"`
    );
  }
}

export function findValidatedConflict(
  candidate: Claim,
  adapter: StorageAdapter,
  corpusId: string
): Claim | undefined {
  assertCorpusMatch(candidate, corpusId);
  const existing = adapter.query({
    // The ENFORCED corpus, not candidate.workspace: workspace is caller-supplied and may
    // be decoupled from corpus_id. (A scoped adapter force-overrides this anyway, but we
    // key off the boundary by construction rather than relying on that masking.)
    corpusId,
    subject: candidate.subject,
    key: candidate.key,
    status: ["validated"],
    scopeHash: candidate.scopeHash,
  });
  return existing.find((e) => e.valueHash !== candidate.valueHash);
}

/** PURE: decide accept/reject/mark from the already-loaded validated group. No I/O.
 *  Includes the valueHash-inequality filter and corpus-mismatch guard, shared with
 *  findValidatedConflict via assertCorpusMatch (not removed from there), so callers that
 *  have already loaded `existing` (e.g. an async promoter) can reuse the exact same policy
 *  decision without re-querying. */
export function decideContradiction(
  candidate: Claim,
  existing: Claim[],
  policy: ContradictionPolicy,
  corpusId: string
): ContradictionOutcome {
  assertCorpusMatch(candidate, corpusId);
  const conflict = existing.find((e) => e.valueHash !== candidate.valueHash);
  if (!conflict) return { decision: "accept" };

  switch (policy.kind) {
    case "always_accept":
      return { decision: "accept" };

    case "reject_on_contradiction":
      return pointEstimate(conflict.confidence) >= pointEstimate(candidate.confidence)
        ? { decision: "reject" }
        : { decision: "accept" };

    case "accept_but_mark":
      return { decision: "accept", markArtifact: true, conflictId: conflict.id };

    case "accept_and_resolve":
      if (policy.rule === "deprecate_lower") {
        const candidateHigher =
          pointEstimate(candidate.confidence) > pointEstimate(conflict.confidence);
        return {
          decision: "accept",
          deprecateIds: candidateHigher ? [conflict.id] : [],
        };
      }
      // keep_newer: accept, no deprecation by confidence
      return { decision: "accept", deprecateIds: [] };
  }
}

/** enforce = findValidatedConflict (I/O: the single query-construction site) -> decideContradiction (pure).
 *  Wrapping the single found conflict (if any) as a one-element array preserves decideContradiction's
 *  exact outcome, since decideContradiction's policy switch only ever looks at the one entry its own
 *  `.find` would have matched — which is precisely the entry findValidatedConflict already found. This
 *  avoids re-issuing (and duplicating) the adapter.query call. */
export function enforce(
  candidate: Claim,
  policy: ContradictionPolicy,
  adapter: StorageAdapter,
  corpusId: string
): ContradictionOutcome {
  const conflict = findValidatedConflict(candidate, adapter, corpusId);
  return decideContradiction(candidate, conflict ? [conflict] : [], policy, corpusId);
}
