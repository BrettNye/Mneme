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
  it("round-trips an optional signature including keyRef", async () => {
    const anchor = createLocalAnchor(createSqliteAdapter(), "c");
    await anchor.anchor({ epochId: "e2", root: new Uint8Array(32).fill(1), signature: { alg: "ed25519", bytes: new Uint8Array([1,2,3]), keyRef: "k" } });
    const got = (await anchor.fetch({ epochId: "e2" }))[0];
    expect(got.signature?.bytes).toEqual(new Uint8Array([1,2,3]));
    expect(got.signature?.alg).toBe("ed25519");
    expect(got.signature?.keyRef).toBe("k");
  });
  it("scopes roots to the corpus — corpus A roots are not visible to corpus B", async () => {
    const adapter = createSqliteAdapter();
    const anchorA = createLocalAnchor(adapter, "corpusA");
    const anchorB = createLocalAnchor(adapter, "corpusB");
    await anchorA.anchor({ epochId: "e1", root: new Uint8Array(32).fill(0xAA) });
    const results = await anchorB.fetch({ epochId: "e1" });
    expect(results).toHaveLength(0);
  });
  it("throws a descriptive error when adapter is missing anchor methods", () => {
    expect(() => createLocalAnchor({} as any, "c")).toThrow(
      "createLocalAnchor: adapter must implement putAnchoredRoot and getAnchoredRoots"
    );
  });
  it("throws a descriptive error when reviveSig receives malformed JSON", async () => {
    const adapter = createSqliteAdapter();
    const anchor = createLocalAnchor(adapter, "c");
    // Manually insert a row with malformed signature JSON via the adapter
    adapter.putAnchoredRoot!({
      corpusId: "c",
      epochId: "bad-sig",
      root: Buffer.from(new Uint8Array(32)).toString("hex"),
      signature: "{not valid json",
      guarantee: "detect",
      at: Date.now(),
    });
    await expect(anchor.fetch({ epochId: "bad-sig" })).rejects.toThrow(
      "reviveSig: failed to parse signature JSON"
    );
  });
  it("throws a descriptive error when reviveSig bytes field is not a string", async () => {
    const adapter = createSqliteAdapter();
    const anchor = createLocalAnchor(adapter, "c");
    adapter.putAnchoredRoot!({
      corpusId: "c",
      epochId: "bad-bytes",
      root: Buffer.from(new Uint8Array(32)).toString("hex"),
      signature: JSON.stringify({ alg: "ed25519", bytes: 12345 }),
      guarantee: "detect",
      at: Date.now(),
    });
    await expect(anchor.fetch({ epochId: "bad-bytes" })).rejects.toThrow(
      "reviveSig: signature missing required string fields"
    );
  });
  it("throws when since is a non-numeric string", async () => {
    const anchor = createLocalAnchor(createSqliteAdapter(), "c");
    await expect(anchor.fetch({ since: "not-a-number" })).rejects.toThrow(
      "since must be a numeric timestamp string"
    );
  });
});
