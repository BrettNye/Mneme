import { matches, type Predicate } from "./predicate.js";
import type { Claim } from "../core/claim.js";

// Helper to build minimal claim-like objects
function makeClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: "id-1" as any,
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
    audience: {},
    tags: ["important", "verified"],
    schema: "default",
    ...overrides,
  };
}

// ── subjectEq ──────────────────────────────────────────────────────────────
it("subjectEq matches when subject equals value", () => {
  const claim = makeClaim({ subject: "alice" });
  expect(matches(claim, { op: "subjectEq", value: "alice" })).toBe(true);
});

it("subjectEq does not match when subject differs", () => {
  const claim = makeClaim({ subject: "bob" });
  expect(matches(claim, { op: "subjectEq", value: "alice" })).toBe(false);
});

// ── subjectIn ─────────────────────────────────────────────────────────────
it("subjectIn matches when subject is in values list", () => {
  const claim = makeClaim({ subject: "alice" });
  expect(matches(claim, { op: "subjectIn", values: ["alice", "bob"] })).toBe(true);
});

it("subjectIn does not match when subject is not in list", () => {
  const claim = makeClaim({ subject: "carol" });
  expect(matches(claim, { op: "subjectIn", values: ["alice", "bob"] })).toBe(false);
});

// ── keyEq ─────────────────────────────────────────────────────────────────
it("keyEq matches when key equals value", () => {
  const claim = makeClaim({ key: "email" as any });
  expect(matches(claim, { op: "keyEq", value: "email" })).toBe(true);
});

it("keyEq does not match when key differs", () => {
  const claim = makeClaim({ key: "phone" as any });
  expect(matches(claim, { op: "keyEq", value: "email" })).toBe(false);
});

// ── scopeEq ───────────────────────────────────────────────────────────────
it("scopeEq matches when scope field equals value", () => {
  const claim = makeClaim({ scope: { lang: "en" } });
  expect(matches(claim, { op: "scopeEq", field: "lang", value: "en" })).toBe(true);
});

it("scopeEq does not match when scope field has different value", () => {
  const claim = makeClaim({ scope: { lang: "fr" } });
  expect(matches(claim, { op: "scopeEq", field: "lang", value: "en" })).toBe(false);
});

it("scopeEq does not match when scope field is absent", () => {
  const claim = makeClaim({ scope: {} });
  expect(matches(claim, { op: "scopeEq", field: "lang", value: "en" })).toBe(false);
});

// ── statusEq ──────────────────────────────────────────────────────────────
it("statusEq matches validated claim", () => {
  const claim = makeClaim({ status: "validated" });
  expect(matches(claim, { op: "statusEq", value: "validated" })).toBe(true);
});

it("statusEq does not match different status", () => {
  const claim = makeClaim({ status: "deprecated" });
  expect(matches(claim, { op: "statusEq", value: "validated" })).toBe(false);
});

// ── statusIn ──────────────────────────────────────────────────────────────
it("statusIn matches when status is in list", () => {
  const claim = makeClaim({ status: "provisional" });
  expect(matches(claim, { op: "statusIn", values: ["provisional", "validated"] })).toBe(true);
});

it("statusIn does not match when status is not in list", () => {
  const claim = makeClaim({ status: "deprecated" });
  expect(matches(claim, { op: "statusIn", values: ["provisional", "validated"] })).toBe(false);
});

// ── confidenceGt ──────────────────────────────────────────────────────────
it("confidenceGt returns true when pointEstimate exceeds threshold", () => {
  const claim = makeClaim({
    confidence: { distribution: "beta", parameters: { alpha: 9, beta: 1 }, raw: 0.9 },
  });
  expect(matches(claim, { op: "confidenceGt", value: 0.7 })).toBe(true);
});

it("confidenceGt returns false when pointEstimate is below threshold", () => {
  const claim = makeClaim({
    confidence: { distribution: "beta", parameters: { alpha: 1, beta: 9 }, raw: 0.1 },
  });
  expect(matches(claim, { op: "confidenceGt", value: 0.7 })).toBe(false);
});

it("confidenceGt uses effective when present instead of pointEstimate", () => {
  // pointEstimate would be high (alpha=9) but effective is low
  const claim = makeClaim({
    confidence: { distribution: "beta", parameters: { alpha: 9, beta: 1 }, raw: 0.9, effective: 0.1 },
  });
  expect(matches(claim, { op: "confidenceGt", value: 0.5 })).toBe(false);
});

it("confidenceGt uses effective=0.9 and passes threshold 0.7", () => {
  // pointEstimate would be low (alpha=1) but effective is high
  const claim = makeClaim({
    confidence: { distribution: "beta", parameters: { alpha: 1, beta: 9 }, raw: 0.1, effective: 0.9 },
  });
  expect(matches(claim, { op: "confidenceGt", value: 0.7 })).toBe(true);
});

// ── tagIn ─────────────────────────────────────────────────────────────────
it("tagIn matches when any tag in claim overlaps with values", () => {
  const claim = makeClaim({ tags: ["important", "verified"] });
  expect(matches(claim, { op: "tagIn", values: ["verified", "flagged"] })).toBe(true);
});

