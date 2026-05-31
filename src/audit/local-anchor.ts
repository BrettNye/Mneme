import type { AuditAnchor, AnchorReceipt, AnchoredRoot, Signature } from "./types.js";
import type { StorageAdapter } from "../adapters/adapter.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function reviveSig(json: string): Signature {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`reviveSig: failed to parse signature JSON — raw: ${json}`);
  }
  const p = parsed as { alg?: unknown; bytes?: unknown; keyRef?: unknown };
  if (typeof p.bytes !== "string" || typeof p.alg !== "string") {
    throw new Error(
      `reviveSig: signature missing required string fields — raw: ${json}`
    );
  }
  return {
    alg: p.alg,
    bytes: Uint8Array.from(Buffer.from(p.bytes, "hex")),
    ...(typeof p.keyRef === "string" ? { keyRef: p.keyRef } : {}),
  };
}

export function createLocalAnchor(adapter: StorageAdapter, corpusId: string): AuditAnchor {
  if (!adapter.putAnchoredRoot || !adapter.getAnchoredRoots) {
    throw new Error(
      "createLocalAnchor: adapter must implement putAnchoredRoot and getAnchoredRoots"
    );
  }
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
      // `since` in AuditAnchor is typed as string but we pass it as a number to the adapter
      if (range.since !== undefined) {
        const n = Number(range.since);
        if (isNaN(n)) {
          throw new Error("since must be a numeric timestamp string");
        }
        adapterRange.since = n;
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
