import type { ClaimId } from "./ids.js";

export type EvidenceRef =
  | { kind: "claim"; claimId: ClaimId }
  | { kind: "document"; sourceDocumentId: string; offsetStart?: number; offsetEnd?: number; extractionMethod: string }
  | { kind: "external"; uri: string; contentHash?: string };

/**
 * Returns true if adding edges from `newId` to the given `refs` would create a cycle
 * in the claim evidence graph. Only "claim" refs participate in cycle detection;
 * "document" and "external" refs are ignored.
 *
 * @param newId - The claim being created/updated (the source node)
 * @param refs - The proposed evidence refs for newId
 * @param edgesOf - Returns existing evidence refs for any existing claim
 */
export function wouldCreateCycle(
  newId: ClaimId,
  refs: EvidenceRef[],
  edgesOf: (id: ClaimId) => EvidenceRef[],
): boolean {
  const seen = new Set<ClaimId>();
  const stack = refs
    .filter((r): r is { kind: "claim"; claimId: ClaimId } => r.kind === "claim")
    .map((r) => r.claimId);

  while (stack.length) {
    const id = stack.pop()!;
    if (id === newId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of edgesOf(id)) {
      if (e.kind === "claim") stack.push(e.claimId);
    }
  }

  return false;
}
