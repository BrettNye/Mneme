import type { Signer, Signature } from "../types.js";
/**
 * Creates a KMS-backed signer.
 *
 * The `sign` method expects a 32-byte SHA-256 digest (e.g. the Merkle root).
 * It passes `MessageType: "DIGEST"` so KMS signs the digest directly without
 * hashing again (avoiding the double-hash bug that `"RAW"` with ECDSA_SHA_256
 * would produce).
 */
export function createKmsSigner(opts: { keyId: string; region: string }): Signer {
  return {
    keyRef: opts.keyId,
    async sign(root: Uint8Array): Promise<Signature> {
      const { KMSClient, SignCommand } = (await import("@aws-sdk/client-kms" as string)) as any;
      const kms = new KMSClient({ region: opts.region });
      const out = await kms.send(new SignCommand({ KeyId: opts.keyId, Message: root, MessageType: "DIGEST", SigningAlgorithm: "ECDSA_SHA_256" }));
      if (!out.Signature) throw new Error(`KMS SignCommand returned no Signature for key ${opts.keyId}`);
      return { alg: "ECDSA_SHA_256", bytes: new Uint8Array(out.Signature), keyRef: opts.keyId };
    },
  };
}
