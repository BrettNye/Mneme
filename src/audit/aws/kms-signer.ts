import type { Signer, Signature } from "../types.js";
export function createKmsSigner(opts: { keyId: string; region: string }): Signer {
  return {
    keyRef: opts.keyId,
    async sign(root: Uint8Array): Promise<Signature> {
      const { KMSClient, SignCommand } = (await import("@aws-sdk/client-kms" as string)) as any;
      const kms = new KMSClient({ region: opts.region });
      const out = await kms.send(new SignCommand({ KeyId: opts.keyId, Message: root, MessageType: "RAW", SigningAlgorithm: "ECDSA_SHA_256" }));
      return { alg: "ECDSA_SHA_256", bytes: new Uint8Array(out.Signature), keyRef: opts.keyId };
    },
  };
}
