import {
  alphaCount,
  alphaCountWhere,
  alphaSum,
  alphaAvg,
  alphaMin,
  alphaMax,
  alphaRate,
  alphaBinaryRate,
  alphaGroupBy,
  binaryRateCore,
  rateCore,
  countCore,
  sumCore,
  claimPath,
  type AggregateResult,
  type GroupKey,
  type AggValue,
} from "./aggregation.js";
import { corpusOf, filterCorpus } from "./types.js";
import type { Claim } from "../core/claim.js";
import type { Predicate } from "./predicate.js";

// ---------------------------------------------------------------------------
// Test helpers: minimal Claim stubs for testing
// ---------------------------------------------------------------------------

const makeClaim = (
  overrides: {
    scope?: Record<string, string | undefined>;
    value?: unknown;
    subject?: string;
    key?: string;
    status?: string;
    tags?: string[];
  }
): Claim =>
  ({
    id: "cl-1" as any,
    profile: "p-1" as any,
    workspace: "w-1" as any,
    subject: overrides.subject ?? "test",
    key: overrides.key ?? "test.key",
    scope: overrides.scope ?? {},
    scopeHash: "",
    value: overrides.value !== undefined ? overrides.value : null,
    valueHash: "",
    confidence: { distribution: "scalar", parameters: { p: 0.9 }, raw: 0.9 },
    valid: { from: 0, to: Infinity },
    recorded: 0,
    recordedSeq: 0,
    status: overrides.status ?? "validated",
    source: "manual",
    provenance: { method: "manual" } as any,
    evidence: [],
    tags: overrides.tags ?? [],
    schema: "test",
  } as Claim);

const oc = (actionId: string, won: boolean) =>
  makeClaim({
    scope: { actionId },
    value: { won },
    subject: "action",
    key: "action.outcome",
  });

// ---------------------------------------------------------------------------
// claimPath resolver
// ---------------------------------------------------------------------------

describe("claimPath", () => {
  const claim = makeClaim({
    scope: { actionId: "A1", region: "EU" },
    value: { nested: { deep: 42 }, arr: [10, 20] },
    subject: "mySubject",
    key: "my.key",
  });

  it("resolves scope.<field>", () => {
    expect(claimPath(claim, "scope.actionId")).toBe("A1");
    expect(claimPath(claim, "scope.region")).toBe("EU");
  });

  it("resolves 'value' to the full value", () => {
    expect(claimPath(claim, "value")).toEqual({ nested: { deep: 42 }, arr: [10, 20] });
  });

  it("resolves value.<dotted-path> via getPath", () => {
    expect(claimPath(claim, "value.nested.deep")).toBe(42);
  });

  it("resolves bare top-level claim fields", () => {
    expect(claimPath(claim, "subject")).toBe("mySubject");
    expect(claimPath(claim, "key")).toBe("my.key");
  });
});

// ---------------------------------------------------------------------------
// countCore
// ---------------------------------------------------------------------------

describe("countCore", () => {
  it("returns count of claims", () => {
    const claims = [makeClaim({}), makeClaim({}), makeClaim({})];
    expect(countCore(claims)).toEqual({ kind: "count", n: 3 });
  });

  it("returns 0 for empty array", () => {
    expect(countCore([])).toEqual({ kind: "count", n: 0 });
  });
});

// ---------------------------------------------------------------------------
// sumCore
// ---------------------------------------------------------------------------

describe("sumCore", () => {
  it("sums numeric values at the given path", () => {
    const claims = [
      makeClaim({ value: { amount: 10 } }),
      makeClaim({ value: { amount: 20 } }),
      makeClaim({ value: { amount: 30 } }),
    ];
    const result = sumCore("value.amount")(claims);
    expect(result).toEqual({ kind: "sum", value: 60 });
  });

  it("treats missing values as 0", () => {
    const claims = [makeClaim({ value: { amount: 5 } }), makeClaim({ value: {} })];
    const result = sumCore("value.amount")(claims);
    expect(result).toEqual({ kind: "sum", value: 5 });
  });
});

