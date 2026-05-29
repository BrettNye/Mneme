import type { CandidateClaim, Claim, Status } from "../core/claim.js";
import { newClaimId, type ClaimId } from "../core/ids.js";
import { scopeHash } from "../core/scope.js";
import { valueHash } from "../core/value.js";
import { validateScope, type ClaimSchema } from "../catalog/schema.js";
import { enforce } from "./contradiction.js";
import { checkIdempotent, recordIdempotent, idempotencyScope } from "./idempotency.js";
import type { ContradictionPolicy } from "../catalog/corpus.js";
import type { ClaimEvent, StorageAdapter } from "../adapters/adapter.js";

/**
 * §7.5 batch writes — non-atomic, high-throughput.
 *
 * Per-write outcome status. "committed" | "rejected" | "duplicate" mirror the
 * single-write commit() return; "error" is a per-item failure (e.g. a thrown
 * validation error) that, per spec, does NOT roll back successful writes in the
 * same batch.
 */
export type BatchWriteStatus = "committed" | "rejected" | "duplicate" | "error";

export interface BatchWriteResult {
  index: number;
  id?: string;
  status: BatchWriteStatus;
  error?: string;
}

export interface BatchResult {
  results: BatchWriteResult[];
}

/**
 * Batch-level knobs. Defaults to continue-on-error (non-atomic high-throughput).
 * stopOnError flips to fail-fast: the first errored write halts further attempts.
 */
export type BatchPolicy = { stopOnError?: boolean };

// Forward-only lifecycle transitions (excluding any→deprecated which is always valid)
const LIFECYCLE_ORDER: Status[] = ["candidate", "provisional", "validated", "deprecated"];

function isForwardTransition(from: Status, to: Status): boolean {
  if (to === "deprecated") return true; // any → deprecated always valid
  const fromIdx = LIFECYCLE_ORDER.indexOf(from);
  const toIdx = LIFECYCLE_ORDER.indexOf(to);
  // Must be strictly forward (deprecated case handled above)
  return toIdx > fromIdx;
}

export class Promoter {
  constructor(
    private readonly adapter: StorageAdapter,
    private readonly schema: ClaimSchema,
    private readonly corpusId = ""
  ) {}

  /**
   * Atomic write core. Wraps everything in adapter.transaction, derives
   * recordedSeq from maxRecordedSeq()+1, conditionally appends the ClaimEvent
   * and records idempotency — all inside the transaction.
   *
   * The body may return no event (e.g. reject path) by omitting `event`.
   * When event is absent, nothing is logged and no idempotency record is written.
   */
  private write<T>(
    idem: { scope: string; key?: string } | undefined,
    body: (recorded: number, seq: number) => { result: T; id?: string; event?: ClaimEvent }
  ): T {
    if (idem?.key) {
      const prior = checkIdempotent(this.adapter, idem.scope, idem.key, Date.now());
      if (prior) {
        // Return a duplicate result carrying the prior id.
        // The generic result type T must accommodate { id, status } so we cast.
        return { id: prior, status: "duplicate" } as unknown as T;
      }
    }
    return this.adapter.transaction(() => {
      const recorded = Date.now();
      const seq = this.adapter.maxRecordedSeq() + 1;
      const { result, id, event } = body(recorded, seq);
      if (event) this.adapter.appendEvent(event);              // reject path returns no event → nothing logged
      if (idem?.key && id) {
        recordIdempotent(this.adapter, idem.scope, idem.key, id, Date.now());
      }
      return result;
    });
  }

  commit(
    candidate: CandidateClaim,
    opts: {
      policy: ContradictionPolicy;
      writer: string;
      idempotencyKey?: string;
    }
  ): { id: string; status: "committed" | "rejected" | "duplicate" } {
    const scope = idempotencyScope(candidate.workspace, opts.writer, candidate.key);

    validateScope(candidate.scope, this.schema);

    // Build a partial claim with hashes and id — needed for enforce() to inspect.
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

    if (outcome.decision === "reject") {
      // Reject path: no event, no idempotency record
      return { id: claimId, status: "rejected" };
    }

    // Accepted: write atomically via the shared core.
    return this.write(
      opts.idempotencyKey ? { scope, key: opts.idempotencyKey } : undefined,
      (recorded, seq) => {
        const claim: Claim = {
          ...candidateForEnforce,
          recorded,
          recordedSeq: seq,
        };

        outcome.deprecateIds?.forEach((id) => this.adapter.deleteClaim(id as ClaimId));
        this.adapter.insertClaim(claim);

        const event: ClaimEvent = {
          op: "commit",
          corpusId: this.corpusId,
          writer: opts.writer,
          claimId: claim.id,
          recorded,
          recordedSeq: seq,
        };

        return { result: { id: claim.id, status: "committed" as const }, id: claim.id, event };
      }
    );
  }

