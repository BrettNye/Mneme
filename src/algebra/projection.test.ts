import { pi } from "./projection.js";
import { corpusOf } from "./types.js";

const sampleClaim = {
  id: "c1" as any,
  profile: "p1" as any,
  workspace: "w1" as any,
  subject: "a",
  key: "a.b" as any,
  scope: {} as any,
  scopeHash: "sh",
  value: 1 as any,
  valueHash: "vh",
  confidence: 1 as any,
  valid: {} as any,
  recorded: 0 as any,
  recordedSeq: 0,
  status: "candidate" as any,
  source: "manual" as any,
  provenance: {} as any,
  evidence: [],
  audience: {},
  tags: [],
  schema: "s",
};

it("projection keeps only the named fields", () => {
  const c = corpusOf([sampleClaim]);
  const result = pi(["subject", "key"])(c);
  expect(result.claims).toHaveLength(1);
  const cl = result.claims[0];
  expect(cl.subject).toBe("a");
  expect(cl.key).toBe("a.b");
  // fields not in the projection should be undefined
  expect((cl as any).id).toBeUndefined();
  expect((cl as any).value).toBeUndefined();
});

it("projection is idempotent over the same field set", () => {
  const c = corpusOf([sampleClaim]);
  const once = pi(["subject", "key"])(c);
  expect(pi(["subject", "key"])(once)).toEqual(once);
});

it("π_f(π_g(C)) = π_{f∩g}(C) when f ⊆ g", () => {
  const c = corpusOf([sampleClaim]);
  const g = ["subject", "key", "value"] as any;
  const f = ["subject", "key"] as any;

  const composed = pi(f)(pi(g)(c));
  const intersection = pi(f)(c); // f ∩ g = f since f ⊆ g

  expect(composed).toEqual(intersection);
});