// ---------------------------------------------------------------------------
// alphaCount
// ---------------------------------------------------------------------------

describe("alphaCount", () => {
  it("counts all claims in corpus, emitting single GroupKey.none group", () => {
    const corpus = corpusOf([makeClaim({}), makeClaim({}), makeClaim({})]);
    const result = alphaCount(corpus);
    expect(result.groups.size).toBe(1);
    const group = result.groups.get("__none__")!;
    expect(group.key).toEqual({ kind: "none" });
    expect(group.value).toEqual({ kind: "count", n: 3 });
  });
});

// ---------------------------------------------------------------------------
// alphaCountWhere and §4.13 law: α_count(σ_p(C)) = α_count_where<p>(C)
// ---------------------------------------------------------------------------

describe("alphaCountWhere", () => {
  const subjectPred: Predicate = { op: "subjectEq", value: "action" };
  const claims = [
    makeClaim({ subject: "action" }),
    makeClaim({ subject: "action" }),
    makeClaim({ subject: "other" }),
  ];

  it("counts only claims matching predicate", () => {
    const corpus = corpusOf(claims);
    const result = alphaCountWhere(subjectPred)(corpus);
    const group = result.groups.get("__none__")!;
    expect(group.key).toEqual({ kind: "none" });
    expect(group.value).toEqual({ kind: "count", n: 2 });
  });

  it("§4.13 law: α_count(σ_p(C)) === α_count_where<p>(C)", () => {
    const corpus = corpusOf(claims);
    // α_count on filtered corpus
    const filteredResult = alphaCount(filterCorpus(corpus, (cl) => cl.subject === "action"));
    // α_count_where on full corpus
    const whereResult = alphaCountWhere(subjectPred)(corpus);
    const filteredCount = filteredResult.groups.get("__none__")!.value;
    const whereCount = whereResult.groups.get("__none__")!.value;
    expect(filteredCount).toEqual(whereCount);
  });
});

// ---------------------------------------------------------------------------
// alphaSum
// ---------------------------------------------------------------------------

describe("alphaSum", () => {
  it("sums numeric values at path in GroupKey.none group", () => {
    const corpus = corpusOf([
      makeClaim({ value: { score: 5 } }),
      makeClaim({ value: { score: 15 } }),
    ]);
    const result = alphaSum("value.score")(corpus);
    const group = result.groups.get("__none__")!;
    expect(group.key).toEqual({ kind: "none" });
    expect(group.value).toEqual({ kind: "sum", value: 20 });
  });
});

// ---------------------------------------------------------------------------
// alphaAvg
// ---------------------------------------------------------------------------

describe("alphaAvg", () => {
  it("computes average of numeric values", () => {
    const corpus = corpusOf([
      makeClaim({ value: { score: 10 } }),
      makeClaim({ value: { score: 20 } }),
      makeClaim({ value: { score: 30 } }),
    ]);
    const result = alphaAvg("value.score")(corpus);
    const group = result.groups.get("__none__")!;
    expect(group.key).toEqual({ kind: "none" });
    expect(group.value).toEqual({ kind: "avg", value: 20 });
  });

  it("returns avg 0 for empty corpus", () => {
    const result = alphaAvg("value.score")(corpusOf([]));
    const group = result.groups.get("__none__")!;
    expect(group.value).toEqual({ kind: "avg", value: 0 });
  });
});

// ---------------------------------------------------------------------------
// alphaMin / alphaMax
// ---------------------------------------------------------------------------

describe("alphaMin", () => {
  it("returns min value at path", () => {
    const corpus = corpusOf([
      makeClaim({ value: { score: 10 } }),
      makeClaim({ value: { score: 3 } }),
      makeClaim({ value: { score: 7 } }),
    ]);
    const result = alphaMin("value.score")(corpus);
    const group = result.groups.get("__none__")!;
    expect(group.key).toEqual({ kind: "none" });
    expect(group.value).toEqual({ kind: "min", value: 3 });
  });
});

