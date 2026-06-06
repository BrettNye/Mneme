import type { Predicate } from "./predicate.js";
import type { DecayPolicy } from "../catalog/corpus.js";
import type { Value } from "../core/value.js";
import type { Instant } from "../core/time.js";
import type { Claim } from "../core/claim.js";
import type { Format } from "./composition.js";
import type { SimilarityConfig } from "./combination.js";

export type Field = keyof Claim;

export type ExprNode =
  | { op: "leaf"; corpusId: string }
  | { op: "sigma"; pred: Predicate; src: ExprNode }
  | { op: "tau"; mode: "valid" | "recorded" | "known" | "now"; t?: Instant; src: ExprNode }
  | { op: "delta"; policy: DecayPolicy; src: ExprNode }
  | { op: "pi"; fields: Field[]; src: ExprNode }
  | { op: "rho"; fn: string; query: Value; src: ExprNode }
  | { op: "gamma"; depth: number; src: ExprNode }
  | { op: "kappa"; fmt: Format; maxTokens: number; dedupThreshold?: number; src: ExprNode }
  /** combine is ⊕_dedupe (spec §4.9) — combine same-(subject,key,scope) claims via a rule. */
  | { op: "combine"; rule: string; params?: Value; similarity?: SimilarityConfig; src: ExprNode }
  | { op: "synthesize"; subject: string; key: string; rule: string; params?: Value; src: ExprNode }
  | { op: "resolve"; policy: string; threshold?: number; rule?: string;
      keyCardinality?: Record<string, "single" | "multi">;
      keyAliases?: Record<string, string>; src: ExprNode }
  | { op: "aggregate"; fn: string; reweight?: string; where?: Predicate; groupBy?: string; src: ExprNode };

export const leaf = (corpusId: string): ExprNode =>
  ({ op: "leaf", corpusId });

export const sigma = (pred: Predicate, src: ExprNode): ExprNode =>
  ({ op: "sigma", pred, src });

export const tau = (
  mode: "valid" | "recorded" | "known" | "now",
  src: ExprNode,
  t?: Instant,
): ExprNode =>
  t !== undefined ? { op: "tau", mode, t, src } : { op: "tau", mode, src };

export const delta = (policy: DecayPolicy, src: ExprNode): ExprNode =>
  ({ op: "delta", policy, src });

export const pi = (fields: Field[], src: ExprNode): ExprNode =>
  ({ op: "pi", fields, src });

export const rho = (fn: string, query: Value, src: ExprNode): ExprNode =>
  ({ op: "rho", fn, query, src });

export const gamma = (depth: number, src: ExprNode): ExprNode =>
  ({ op: "gamma", depth, src });

export const kappa = (
  fmt: Format,
  maxTokens: number,
  src: ExprNode,
  dedupThreshold?: number,
): ExprNode =>
  dedupThreshold !== undefined
    ? { op: "kappa", fmt, maxTokens, dedupThreshold, src }
    : { op: "kappa", fmt, maxTokens, src };

export const combine = (
  rule: string,
  src: ExprNode,
  params?: Value,
  similarity?: SimilarityConfig,
): ExprNode => {
  const node: Extract<ExprNode, { op: "combine" }> = { op: "combine", rule, src };
  if (params !== undefined) node.params = params;
  if (similarity !== undefined) node.similarity = similarity;
  return node;
};

export const synthesize = (
  subject: string,
  key: string,
  rule: string,
  src: ExprNode,
  params?: Value,
): ExprNode =>
  params !== undefined
    ? { op: "synthesize", subject, key, rule, params, src }
    : { op: "synthesize", subject, key, rule, src };

/**
 * threshold omitted ⇒ the node is intentionally UNSTAMPED: the derive path stamps
 * CorpusDefaults.confidenceThreshold before serialization (the wire format requires
 * threshold — see serialize.ts REQUIRED_FIELDS), and compile() rejects unstamped nodes.
 */
export const resolve = (
  policy: string,
  src: ExprNode,
  rule?: string,
  threshold?: number,
  keyCardinality?: Record<string, "single" | "multi">,
  keyAliases?: Record<string, string>,
): ExprNode => {
  const node: Extract<ExprNode, { op: "resolve" }> = { op: "resolve", policy, src };
  if (threshold !== undefined) node.threshold = threshold;
  if (rule !== undefined) node.rule = rule;
  if (keyCardinality !== undefined) node.keyCardinality = keyCardinality;
  if (keyAliases !== undefined) node.keyAliases = keyAliases;
  return node;
};

export const aggregate = (
  fn: string,
  src: ExprNode,
  opts?: { reweight?: string; where?: Predicate; groupBy?: string },
): ExprNode => {
  const node: Extract<ExprNode, { op: "aggregate" }> = { op: "aggregate", fn, src };
  if (opts?.reweight !== undefined) node.reweight = opts.reweight;
  if (opts?.where !== undefined) node.where = opts.where;
  if (opts?.groupBy !== undefined) node.groupBy = opts.groupBy;
  return node;
};
