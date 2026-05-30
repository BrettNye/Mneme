import { describe, it, expect } from "vitest";
import { GUARANTEE_RANK } from "./types.js";
describe("guarantee tiers", () => {
  it("ranks external-immutable above detect and witnessed above external-immutable", () => {
    expect(GUARANTEE_RANK["external-immutable"]).toBeGreaterThan(GUARANTEE_RANK.detect);
    expect(GUARANTEE_RANK.witnessed).toBeGreaterThan(GUARANTEE_RANK["external-immutable"]);
  });
});
