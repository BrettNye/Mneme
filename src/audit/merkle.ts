import { createHash } from "node:crypto";
const h = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());
const pair = (a: Uint8Array, b: Uint8Array) => h(Buffer.concat([Buffer.from([0x01]), a, b]));

/** Deterministic Merkle root over leaves (empty -> 32 zero bytes; odd level duplicates last). Domain-separated leaf vs internal. */
export function merkleRoot(leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return new Uint8Array(32);
  let level: Uint8Array<ArrayBuffer>[] = leaves.map((l) => h(Buffer.concat([Buffer.from([0x00]), l])));
  while (level.length > 1) {
    const next: Uint8Array<ArrayBuffer>[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(pair(level[i], level[i + 1] ?? level[i]));
    level = next;
  }
  return level[0];
}
