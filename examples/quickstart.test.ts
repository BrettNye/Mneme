import { runQuickstart } from "./quickstart.js";

it("quickstart runs end-to-end on the public surface", () => {
  const r = runQuickstart();

  // step 2: a claim was committed
  expect(typeof r.committedId).toBe("string");
  expect(r.committedId.length).toBeGreaterThan(0);

  // step 3: the composed context contains the claim value
  expect(r.contextIncludesValue).toBe(true);

  // step 4: contradiction resolved via supersede
  expect(r.supersededOldStatus).toBe("deprecated");
  expect(r.replacementValue).toBe("degraded");

  // step 5: decay lowered effective confidence below raw
  expect(r.effectiveAfterDecay).toBeLessThan(r.rawConfidence);

  // step 6: replay of a plain (non-derived) claim
  expect(r.replayStatusOfPlainClaim).toBe("integrity_unknown");
});
