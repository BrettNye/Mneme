import type { AuditAnchor, AnchorReceipt, AnchoredRoot, Signature } from "./types.js";
import type { StorageAdapter } from "../adapters/adapter.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function reviveSig(json: string): Signature {
  const parsed = JSON.parse(json) as { alg: string; bytes: string; keyRef?: string };
  return {
    alg: parsed.alg,
    bytes: Uint8Array.from(Buffer.from(parsed.bytes, "hex")),
    ...(parsed.keyRef !== undefined ? { keyRef: parsed.keyRef } : {}),
  };
}

export function createLocalAnchor(adapter: StorageAdapter, corpusId: string): AuditAnchor {
  return {
    id: "local",
    guarantee: "detect",
    async anchor({ epochId, root, signature }) {
      const at = Date.now();
      adapter.putAnchoredRoot!({
        corpusId,
        epochId,
        root: hex(root),
        signature: signature
          ? JSON.stringify({ ...signature, bytes: hex(signature.bytes) })
          : null,
        guarantee: "detect",
        at,
      });
      const receipt: AnchorReceipt = {
        anchorId: "local",
        epochId,
        guarantee: "detect",
        at,
      };
      return receipt;
    },
    async fetch(range) {
      const adapterRange: { epochId?: string; since?: number } = {};
      if (range.epochId !== undefined) adapterRange.epochId = range.epochId;
      // `since` in AuditAnchor is typed as string but we try to pass it as a number if possible
      if (range.since !== undefined) {
        const n = Number(range.since);
        if (!isNaN(n)) adapterRange.since = n;
      }
      return adapter.getAnchoredRoots!(corpusId, adapterRange).map((r) => ({
        epochId: r.epochId,
        root: Uint8Array.from(Buffer.from(r.root, "hex")),
        signature: r.signature ? reviveSig(r.signature) : undefined,
        receipt: {
          anchorId: "local",
          epochId: r.epochId,
          guarantee: "detect",
          at: r.at,
        },
      } as AnchoredRoot));
    },
  };
}
