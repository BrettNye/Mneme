import type { CandidateClaim, Claim, Status } from "../core/claim.js";
import { newClaimId, asCorpusId, type ClaimId } from "../core/ids.js";
import { scopeHash } from "../core/scope.js";
import { valueHash } from "../core/value.js";
import { validateScope, type ClaimSchema } from "../catalog/schema.js";
import { decideContradiction } from "./contradiction.js";
import { checkIdempotentAsync, recordIdempotentAsync, idempotencyScope } from "./idempotency.js";
import type { ContradictionPolicy } from "../catalog/corpus.js";
import type { ClaimEvent } from "../adapters/adapter.js";
import type { AsyncStorageAdapter } from "../adapters/async-adapter.js";
import type { BatchPolicy, BatchResult, BatchWriteResult } from "./pipeline.js";
import {
  buildCommittedClaim,
  contradictionArtifact,
  buildCommitEvent,
  buildSupersedeEvent,
  buildPromoteEvent,
} from "./claim-build.js";

// Forward-only lifecycle transitions (excluding any→deprecated which is always valid).
// Mirrors the sync Promoter's private table (src/write/pipeline.ts).
const LIFECYCLE_ORDER: Status[] = ["candidate", "provisional", "validated", "deprecated"];

function isForwardTransition(from: Status, to: Status): boolean {
  if (to === "deprecated") return true; // any → deprecated always valid
  const fromIdx = LIFECYCLE_ORDER.indexOf(from);
  const toIdx = LIFECYCLE_ORDER.indexOf(to);
  return toIdx > fromIdx;
}

/**
 * Async twin of {@link Promoter} (src/write/pipeline.ts). Same public surface —
 * commit / commitBatch / supersede / promote — over an {@link AsyncStorageAdapter},
 * reusing the extracted pure logic (decideContradiction + the claim-build builders +
 * the async idempotency helpers). No construction is re-inlined here.
 *
 * Binding difference from the sync path: the idempotency CHECK moves INSIDE the
 * transaction (after the advisory lock the adapter takes as its first statement),
 * closing the concurrency double-write window. The adapter owns the lock; this
 * class never manages it.
 */
export class AsyncPromoter {
  constructor(
    private readonly adapter: AsyncStorageAdapter,
    private readonly schema: ClaimSchema,
    private readonly corpusId = "",
    private readonly clock: () => number = Date.now
  ) {}

  /**
   * Atomic write core. Wraps everything in adapter.transaction(corpusId, ...); the
   * idempotency check + record both live inside the transaction. recordedSeq derives
   * from a corpus-scoped maxRecordedSeq()+1. The body may omit `event` (e.g. a path
   * that writes nothing) — then nothing is logged and no idempotency record is written.
   */
  private write<T>(
    idem: { scope: string; key?: string } | undefined,
    body: (recorded: number, seq: number) => Promise<{ result: T; id?: string; event?: ClaimEvent }>
  ): Promise<T> {
    return this.adapter.transaction(this.corpusId, async () => {
      if (idem?.key) {
        const prior = await checkIdempotentAsync(this.adapter, idem.scope, idem.key, this.clock());
        if (prior) {
          // Duplicate replay — return the prior id. T must accommodate { id, status }.
          return { id: prior, status: "duplicate" } as unknown as T;
        }
      }
      const recorded = this.clock();
      const seq = (await this.adapter.maxRecordedSeq(this.corpusId)) + 1;
      const { result, id, event } = await body(recorded, seq);
      if (event) await this.adapter.appendEvent(event); // reject path returns no event → nothing logged
      if (idem?.key && id) {
        await recordIdempotentAsync(this.adapter, idem.scope, idem.key, id, this.clock());
      }
      return result;
    });
  }

