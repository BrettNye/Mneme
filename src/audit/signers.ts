import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import type { Signer, Signature } from "./types.js";

export const NoneSigner: Signer = { async sign() { return { alg: "none", bytes: new Uint8Array(0) }; } };

/** ed25519 local signer — non-repudiation only as strong as local key custody (detect tier). */
export function createLocalSigner(keyRef = "local"): Signer & { publicKey: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    keyRef,
    publicKey: publicKey.export({ type: "spki", format: "der" }) as Buffer,
    async sign(root: Uint8Array): Promise<Signature> {
      return { alg: "ed25519", bytes: new Uint8Array(nodeSign(null, Buffer.from(root), privateKey)), keyRef };
    },
  };
}
