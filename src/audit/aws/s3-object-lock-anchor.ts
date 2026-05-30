import type { AuditAnchor, AnchorReceipt, AnchoredRoot } from "../types.js";
export function createS3ObjectLockAnchor(opts: { bucket: string; prefix: string; region: string }): AuditAnchor {
  return {
    id: `s3:${opts.bucket}`,
    guarantee: "external-immutable",
    async anchor({ epochId, root, signature }) {
      // dynamic + TYPE-ERASED specifier (`as string`) so core tsc builds without the SDK installed:
      const { S3Client, PutObjectCommand } = (await import("@aws-sdk/client-s3" as string)) as any;
      const s3 = new S3Client({ region: opts.region });
      const key = `${opts.prefix}/${epochId}.json`;
      await s3.send(new PutObjectCommand({ Bucket: opts.bucket, Key: key,
        Body: JSON.stringify({ epochId, root: Buffer.from(root).toString("hex"), signature }),
        ObjectLockMode: "COMPLIANCE" }));
      const receipt: AnchorReceipt = { anchorId: `s3:${opts.bucket}`, epochId, guarantee: "external-immutable", at: Date.now(), locator: `s3://${opts.bucket}/${key}` };
      return receipt;
    },
    async fetch(): Promise<AnchoredRoot[]> { return []; }, // GetObject by epoch/prefix is the inverse; stub for now
  };
}
