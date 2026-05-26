import type { Mneme } from "../mneme.js";
import type { Claim } from "../core/claim.js";
import type { ClaimId } from "../core/ids.js";
import type { AppendOp, AppendResult, BioQuery } from "./types.js";

const BIO_WRITER = "bio";

export interface MnemeGateway {
  read(query: BioQuery): Claim[];
  readByIds(ids: ClaimId[]): Claim[];
  apply(ops: AppendOp[], opKey: (op: AppendOp, i: number) => string): AppendResult;
  // NOTE: deliberately no update()/delete() — append-only is enforced by the type surface.
}

export function createMnemeGateway(mneme: Mneme, corpusId: string): MnemeGateway {
  const isApplied = (s: string) =>
    s === "committed" || s === "superseded" || s === "promoted";

  return {
    read: (q) => mneme.read(corpusId, q),
    readByIds: (ids) => mneme.readByIds(corpusId, ids),
    apply(ops, opKey) {
      let applied = 0, skipped = 0;
      const rejected: { key: string; status: string }[] = [];

      for (let i = 0; i < ops.length; i++) {
        const key = opKey(ops[i], i);
        const op = ops[i];

        const r =
          op.kind === "derive"
            ? mneme.commit(corpusId, op.claim, {
                policy: { kind: "always_accept" },
                writer: BIO_WRITER,
                idempotencyKey: key,
              })
            : op.kind === "supersede"
            ? mneme.supersede(corpusId, op.deprecate, op.with, {
                writer: BIO_WRITER,
                idempotencyKey: key,
              })
            : mneme.promote(corpusId, op.target, op.to, {
                writer: BIO_WRITER,
                reason: op.reason,
                idempotencyKey: key,
              });

        if (isApplied(r.status)) applied++;
        else if (r.status === "duplicate") skipped++;
        else rejected.push({ key, status: r.status });
      }

      return { applied, skipped, rejected };
    },
  };
}
