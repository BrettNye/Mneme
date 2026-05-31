import { describe, it, expect } from "vitest";
import { merkleRoot } from "./merkle.js";
describe("merkleRoot", () => {
  it("is deterministic, order-sensitive, and empty -> 32 zero bytes", () => {
    const a = new Uint8Array([1]), b = new Uint8Array([2]);
    expect(merkleRoot([a, b])).toEqual(merkleRoot([a, b]));
    expect(merkleRoot([a, b])).not.toEqual(merkleRoot([b, a]));
    expect(merkleRoot([])).toEqual(new Uint8Array(32));
  });
  it("distinguishes leaf-set membership", () => {
    expect(merkleRoot([new Uint8Array([1])])).not.toEqual(merkleRoot([new Uint8Array([2])]));
  });
  it("detects an appended duplicate leaf (no odd-node collapse)", () => {
    const a = new Uint8Array([1]);
    expect(merkleRoot([a, a, a])).not.toEqual(merkleRoot([a, a]));
  });
  it("domain-separates leaves from internal nodes", () => {
    const ab = new Uint8Array([0xab]);
    expect(merkleRoot([ab, ab])).not.toEqual(merkleRoot([merkleRoot([ab])]));
  });
});
