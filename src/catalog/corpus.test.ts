import type { DecayPolicy, ContradictionPolicy, Corpus, CorpusDefaults } from "./corpus.js";

// Exhaustiveness helper for DecayPolicy
function assertDecayPolicyExhaustive(p: DecayPolicy): string {
  switch (p.kind) {
    case "none":
      return "none";
    case "exponential":
      return `exponential:${p.halfLifeDays}`;
    case "linear":
      return `linear:${p.ratePerDay}`;
    case "step":
      return `step:${p.thresholdDays}`;
    default: {
      const _exhaustive: never = p;
      return _exhaustive;
    }
  }
}

// Exhaustiveness helper for ContradictionPolicy
function assertContradictionPolicyExhaustive(p: ContradictionPolicy): string {
  switch (p.kind) {
    case "always_accept":
      return "always_accept";
    case "reject_on_contradiction":
      return "reject_on_contradiction";
    case "accept_but_mark":
      return "accept_but_mark";
    case "accept_and_resolve":
      return `accept_and_resolve:${p.rule}`;
    default: {
      const _exhaustive: never = p;
      return _exhaustive;
    }
  }
}

it("decay policy descriptors are a closed union", () => {
  const p: DecayPolicy = { kind: "exponential", halfLifeDays: 30 };
  expect(p.kind).toBe("exponential");
  expect(assertDecayPolicyExhaustive(p)).toBe("exponential:30");
});

it("decay policy none variant works", () => {
  const p: DecayPolicy = { kind: "none" };
  expect(assertDecayPolicyExhaustive(p)).toBe("none");
});

it("decay policy linear variant works", () => {
  const p: DecayPolicy = { kind: "linear", ratePerDay: 0.01 };
  expect(assertDecayPolicyExhaustive(p)).toBe("linear:0.01");
});

it("decay policy step variant works", () => {
  const p: DecayPolicy = { kind: "step", thresholdDays: 90 };
  expect(assertDecayPolicyExhaustive(p)).toBe("step:90");
});

it("contradiction policy always_accept variant works", () => {
  const p: ContradictionPolicy = { kind: "always_accept" };
  expect(assertContradictionPolicyExhaustive(p)).toBe("always_accept");
});

it("contradiction policy reject_on_contradiction variant works", () => {
  const p: ContradictionPolicy = { kind: "reject_on_contradiction" };
  expect(assertContradictionPolicyExhaustive(p)).toBe("reject_on_contradiction");
});

it("contradiction policy accept_but_mark variant works", () => {
  const p: ContradictionPolicy = { kind: "accept_but_mark" };
  expect(assertContradictionPolicyExhaustive(p)).toBe("accept_but_mark");
});

it("contradiction policy accept_and_resolve variant works with deprecate_lower rule", () => {
  const p: ContradictionPolicy = { kind: "accept_and_resolve", rule: "deprecate_lower" };
  expect(assertContradictionPolicyExhaustive(p)).toBe("accept_and_resolve:deprecate_lower");
});

it("contradiction policy accept_and_resolve variant works with keep_newer rule", () => {
  const p: ContradictionPolicy = { kind: "accept_and_resolve", rule: "keep_newer" };
  expect(assertContradictionPolicyExhaustive(p)).toBe("accept_and_resolve:keep_newer");
});

it("CorpusDefaults shape is correct", () => {
  const defaults: CorpusDefaults = {
    decayPolicy: { kind: "none" },
    confidenceThreshold: 0.7,
    contradictionPolicy: { kind: "always_accept" },
    defaultStatus: ["provisional", "validated"],
  };
  expect(defaults.confidenceThreshold).toBe(0.7);
  expect(defaults.decayPolicy.kind).toBe("none");
  expect(defaults.contradictionPolicy.kind).toBe("always_accept");
  expect(defaults.defaultStatus).toHaveLength(2);
});

it("Corpus shape is correct", () => {
  const corpus: Corpus = {
    id: "test-corpus",
    displayName: "Test Corpus",
    schema: {
      version: "1.0",
      subjects: ["person"],
      scopeFields: { lang: "string" },
      required: ["lang"],
      scalarPseudocount: { manual: 1 },
    },
    defaults: {
      decayPolicy: { kind: "exponential", halfLifeDays: 180 },
      confidenceThreshold: 0.5,
      contradictionPolicy: { kind: "reject_on_contradiction" },
      defaultStatus: ["candidate"],
    },
    requiredTiers: [{ kind: "core" }],
    metadata: { description: "A test corpus" },
    createdAt: 1000000,
    updatedAt: 1000001,
  };
  expect(corpus.id).toBe("test-corpus");
  expect(corpus.requiredTiers).toHaveLength(1);
  expect(corpus.metadata["description"]).toBe("A test corpus");
});
