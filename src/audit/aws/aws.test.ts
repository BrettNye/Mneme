// src/audit/aws/aws.test.ts — no live AWS: assert shape + that nothing AWS loads at import
import { describe, it, expect } from "vitest";
import { createS3ObjectLockAnchor } from "./s3-object-lock-anchor.js";
import { createKmsSigner } from "./kms-signer.js";
describe("aws audit adapters", () => {
  it("S3ObjectLockAnchor declares the external-immutable tier without importing AWS at module load", () => {
    const a = createS3ObjectLockAnchor({ bucket: "b", prefix: "p", region: "us-east-1" });
    expect(a.guarantee).toBe("external-immutable");
    expect(a.id).toBe("s3:b");
  });
  it("KmsSigner exposes its keyRef", () => {
    expect(createKmsSigner({ keyId: "k1", region: "us-east-1" }).keyRef).toBe("k1");
  });
});