describe("alphaMax", () => {
  it("returns max value at path", () => {
    const corpus = corpusOf([
      makeClaim({ value: { score: 10 } }),
      makeClaim({ value: { score: 3 } }),
      makeClaim({ value: { score: 7 } }),
    ]);
    const result = alphaMax("value.score")(corpus);
    const group = result.groups.get("__none__")!;
    expect(group.key).toEqual({ kind: "none" });
    expect(group.value).toEqual({ kind: "max", value: 10 });
  });
});

// ---------------------------------------------------------------------------
// rateCore and alphaRate — Beta-typed rate
// ---------------------------------------------------------------------------

describe("rateCore", () => {
  it("emits Beta(alpha=r+aW, beta=s+(1-a)W) with DEFAULT_PRIOR W=2, a=0.5", () => {
    // num: subjectEq "hit"; denom: subjectEq "trial"
    const numPred: Predicate = { op: "subjectEq", value: "hit" };
    const denomPred: Predicate = { op: "subjectEq", value: "trial" };
    // 10 hits, 5 misses (trial but not hit) → r=10, s=5
    const claims = [
      ...Array(10).fill(null).map(() => makeClaim({ subject: "hit" })),
      ...Array(5).fill(null).map(() => makeClaim({ subject: "trial" })),
    ];
    const result = rateCore(numPred, denomPred)(claims);
    expect(result.kind).toBe("rate");
    if (result.kind === "rate") {
      // r=10, s=5, a=0.5, W=2 → alpha=10+0.5*2=11, beta=5+0.5*2=6
      expect(result.beta).toEqual({ alpha: 11, beta: 6 });
    }
  });
});

describe("alphaRate", () => {
  it("wraps rateCore in a GroupKey.none group", () => {
    const numPred: Predicate = { op: "subjectEq", value: "hit" };
    const denomPred: Predicate = { op: "subjectEq", value: "trial" };
    const corpus = corpusOf([
      ...Array(3).fill(null).map(() => makeClaim({ subject: "hit" })),
      ...Array(2).fill(null).map(() => makeClaim({ subject: "trial" })),
    ]);
    const result = alphaRate(numPred, denomPred)(corpus);
    const group = result.groups.get("__none__")!;
    expect(group.key).toEqual({ kind: "none" });
    expect(group.value.kind).toBe("rate");
  });
});

// ---------------------------------------------------------------------------
// binaryRateCore — pinned test from task spec
// ---------------------------------------------------------------------------

describe("binaryRateCore", () => {
  it("emits Beta(23,9) for 22 won / 8 lost (pinned prior W=2, a=0.5)", () => {
    const claims = [
      ...Array(22).fill(null).map(() => oc("A", true)),
      ...Array(8).fill(null).map(() => oc("A", false)),
    ];
    const result = binaryRateCore("value.won")(claims);
    expect(result.kind).toBe("rate");
    if (result.kind === "rate") {
      // r=22 (true), s=8 (false, excluded from num), a=0.5, W=2
      // alpha=22+0.5*2=23, beta=8+0.5*2=9
      expect(result.beta).toEqual({ alpha: 23, beta: 9 });
    }
  });

  it("excludes null/undefined values from both numerator and denominator", () => {
    const claims = [
      oc("A", true),
      oc("A", false),
      makeClaim({ scope: { actionId: "A" }, value: { won: null }, subject: "action", key: "action.outcome" }),
      makeClaim({ scope: { actionId: "A" }, value: {}, subject: "action", key: "action.outcome" }),
    ];
    const result = binaryRateCore("value.won")(claims);
    if (result.kind === "rate") {
      // only true(1) and false(1) count; null/missing excluded
      // r=1, s=1, alpha=1+1=2, beta=1+1=2
      expect(result.beta).toEqual({ alpha: 2, beta: 2 });
    }
  });
});

