import { sigma } from "./selection.js";
import { corpusOf } from "./types.js";
import type { Claim } from "../core/claim.js";

let _claimCounter = 0;
function makeClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: `id-${++_claimCounter}` as any,
    profile: "profile-1" as any,
    workspace: "ws-1" as any,
    subject: "alice",
    key: "email" as any,
    scope: {},
    scopeHash: "_",
    value: { type: "string", v: "alice@example.com" } as any,
    valueHash: "vh",
    confidence: { distribution: "beta", parameters: { alpha: 9, beta: 1 }, raw: 0.9 },
    valid: { from: 1000, to: 2000 },
    recorded: 500,
    recordedSeq: 1,
    status: "validated",
    source: "manual",
    provenance: {} as any,
    evidence: [],
    tags: ["important"],
    schema: "default",
    ...overrides,
  };
}

// ── from the task spec ─────────────────────────────────────────────────────
it("confidenceGt reads effective when present", () => {
  const hi = { confidence: { distribution: "beta", parameters: { alpha: 9, beta: 1 }, raw: 0.9, effective: 0.9 } } as any;
  const lo = { confidence: { distribution: "beta", parameters: { alpha: 1, beta: 9 }, raw: 0.1, effective: 0.1 } } as any;
  expect(sigma({ op: "confidenceGt", value: 0.7 })(corpusOf([hi, lo])).claims).toHaveLength(1);
});

// ── basic filtering ────────────────────────────────────────────────────────
it("sigma filters corpus to matching claims only", () => {
  const alice = makeClaim({ subject: "alice" });
  const bob = makeClaim({ subject: "bob" });
  const corpus = corpusOf([alice, bob]);
  const result = sigma({ op: "subjectEq", value: "alice" })(corpus);
  expect(result.claims).toHaveLength(1);
  expect(result.claims[0].subject).toBe("alice");
});

it("sigma returns empty corpus when no claims match", () => {
  const alice = makeClaim({ subject: "alice" });
  const corpus = corpusOf([alice]);
  const result = sigma({ op: "subjectEq", value: "carol" })(corpus);
  expect(result.claims).toHaveLength(0);
});

it("sigma returns all claims when all match", () => {
  const c1 = makeClaim({ subject: "alice", status: "validated" });
  const c2 = makeClaim({ subject: "bob", status: "validated" });
  const corpus = corpusOf([c1, c2]);
  const result = sigma({ op: "statusEq", value: "validated" })(corpus);
  expect(result.claims).toHaveLength(2);
});

// ── commutativity: σ_p1(σ_p2(C)) = σ_p2(σ_p1(C)) ─────────────────────────
it("sigma is commutative: σ_p1(σ_p2(C)) equals σ_p2(σ_p1(C))", () => {
  const claims = [
    makeClaim({ subject: "alice", status: "validated", tags: ["important"] }),
    makeClaim({ subject: "alice", status: "deprecated", tags: ["important"] }),
    makeClaim({ subject: "bob", status: "validated", tags: [] }),
    makeClaim({ subject: "carol", status: "deprecated", tags: ["important"] }),
  ];
  const corpus = corpusOf(claims);

  const p1 = { op: "subjectEq" as const, value: "alice" };
  const p2 = { op: "statusEq" as const, value: "validated" };

  const left = sigma(p1)(sigma(p2)(corpus));
  const right = sigma(p2)(sigma(p1)(corpus));

  expect(left.claims).toHaveLength(right.claims.length);
  // Same claim ids in result (airtight equivalence)
  const leftIds = [...left.claims].map(c => c.id).sort();
  const rightIds = [...right.claims].map(c => c.id).sort();
  expect(leftIds).toEqual(rightIds);
});

it("sigma commutativity with tagIn and recordedAfter", () => {
  const claims = [
    makeClaim({ tags: ["urgent"], recorded: 600 }),
    makeClaim({ tags: ["urgent"], recorded: 400 }),
    makeClaim({ tags: [], recorded: 600 }),
    makeClaim({ tags: [], recorded: 400 }),
  ];
  const corpus = corpusOf(claims);

  const pTag = { op: "tagIn" as const, values: ["urgent"] };
  const pRec = { op: "recordedAfter" as const, t: 500 };

  const left = sigma(pTag)(sigma(pRec)(corpus));
  const right = sigma(pRec)(sigma(pTag)(corpus));

  expect(left.claims).toHaveLength(right.claims.length);
  expect(left.claims).toHaveLength(1); // only urgent + recorded > 500
  // Same claim ids (airtight equivalence)
  const leftIds = [...left.claims].map(c => c.id).sort();
  const rightIds = [...right.claims].map(c => c.id).sort();
  expect(leftIds).toEqual(rightIds);
});

// ── composed sigma equals single and predicate ─────────────────────────────
it("σ_p1(σ_p2(C)) equals σ_{p1 ∧ p2}(C)", () => {
  const claims = [
    makeClaim({ subject: "alice", status: "validated" }),
    makeClaim({ subject: "alice", status: "deprecated" }),
    makeClaim({ subject: "bob", status: "validated" }),
  ];
  const corpus = corpusOf(claims);

  const p1 = { op: "subjectEq" as const, value: "alice" };
  const p2 = { op: "statusEq" as const, value: "validated" };
  const pAnd = { op: "and" as const, preds: [p1, p2] };

  const composed = sigma(p1)(sigma(p2)(corpus));
  const single = sigma(pAnd)(corpus);

  expect(composed.claims).toHaveLength(single.claims.length);
  expect(composed.claims).toHaveLength(1);
  // Same claim id (airtight equivalence)
  expect(composed.claims[0].id).toBe(single.claims[0].id);
});

// ── result corpus is still frozen/immutable ────────────────────────────────
it("sigma result corpus claims are frozen", () => {
  const corpus = corpusOf([makeClaim()]);
  const result = sigma({ op: "subjectEq", value: "alice" })(corpus);
  expect(Object.isFrozen(result.claims)).toBe(true);
});
