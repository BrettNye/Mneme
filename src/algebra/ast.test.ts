import { leaf, sigma, tau, delta, pi, rho, gamma, kappa, combine, synthesize, resolve, aggregate } from "./ast.js";
import type { ExprNode } from "./ast.js";

it("leaf constructor builds leaf shape", () => {
  const n = leaf("corpus-1");
  expect(n).toEqual({ op: "leaf", corpusId: "corpus-1" });
});

it("sigma constructor builds selection shape", () => {
  const n = sigma({ op: "keyEq", value: "k" }, leaf("c"));
  expect(n).toEqual({
    op: "sigma",
    pred: { op: "keyEq", value: "k" },
    src: { op: "leaf", corpusId: "c" },
  });
});

it("tau constructor builds temporal shape with optional t", () => {
  const withoutT = tau("valid", leaf("c"));
  expect(withoutT).toEqual({ op: "tau", mode: "valid", src: { op: "leaf", corpusId: "c" } });

  const withT = tau("recorded", leaf("c"), 1234567890);
  expect(withT).toEqual({ op: "tau", mode: "recorded", t: 1234567890, src: { op: "leaf", corpusId: "c" } });
});

it("delta constructor builds decay shape", () => {
  const n = delta({ kind: "exponential", halfLifeDays: 30 }, leaf("c"));
  expect(n).toEqual({
    op: "delta",
    policy: { kind: "exponential", halfLifeDays: 30 },
    src: { op: "leaf", corpusId: "c" },
  });
});

it("pi constructor builds projection shape", () => {
  const n = pi(["subject", "key"], leaf("c"));
  expect(n).toEqual({
    op: "pi",
    fields: ["subject", "key"],
    src: { op: "leaf", corpusId: "c" },
  });
});

it("rho constructor builds reranking shape", () => {
  const n = rho("cosine", "query text", leaf("c"));
  expect(n).toEqual({
    op: "rho",
    fn: "cosine",
    query: "query text",
    src: { op: "leaf", corpusId: "c" },
  });
});

it("gamma constructor builds provenance traversal shape", () => {
  const n = gamma(2, leaf("c"));
  expect(n).toEqual({ op: "gamma", depth: 2, src: { op: "leaf", corpusId: "c" } });
});

it("kappa constructor builds composition shape with optional dedupThreshold", () => {
  const withoutDedup = kappa("markdown", 512, leaf("c"));
  expect(withoutDedup).toEqual({
    op: "kappa",
    fmt: "markdown",
    maxTokens: 512,
    src: { op: "leaf", corpusId: "c" },
  });

  const withDedup = kappa("xml", 1024, leaf("c"), 0.8);
  expect(withDedup).toEqual({
    op: "kappa",
    fmt: "xml",
    maxTokens: 1024,
    dedupThreshold: 0.8,
    src: { op: "leaf", corpusId: "c" },
  });
});

it("combine constructor builds combination shape with optional params", () => {
  const withoutParams = combine("weightedAvg", leaf("c"));
  expect(withoutParams).toEqual({
    op: "combine",
    rule: "weightedAvg",
    src: { op: "leaf", corpusId: "c" },
  });

  const withParams = combine("weightedAvg", leaf("c"), { weights: [0.5, 0.5] });
  expect(withParams).toEqual({
    op: "combine",
    rule: "weightedAvg",
    params: { weights: [0.5, 0.5] },
    src: { op: "leaf", corpusId: "c" },
  });
});

it("combine records similarity when supplied", () => {
  const n = combine("rule_weighted_avg", leaf("c"), undefined, { fn: "jaccard", cutoff: 0.5 });
  expect(n).toEqual({
    op: "combine",
    rule: "rule_weighted_avg",
    similarity: { fn: "jaccard", cutoff: 0.5 },
    src: { op: "leaf", corpusId: "c" },
  });
});

it("combine omits similarity key when not supplied", () => {
  const n = combine("rule", leaf("c"));
  expect("similarity" in n).toBe(false);
});