  async commit(
    candidate: CandidateClaim,
    opts: {
      policy: ContradictionPolicy;
      writer: string;
      idempotencyKey?: string;
    }
  ): Promise<{ id: string; status: "committed" | "rejected" | "duplicate" }> {
    // Scope idempotency by the ENFORCED corpus boundary, not candidate.workspace
    // (workspace is untrusted for isolation — see the sync Promoter for the rationale).
    const scope = idempotencyScope(this.corpusId, opts.writer, candidate.key);

    validateScope(candidate.scope, this.schema);

    // Build a partial claim with hashes and id — needed for the contradiction decision.
    const claimId = newClaimId();
    const candidateForEnforce = {
      ...candidate,
      id: claimId,
      ...(this.corpusId ? { corpusId: asCorpusId(this.corpusId) } : {}),
      scopeHash: scopeHash(candidate.scope),
      valueHash: valueHash(candidate.value),
      recorded: 0, // placeholder — overwritten after accept
      recordedSeq: 0, // placeholder — overwritten after accept
      status: candidate.status ?? "validated",
      audience: candidate.audience ?? {}, // persona-targeting hints default to none (§2.1)
    } as Claim;

    // Load the validated (corpus,subject,key,scope) group, then decide purely.
    // Mirrors findValidatedConflict's query-construction site.
    const existing = await this.adapter.query({
      corpusId: this.corpusId,
      subject: candidateForEnforce.subject,
      key: candidateForEnforce.key,
      status: ["validated"],
      scopeHash: candidateForEnforce.scopeHash,
    });
    const outcome = decideContradiction(candidateForEnforce, existing, opts.policy, this.corpusId);

    if (outcome.decision === "reject") {
      // Reject path: no event, no idempotency record.
      return { id: claimId, status: "rejected" };
    }

    return this.write(
      opts.idempotencyKey ? { scope, key: opts.idempotencyKey } : undefined,
      async (recorded, seq) => {
        const claim: Claim = buildCommittedClaim(candidateForEnforce, recorded, seq);

        for (const id of outcome.deprecateIds ?? []) {
          await this.adapter.deleteClaim(id as ClaimId);
        }
        await this.adapter.insertClaim(claim);

        // accept_but_mark (§7.3): both claims live; write a queryable contradiction artifact.
        if (outcome.markArtifact && outcome.conflictId) {
          await this.adapter.insertClaim(contradictionArtifact(claim, outcome.conflictId, recorded, seq));
        }

        const event: ClaimEvent = buildCommitEvent(this.corpusId, opts.writer, claim.id, recorded, seq);

        return { result: { id: claim.id, status: "committed" as const }, id: claim.id, event };
      }
    );
  }

  /**
   * §7.5 commit_batch — non-atomic, high-throughput batch write. Loops the single-write
   * commit() per item; deliberately NOT wrapped in one transaction, so a failing item does
   * not roll back the writes that already succeeded. Per-write status collected in input
   * order. stopOnError flips to fail-fast.
   */
  async commitBatch(
    claims: (CandidateClaim & { idempotencyKey?: string })[],
    opts: {
      policy: ContradictionPolicy;
      writer: string;
      batchPolicy?: BatchPolicy;
    }
  ): Promise<BatchResult> {
    const stopOnError = opts.batchPolicy?.stopOnError ?? false;
    const results: BatchWriteResult[] = [];

    for (let index = 0; index < claims.length; index++) {
      const { idempotencyKey, ...candidate } = claims[index];
      try {
        const r = await this.commit(candidate, {
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

  async supersede(
    deprecateId: ClaimId,
    replacement: CandidateClaim,
    opts: {
      writer: string;
      idempotencyKey?: string;
    }
  ): Promise<{ id: string; status: "superseded" | "duplicate" }> {
    validateScope(replacement.scope, this.schema);

    // Enforced corpus boundary, not caller-supplied workspace (see commit()).
    const idemScope = idempotencyScope(this.corpusId, opts.writer, replacement.key);

    return this.write(
      opts.idempotencyKey ? { scope: idemScope, key: opts.idempotencyKey } : undefined,
      async (recorded, seq) => {
        const newId = newClaimId();
        const newClaim: Claim = {
          ...replacement,
          id: newId,
          ...(this.corpusId ? { corpusId: asCorpusId(this.corpusId) } : {}),
          scopeHash: scopeHash(replacement.scope),
          valueHash: valueHash(replacement.value),
          recorded,
          recordedSeq: seq,
          status: replacement.status ?? "validated",
          audience: replacement.audience ?? {},
        };

        // Best-effort soft-deprecate (missing id → no-op for store, but the call is made).
        await this.adapter.deleteClaim(deprecateId);
        await this.adapter.insertClaim(newClaim);

        const event: ClaimEvent = buildSupersedeEvent(this.corpusId, opts.writer, newId, deprecateId, recorded, seq);

        return { result: { id: newId, status: "superseded" as const }, id: newId, event };
      }
    );
  }

  async promote(
    targetId: ClaimId,
    to: Status,
    opts: {
      writer: string;
      reason?: string;
      idempotencyKey?: string;
    }
  ): Promise<{ id: string; status: "promoted" | "invalid_transition" | "not_found" | "duplicate" }> {
    const target = await this.adapter.getClaim(targetId);
    if (!target) return { id: targetId, status: "not_found" };

    // Forward-only lifecycle check.
    if (!isForwardTransition(target.status, to)) {
      return { id: targetId, status: "invalid_transition" };
    }

    // Enforced corpus boundary, not caller-supplied workspace (see commit()).
    const idemScope = idempotencyScope(this.corpusId, opts.writer, target.key);

    return this.write(
      opts.idempotencyKey ? { scope: idemScope, key: opts.idempotencyKey } : undefined,
      async (recorded, seq) => {
        // The claim keeps its own recorded/recordedSeq; only status changes.
        const promotedClaim: Claim = {
          ...target,
          status: to,
        };
        await this.adapter.insertClaim(promotedClaim);

        const event: ClaimEvent = buildPromoteEvent(this.corpusId, opts.writer, targetId, to, opts.reason, recorded, seq);

        return { result: { id: targetId, status: "promoted" as const }, id: targetId, event };
      }
    );
  }
}
