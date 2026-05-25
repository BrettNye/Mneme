import type { CandidateClaim, Claim } from "../core/claim.js";
import { newClaimId, type ClaimId } from "../core/ids.js";
import { scopeHash } from "../core/scope.js";
import { valueHash } from "../core/value.js";
import { validateScope, type ClaimSchema } from "../catalog/schema.js";
import { enforce } from "./contradiction.js";
import { checkIdempotent, recordIdempotent, idempotencyScope } from "./idempotency.js";
import type { ContradictionPolicy } from "../catalog/corpus.js";
import type { StorageAdapter } from "../adapters/adapter.js";

export class Promoter {
  private seq = 0;
  private lastRecorded = 0;

  constructor(
    private readonly adapter: StorageAdapter,
    private readonly schema: ClaimSchema
  ) {}

  commit(
    candidate: CandidateClaim,
    opts: {
      policy: ContradictionPolicy;
      writer: string;
      idempotencyKey?: string;
    }
  ): { id: string; status: "committed" | "rejected" | "duplicate" } {
    const scope = idempotencyScope(candidate.workspace, opts.writer, candidate.key);

    if (opts.idempotencyKey) {
      const prior = checkIdempotent(this.adapter, scope, opts.idempotencyKey, Date.now());
      if (prior) return { id: prior, status: "duplicate" };
    }

    validateScope(candidate.scope, this.schema);

    // Build a partial claim with hashes and id — needed for enforce() to inspect.
    // Do NOT mutate this.seq or this.lastRecorded yet; those only advance on accept.
    const claimId = newClaimId();
    const candidateForEnforce = {
      ...candidate,
      id: claimId,
      scopeHash: scopeHash(candidate.scope),
      valueHash: valueHash(candidate.value),
      recorded: 0,       // placeholder — will be overwritten after accept
      recordedSeq: 0,    // placeholder — will be overwritten after accept
      status: candidate.status ?? "validated",
    } as Claim;

    const outcome = enforce(candidateForEnforce, opts.policy, this.adapter);

    if (outcome.decision === "reject") return { id: claimId, status: "rejected" };

    // Accepted: now advance the monotonic counters and finalize the claim.
    const recorded = Math.max(Date.now(), this.lastRecorded);
    this.lastRecorded = recorded;

    const claim: Claim = {
      ...candidateForEnforce,
      recorded,
      recordedSeq: this.seq++,
    };

    outcome.deprecateIds?.forEach((id) => this.adapter.deleteClaim(id as ClaimId));
    this.adapter.insertClaim(claim);

    if (opts.idempotencyKey) {
      recordIdempotent(this.adapter, scope, opts.idempotencyKey, claim.id, Date.now());
    }

    return { id: claim.id, status: "committed" };
  }
}
