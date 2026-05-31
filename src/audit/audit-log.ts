import { createHash } from "node:crypto";
import type { StorageAdapter } from "../adapters/adapter.js";
import type { AuditAnchor, Signer, Guarantee } from "./types.js";
import { GUARANTEE_RANK } from "./types.js";
import { merkleRoot } from "./merkle.js";

// MUST byte-for-byte match src/adapters/sqlite.ts canonicalEvent — the chain only verifies if the
// recomputed canonical string equals what the adapter hashed. Field order (verified against sqlite.ts):
// [op, corpusId, writer, claimId, deprecatedId ?? null, toStatus ?? null, reason ?? null, recorded, recordedSeq]
function canon(e: {
  op: string;
  corpusId: string;
  writer: string;
  claimId: string;
  deprecatedId?: string | null;
  toStatus?: string | null;
  reason?: string | null;
  recorded: number;
  recordedSeq: number;
}): string {
  return JSON.stringify([
    e.op,
    e.corpusId,
    e.writer,
    e.claimId,
    e.deprecatedId ?? null,
    e.toStatus ?? null,
    e.reason ?? null,
    e.recorded,
    e.recordedSeq,
  ]);
}

/**
 * Recomputes the per-corpus hash chain and reports integrity.
 * Returns { intact: true } if all entryHash/prevHash values are consistent,
 * or { intact: false, brokenAt: i } at the first inconsistency.
 *
 * This relies on canon() being byte-for-byte identical to sqlite.ts's canonicalEvent.
 */
export function verifyChain(
  adapter: StorageAdapter,
  corpus: string,
): { intact: boolean; brokenAt?: number } {
  const evs = adapter.readEvents({ corpusId: corpus });
  let prev = "";
  for (let i = 0; i < evs.length; i++) {
    const want = createHash("sha256")
      .update(canon(evs[i] as Parameters<typeof canon>[0]) + prev)
      .digest("hex");
    if (evs[i].entryHash !== want || evs[i].prevHash !== prev) {
      return { intact: false, brokenAt: i };
    }
    prev = evs[i].entryHash!;
  }
  return { intact: true };
}

/**
 * Merkle-roots the since-last-anchor entries, signs with the given signer,
 * and hands the root to the anchor. Returns the AnchorReceipt.
 */
export async function anchorEpoch(
  adapter: StorageAdapter,
  corpus: string,
  epochId: string,
  opts: { signer: Signer; anchor: AuditAnchor },
): Promise<ReturnType<AuditAnchor["anchor"]> extends Promise<infer R> ? R : never> {
  const leaves = adapter
    .readEvents({ corpusId: corpus })
    .map((e) => Uint8Array.from(Buffer.from(e.entryHash!, "hex")));
  const root = merkleRoot(leaves);
  const signature = await opts.signer.sign(root);
  return opts.anchor.anchor({ epochId, root, signature }) as any;
}

/**
 * Produces the audit report.
 * Licenses "tamper-evident" ONLY when the anchor guarantee is external-immutable or higher;
 * otherwise "tamper-detecting".
 */
export function auditReport(
  verify: { intact: boolean },
  anchorGuarantee: Guarantee,
): {
  intact: boolean;
  guarantee: Guarantee;
  claim: "tamper-evident" | "tamper-detecting";
} {
  const claim: "tamper-evident" | "tamper-detecting" =
    GUARANTEE_RANK[anchorGuarantee] >= GUARANTEE_RANK["external-immutable"]
      ? "tamper-evident"
      : "tamper-detecting";
  return { intact: verify.intact, guarantee: anchorGuarantee, claim };
}
