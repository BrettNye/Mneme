import { createHash } from "node:crypto";

function h(b: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(b).digest());
}

function pair(a: Uint8Array, b: Uint8Array): Uint8Array {
  return h(Buffer.concat([Buffer.from([0x01]), a, b]));
}

/** Deterministic Merkle root over leaves (empty -> 32 zero bytes; odd node promoted without hashing). Domain-separated leaf vs internal. */
export function merkleRoot(leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return new Uint8Array(32);
  let level: Uint8Array[] = leaves.map((l) => h(Buffer.concat([Buffer.from([0x00]), l])));
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? pair(level[i], level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0];
}