it("tagIn does not match when no tags overlap", () => {
  const claim = makeClaim({ tags: ["important"] });
  expect(matches(claim, { op: "tagIn", values: ["flagged", "urgent"] })).toBe(false);
});

it("tagIn returns false for empty tags list on claim", () => {
  const claim = makeClaim({ tags: [] });
  expect(matches(claim, { op: "tagIn", values: ["verified"] })).toBe(false);
});

// ── validAt ───────────────────────────────────────────────────────────────
it("validAt matches when t is inside the valid interval", () => {
  const claim = makeClaim({ valid: { from: 1000, to: 2000 } });
  expect(matches(claim, { op: "validAt", t: 1500 })).toBe(true);
});

it("validAt does not match when t is before the interval", () => {
  const claim = makeClaim({ valid: { from: 1000, to: 2000 } });
  expect(matches(claim, { op: "validAt", t: 999 })).toBe(false);
});

it("validAt does not match when t equals to (half-open interval)", () => {
  const claim = makeClaim({ valid: { from: 1000, to: 2000 } });
  expect(matches(claim, { op: "validAt", t: 2000 })).toBe(false);
});

// ── recordedAfter ─────────────────────────────────────────────────────────
it("recordedAfter matches when recorded > t", () => {
  const claim = makeClaim({ recorded: 600 });
  expect(matches(claim, { op: "recordedAfter", t: 500 })).toBe(true);
});

it("recordedAfter does not match when recorded equals t (strict greater than)", () => {
  const claim = makeClaim({ recorded: 500 });
  expect(matches(claim, { op: "recordedAfter", t: 500 })).toBe(false);
});

it("recordedAfter does not match when recorded < t", () => {
  const claim = makeClaim({ recorded: 400 });
  expect(matches(claim, { op: "recordedAfter", t: 500 })).toBe(false);
});

// ── and ───────────────────────────────────────────────────────────────────
it("and returns true when all predicates match", () => {
  const claim = makeClaim({ subject: "alice", status: "validated" });
  const p: Predicate = {
    op: "and",
    preds: [
      { op: "subjectEq", value: "alice" },
      { op: "statusEq", value: "validated" },
    ],
  };
  expect(matches(claim, p)).toBe(true);
});

it("and returns false when any predicate fails", () => {
  const claim = makeClaim({ subject: "alice", status: "deprecated" });
  const p: Predicate = {
    op: "and",
    preds: [
      { op: "subjectEq", value: "alice" },
      { op: "statusEq", value: "validated" },
    ],
  };
  expect(matches(claim, p)).toBe(false);
});

it("and with empty preds returns true (vacuous truth)", () => {
  const claim = makeClaim();
  expect(matches(claim, { op: "and", preds: [] })).toBe(true);
});

// ── or ────────────────────────────────────────────────────────────────────
it("or returns true when at least one predicate matches", () => {
  const claim = makeClaim({ subject: "alice", status: "deprecated" });
  const p: Predicate = {
    op: "or",
    preds: [
      { op: "subjectEq", value: "alice" },
      { op: "statusEq", value: "validated" },
    ],
  };
  expect(matches(claim, p)).toBe(true);
});

it("or returns false when no predicate matches", () => {
  const claim = makeClaim({ subject: "carol", status: "deprecated" });
  const p: Predicate = {
    op: "or",
    preds: [
      { op: "subjectEq", value: "alice" },
      { op: "statusEq", value: "validated" },
    ],
  };
  expect(matches(claim, p)).toBe(false);
});

it("or with empty preds returns false (vacuous falsity)", () => {
  const claim = makeClaim();
  expect(matches(claim, { op: "or", preds: [] })).toBe(false);
});

// ── not ───────────────────────────────────────────────────────────────────
it("not inverts a matching predicate to false", () => {
  const claim = makeClaim({ subject: "alice" });
  expect(matches(claim, { op: "not", pred: { op: "subjectEq", value: "alice" } })).toBe(false);
});

it("not inverts a non-matching predicate to true", () => {
  const claim = makeClaim({ subject: "bob" });
  expect(matches(claim, { op: "not", pred: { op: "subjectEq", value: "alice" } })).toBe(true);
});

// ── compound nesting ──────────────────────────────────────────────────────
it("nested compound: not(and([subjectEq, statusEq])) works", () => {
  const claim = makeClaim({ subject: "alice", status: "validated" });
  const p: Predicate = {
    op: "not",
    pred: {
      op: "and",
      preds: [
        { op: "subjectEq", value: "alice" },
        { op: "statusEq", value: "validated" },
      ],
    },
  };
  // alice + validated → and is true → not(true) = false
  expect(matches(claim, p)).toBe(false);
});

it("nested compound: or([not(subjectEq), statusEq]) is true when status matches", () => {
  const claim = makeClaim({ subject: "bob", status: "validated" });
  const p: Predicate = {
    op: "or",
    preds: [
      { op: "not", pred: { op: "subjectEq", value: "alice" } }, // bob != alice → true
      { op: "statusEq", value: "validated" },
    ],
  };
  expect(matches(claim, p)).toBe(true);
});
