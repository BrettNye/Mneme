import { describe, it, expect } from "vitest";
import * as audit from "./index.js";
describe("audit barrel", () => {
  it("exposes the core audit surface (no AWS)", () => {
    for (const k of ["verifyChain","anchorEpoch","auditReport","merkleRoot","NoneSigner","createLocalSigner","createLocalAnchor","GUARANTEE_RANK"]) {
      expect(audit[k as keyof typeof audit]).toBeDefined();
    }
  });
});