it("synthesize constructor builds synthesis shape with optional params", () => {
  const withoutParams = synthesize("subject1", "bio", "llmSynth", leaf("c"));
  expect(withoutParams).toEqual({
    op: "synthesize",
    subject: "subject1",
    key: "bio",
    rule: "llmSynth",
    src: { op: "leaf", corpusId: "c" },
  });

  const withParams = synthesize("subject1", "bio", "llmSynth", leaf("c"), { temperature: 0.7 });
  expect(withParams).toEqual({
    op: "synthesize",
    subject: "subject1",
    key: "bio",
    rule: "llmSynth",
    params: { temperature: 0.7 },
    src: { op: "leaf", corpusId: "c" },
  });
});

it("resolve constructor builds resolution shape with optional rule", () => {
  const withoutRule = resolve("latestWins", leaf("c"));
  expect(withoutRule).toEqual({
    op: "resolve",
    policy: "latestWins",
    src: { op: "leaf", corpusId: "c" },
  });

  const withRule = resolve("latestWins", leaf("c"), "deprecate_lower");
  expect(withRule).toEqual({
    op: "resolve",
    policy: "latestWins",
    rule: "deprecate_lower",
    src: { op: "leaf", corpusId: "c" },
  });
});

it("resolve omits threshold key when not supplied (omit-undefined house style)", () => {
  const n = resolve("resolveKeepBoth", leaf("c"));
  expect("threshold" in n).toBe(false);
});

it("resolve records an explicit threshold when supplied", () => {
  expect(resolve("resolveKeepBoth", leaf("c"), undefined, 0.75)).toEqual({
    op: "resolve", policy: "resolveKeepBoth", threshold: 0.75, src: { op: "leaf", corpusId: "c" },
  });
  expect(resolve("latestWins", leaf("c"), "deprecate_lower", 0.9)).toEqual({
    op: "resolve", policy: "latestWins", threshold: 0.9, rule: "deprecate_lower", src: { op: "leaf", corpusId: "c" },
  });
  expect(resolve("p", leaf("c"), undefined, 0)).toEqual({
    op: "resolve", policy: "p", threshold: 0, src: { op: "leaf", corpusId: "c" },
  });
});

it("resolve records keyCardinality when supplied", () => {
  const n = resolve("p", leaf("c"), undefined, 0, { hobby: "multi" });
  expect(n).toEqual({
    op: "resolve", policy: "p", threshold: 0, keyCardinality: { hobby: "multi" },
    src: { op: "leaf", corpusId: "c" },
  });
});

it("resolve omits keyCardinality key when not supplied", () => {
  const n = resolve("p", leaf("c"), undefined, 0.3);
  expect("keyCardinality" in n).toBe(false);
});

it("aggregate constructor builds aggregation shape with optional fields", () => {
  const minimal = aggregate("count", leaf("c"));
  expect(minimal).toEqual({
    op: "aggregate",
    fn: "count",
    src: { op: "leaf", corpusId: "c" },
  });

  const full = aggregate("mean", leaf("c"), {
    reweight: "byRecency",
    where: { op: "confidenceGt", value: 0.5 },
    groupBy: "key",
  });
  expect(full).toEqual({
    op: "aggregate",
    fn: "mean",
    reweight: "byRecency",
    where: { op: "confidenceGt", value: 0.5 },
    groupBy: "key",
    src: { op: "leaf", corpusId: "c" },
  });
});

it("ExprNode discriminated union covers all 12 variants", () => {
  // Verify all 12 ops are valid ExprNode shapes (compile-time check via type assertion)
  const nodes: ExprNode[] = [
    leaf("c"),
    sigma({ op: "subjectEq", value: "s" }, leaf("c")),
    tau("now", leaf("c")),
    delta({ kind: "none" }, leaf("c")),
    pi(["id"], leaf("c")),
    rho("fn", null, leaf("c")),
    gamma(1, leaf("c")),
    kappa("text", 100, leaf("c")),
    combine("rule", leaf("c")),
    synthesize("subj", "k", "rule", leaf("c")),
    resolve("policy", leaf("c")),
    aggregate("fn", leaf("c")),
  ];
  expect(nodes).toHaveLength(12);
});

it("constructors produce plain JSON-serializable objects", () => {
  const n = sigma({ op: "and", preds: [{ op: "keyEq", value: "k" }] }, leaf("c"));
  const json = JSON.stringify(n);
  expect(JSON.parse(json)).toEqual(n);
});
