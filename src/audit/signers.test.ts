import { describe, it, expect } from "vitest";
import { verify as nodeVerify, createPublicKey } from "node:crypto";
import { createLocalSigner, NoneSigner } from "./signers.js";
describe("signers", () => {
  it("LocalSigner produces a verifiable ed25519 signature", async () => {
    const s = createLocalSigner(); const root = new Uint8Array(32).fill(7);
    const sig = await s.sign(root);
    const pub = createPublicKey({ key: Buffer.from(s.publicKey), type: "spki", format: "der" });
    expect(nodeVerify(null, Buffer.from(root), pub, Buffer.from(sig.bytes))).toBe(true);
  });
  it("NoneSigner returns an empty signature", async () => {
    expect((await NoneSigner.sign(new Uint8Array(32))).alg).toBe("none");
  });
});
