import { describe, it, expect } from "vitest";
import { createSqliteAdapter } from "../adapters/sqlite.js";
import { createLocalAnchor } from "./local-anchor.js";
describe("LocalAnchor", () => {
  it("anchors a root and fetches it back, declaring the detect tier", async () => {
    const anchor = createLocalAnchor(createSqliteAdapter(), "c");
    const r = await anchor.anchor({ epochId: "e1", root: new Uint8Array(32).fill(9) });
    expect(r.guarantee).toBe("detect");
    expect((await anchor.fetch({ epochId: "e1" }))[0].root).toEqual(new Uint8Array(32).fill(9));
  });
  it("round-trips an optional signature", async () => {
    const anchor = createLocalAnchor(createSqliteAdapter(), "c");
    await anchor.anchor({ epochId: "e2", root: new Uint8Array(32).fill(1), signature: { alg: "ed25519", bytes: new Uint8Array([1,2,3]), keyRef: "k" } });
    const got = (await anchor.fetch({ epochId: "e2" }))[0];
    expect(got.signature?.bytes).toEqual(new Uint8Array([1,2,3]));
    expect(got.signature?.alg).toBe("ed25519");
  });
  it("scopes roots to the corpus — corpus A roots are not visible to corpus B", async () => {
    const adapter = createSqliteAdapter();
    const anchorA = createLocalAnchor(adapter, "corpusA");
    const anchorB = createLocalAnchor(adapter, "corpusB");
    await anchorA.anchor({ epochId: "e1", root: new Uint8Array(32).fill(0xAA) });
    const results = await anchorB.fetch({ epochId: "e1" });
    expect(results).toHaveLength(0);
  });
});