  /**
   * §7.5 commit_batch — non-atomic, high-throughput batch write.
   *
   * Loops over claims invoking the existing single-write commit() per item.
   * Each commit() is independently transactional; this method deliberately does
   * NOT wrap the batch in one transaction, so a failure of an individual write
   * does not roll back the writes that already succeeded. Per-write status is
   * collected in input order and claims become visible incrementally.
   *
   * An item may carry an optional `idempotencyKey` (passed through to commit()).
   * A thrown error from one write is captured as status "error" and the loop
   * continues — unless opts.batchPolicy.stopOnError is set, in which case the
   * batch halts after recording that error.
   */
  commitBatch(
    claims: (CandidateClaim & { idempotencyKey?: string })[],
    opts: {
      policy: ContradictionPolicy;
      writer: string;
      batchPolicy?: BatchPolicy;
    }
  ): BatchResult {
    const stopOnError = opts.batchPolicy?.stopOnError ?? false;
    const results: BatchWriteResult[] = [];

    for (let index = 0; index < claims.length; index++) {
      const { idempotencyKey, ...candidate } = claims[index];
      try {
        const r = this.commit(candidate, {
          policy: opts.policy,
          writer: opts.writer,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        });
        results.push({ index, id: r.id, status: r.status });
      } catch (e) {
        results.push({
          index,
          status: "error",
          error: e instanceof Error ? e.message : String(e),
        });
        if (stopOnError) break;
      }
    }

    return { results };
  }

  supersede(
    deprecateId: ClaimId,
    replacement: CandidateClaim,
    opts: {
      writer: string;
      idempotencyKey?: string;
    }
  ): { id: string; status: "superseded" | "duplicate" } {
    validateScope(replacement.scope, this.schema);

    const idemScope = idempotencyScope(replacement.workspace, opts.writer, replacement.key);

    return this.write(
      opts.idempotencyKey ? { scope: idemScope, key: opts.idempotencyKey } : undefined,
      (recorded, seq) => {
        const newId = newClaimId();
        const newClaim: Claim = {
          ...replacement,
          id: newId,
          scopeHash: scopeHash(replacement.scope),
          valueHash: valueHash(replacement.value),
          recorded,
          recordedSeq: seq,
          status: replacement.status ?? "validated",
        };

        // Best-effort soft-deprecate (missing id → no-op for store, but call is made)
        this.adapter.deleteClaim(deprecateId);
        this.adapter.insertClaim(newClaim);

        const event: ClaimEvent = {
          op: "supersede",
          corpusId: this.corpusId,
          writer: opts.writer,
          claimId: newId,
          deprecatedId: deprecateId,
          recorded,
          recordedSeq: seq,
        };

        return { result: { id: newId, status: "superseded" as const }, id: newId, event };
      }
    );
  }

  promote(
    targetId: ClaimId,
    to: Status,
    opts: {
      writer: string;
      reason?: string;
      idempotencyKey?: string;
    }
  ): { id: string; status: "promoted" | "invalid_transition" | "not_found" | "duplicate" } {
    const target = this.adapter.getClaim(targetId);
    if (!target) return { id: targetId, status: "not_found" };

    // Forward-only lifecycle check
    if (!isForwardTransition(target.status, to)) {
      return { id: targetId, status: "invalid_transition" };
    }

    const idemScope = idempotencyScope(target.workspace, opts.writer, target.key);

    return this.write(
      opts.idempotencyKey ? { scope: idemScope, key: opts.idempotencyKey } : undefined,
      (recorded, seq) => {
        // The claim keeps its own recorded/recordedSeq; only status changes
        const promotedClaim: Claim = {
          ...target,
          status: to,
        };
        this.adapter.insertClaim(promotedClaim);

        const event: ClaimEvent = {
          op: "promote",
          corpusId: this.corpusId,
          writer: opts.writer,
          claimId: targetId,
          toStatus: to,
          reason: opts.reason,
          recorded,
          recordedSeq: seq,
        };

        return { result: { id: targetId, status: "promoted" as const }, id: targetId, event };
      }
    );
  }
}
