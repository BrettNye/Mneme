import type { Claim } from "../core/claim.js";
import { newClaimId } from "../core/ids.js";
import { valueHash } from "../core/value.js";
import { INFINITY } from "../core/time.js";
import { scalarConfidence } from "../core/confidence.js";
import type { ClaimEvent } from "../adapters/adapter.js";

/**
 * Pure builders lifted out of Promoter (src/write/pipeline.ts) so a future
 * async write path can share identical construction. No adapter/I/O here —
 * these are object-literal constructors only.
 */

/**
 * Overlay the recorded/recordedSeq assigned inside the write transaction onto
 * the already-enforced candidate claim.
 */
export function buildCommittedClaim(candidateForEnforce: Claim, recorded: number, seq: number): Claim {
  return {
    ...candidateForEnforce,
    recorded,
    recordedSeq: seq,
  };
}

/**
 * Build the `contradiction` artifact claim for the accept_but_mark policy (§7.3).
 * Records the conflicting pair's ids as its value; a scalar-certain, validated,
 * verification-sourced claim under the reserved `contradiction` subject so it is
 * directly queryable. Inserted alongside the accepted claim, not run through enforce().
 */
export function contradictionArtifact(
  accepted: Claim,
  conflictId: string,
  recorded: number,
  seq: number
): Claim {
  const value = { leftId: accepted.id, rightId: conflictId } as Claim["value"];
  return {
    id: newClaimId(),
    profile: accepted.profile,
    workspace: accepted.workspace,
    ...(accepted.corpusId ? { corpusId: accepted.corpusId } : {}),
    subject: "contradiction" as Claim["subject"],
    key: "contradiction.mark" as Claim["key"],
    scope: accepted.scope,
    scopeHash: accepted.scopeHash,
    value,
    valueHash: valueHash(value),
    confidence: scalarConfidence(1),
    valid: { from: recorded, to: INFINITY },
    recorded,
    recordedSeq: seq,
    status: "validated",
    source: "verification",
    provenance: {},
    evidence: [],
    audience: {},
    tags: [],
    schema: "contradiction-mark-v1",
  };
}

export function buildCommitEvent(
  corpusId: string,
  writer: string,
  claimId: string,
  recorded: number,
  seq: number
): ClaimEvent {
  return {
    op: "commit",
    corpusId,
    writer,
    claimId,
    recorded,
    recordedSeq: seq,
  };
}

export function buildSupersedeEvent(
  corpusId: string,
  writer: string,
  claimId: string,
  deprecatedId: string,
  recorded: number,
  seq: number
): ClaimEvent {
  return {
    op: "supersede",
    corpusId,
    writer,
    claimId,
    deprecatedId,
    recorded,
    recordedSeq: seq,
  };
}

export function buildPromoteEvent(
  corpusId: string,
  writer: string,
  claimId: string,
  toStatus: string,
  reason: string | undefined,
  recorded: number,
  seq: number
): ClaimEvent {
  return {
    op: "promote",
    corpusId,
    writer,
    claimId,
    toStatus,
    reason,
    recorded,
    recordedSeq: seq,
  };
}
