import type { CandidateClaim, Claim } from "../core/claim.js";
import { newClaimId } from "../core/ids.js";
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

    const recorded = Math.max(Date.now(), this.lastRecorded);
    this.lastRecorded = recorded;

    const claim: Claim = {
      ...candidate,
      id: newClaimId(),
      scopeHash: scopeHash(candidate.scope),
      valueHash: valueHash(candidate.value),
      recorded,
      recordedSeq: this.seq++,
      status: candidate.status ?? "validated",
    };

    const outcome = enforce(claim, opts.policy, this.adapter);

    if (outcome.decision === "reject") return { id: claim.id, status: "rejected" };

    outcome.deprecateIds?.forEach((id) => this.adapter.deleteClaim(id as any));
    this.adapter.insertClaim(claim);

    if (opts.idempotencyKey) {
      recordIdempotent(this.adapter, scope, opts.idempotencyKey, claim.id, Date.now());
    }

    return { id: claim.id, status: "committed" };
  }
}