// ---------------------------------------------------------------------------
// alphaBinaryRate
// ---------------------------------------------------------------------------

describe("alphaBinaryRate", () => {
  it("wraps binaryRateCore in a GroupKey.none group", () => {
    const corpus = corpusOf([oc("A", true), oc("A", false), oc("A", true)]);
    const result = alphaBinaryRate("value.won")(corpus);
    const group = result.groups.get("__none__")!;
    expect(group.key).toEqual({ kind: "none" });
    expect(group.value.kind).toBe("rate");
    if (group.value.kind === "rate") {
      // r=2, s=1, alpha=2+1=3, beta=1+1=2
      expect(group.value.beta).toEqual({ alpha: 3, beta: 2 });
    }
  });
});

// ---------------------------------------------------------------------------
// alphaGroupBy — pinned test from task spec
// ---------------------------------------------------------------------------

describe("alphaGroupBy", () => {
  it("groupBy + binary_rate emits Beta(23,9) for 22 won / 8 lost (pinned prior W=2,a=0.5)", () => {
    const claims = [
      ...Array(22).fill(null).map(() => oc("A", true)),
      ...Array(8).fill(null).map(() => oc("A", false)),
    ];
    const res = alphaGroupBy("scope.actionId", binaryRateCore("value.won"))(corpusOf(claims));
    const g = res.groups.get("A")!.value;
    expect(g.kind).toBe("rate");
    if (g.kind === "rate") expect(g.beta).toEqual({ alpha: 23, beta: 9 });
  });

  it("emits one group per distinct claimPath value", () => {
    const claims = [
      makeClaim({ scope: { region: "EU" }, value: { score: 10 } }),
      makeClaim({ scope: { region: "EU" }, value: { score: 20 } }),
      makeClaim({ scope: { region: "US" }, value: { score: 5 } }),
    ];
    const res = alphaGroupBy("scope.region", sumCore("value.score"))(corpusOf(claims));
    expect(res.groups.size).toBe(2);
    const eu = res.groups.get("EU")!;
    expect(eu.key).toEqual({ kind: "scalar", value: "EU" });
    expect(eu.value).toEqual({ kind: "sum", value: 30 });
    const us = res.groups.get("US")!;
    expect(us.key).toEqual({ kind: "scalar", value: "US" });
    expect(us.value).toEqual({ kind: "sum", value: 5 });
  });

  it("groups by subject (bare top-level field)", () => {
    const claims = [
      makeClaim({ subject: "A" }),
      makeClaim({ subject: "A" }),
      makeClaim({ subject: "B" }),
    ];
    const res = alphaGroupBy("subject", countCore)(corpusOf(claims));
    expect(res.groups.size).toBe(2);
    expect(res.groups.get("A")!.value).toEqual({ kind: "count", n: 2 });
    expect(res.groups.get("B")!.value).toEqual({ kind: "count", n: 1 });
  });
});

// ---------------------------------------------------------------------------
// Type shape validation
// ---------------------------------------------------------------------------

describe("type exports", () => {
  it("AggValue kinds are all present", () => {
    const count: AggValue = { kind: "count", n: 1 };
    const sum: AggValue = { kind: "sum", value: 1 };
    const avg: AggValue = { kind: "avg", value: 1 };
    const min: AggValue = { kind: "min", value: 1 };
    const max: AggValue = { kind: "max", value: 1 };
    const rate: AggValue = { kind: "rate", beta: { alpha: 1, beta: 1 } };
    expect([count, sum, avg, min, max, rate].map((v) => v.kind)).toEqual([
      "count", "sum", "avg", "min", "max", "rate",
    ]);
  });

  it("GroupKey kinds are all present", () => {
    const scalar: GroupKey = { kind: "scalar", value: "x" };
    const tuple: GroupKey = { kind: "tuple", values: [1, 2] };
    const none: GroupKey = { kind: "none" };
    expect([scalar, tuple, none].map((k) => k.kind)).toEqual(["scalar", "tuple", "none"]);
  });
});
