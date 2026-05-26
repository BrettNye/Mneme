import { createSqliteAdapter } from "../adapters/sqlite.js";
import type { StorageAdapter } from "../adapters/adapter.js";
import type { Claim, CandidateClaim } from "../core/claim.js";
import { newClaimId, type ClaimId } from "../core/ids.js";
import { scopeHash } from "../core/scope.js";
import { valueHash } from "../core/value.js";
import { now } from "../core/time.js";
import type { AppendOp, AppendResult, BioQuery } from "./types.js";

export interface MnemeGateway {
  read(query: BioQuery): Claim[];
  readByIds(ids: ClaimId[]): Claim[];
  apply(ops: AppendOp[], opKey: (op: AppendOp, i: number) => string): AppendResult;
  // NOTE: deliberately no update()/delete() — append-only is enforced by the type surface.
}

export function createMnemeGateway(adapter: StorageAdapter = createSqliteAdapter()): MnemeGateway {
  let seq = 0;
  const materialize = (c: CandidateClaim): Claim => ({
    ...c,
    id: newClaimId(),
    recorded: now(),
    recordedSeq: ++seq,
    scopeHash: scopeHash(c.scope),
    valueHash: valueHash(c.value),
    status: c.status ?? "validated",
  });
  return {
    read: (q) => adapter.query(q),
    readByIds: (ids) =>
      ids
        .map((id) => adapter.getClaim(id))
        .filter((c): c is Claim => c !== undefined),
    apply(ops, opKey) {
      let applied = 0,
        skipped = 0;
      for (let i = 0; i < ops.length; i++) {
        const key = opKey(ops[i], i);
        if (adapter.getIdempotencyRecord("bio", key)) {
          skipped++;
          continue;
        }
        const op = ops[i];
        if (op.kind === "derive") {
          adapter.insertClaim(materialize(op.claim));
        } else if (op.kind === "supersede") {
          // Insert the replacement claim with a fresh id (no in-place mutation).
          adapter.insertClaim(materialize(op.with));
          // Soft-delete (mark as deprecated) the old row — does NOT remove it physically.
          adapter.deleteClaim(op.deprecate);
        } else {
          // promote
          const c = adapter.getClaim(op.target);
          if (c) {
            // Re-insert the claim with only the status changed; id and all other
            // fields (value, confidence, evidence) remain untouched.
            adapter.insertClaim({ ...c, status: op.to });
          }
        }
        adapter.putIdempotencyRecord("bio", key, {
          result: op.kind,
          createdAt: now(),
        });
        applied++;
      }
      return { applied, skipped };
    },
  };
}
