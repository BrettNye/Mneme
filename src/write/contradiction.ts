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

export function findValidatedConflict(
  candidate: Claim,
  adapter: StorageAdapter
): Claim | undefined {
  return adapter
    .query({
      corpusId: candidate.workspace,
      subject: candidate.subject,
      key: candidate.key,
      status: ["validated"],
      scopeHash: candidate.scopeHash,
    })
    .find((existing) => existing.valueHash !== candidate.valueHash);
}

export function enforce(
  candidate: Claim,
  policy: ContradictionPolicy,
  adapter: StorageAdapter
): ContradictionOutcome {
  const conflict = findValidatedConflict(candidate, adapter);
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
