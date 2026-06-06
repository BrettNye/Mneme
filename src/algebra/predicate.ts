import type { Claim } from "../core/claim.js";
import { pointEstimate } from "../core/confidence.js";
import { covers } from "../core/time.js";
import type { ValuePredicate } from "./value-predicate.js";
import { matchesValue } from "./value-predicate.js";
import type { PredicateKind } from "../adapters/adapter.js";

export type Predicate =
  | { op: "subjectEq"; value: string }
  | { op: "subjectIn"; values: string[] }
  | { op: "keyEq"; value: string }
  | { op: "keyIn"; values: string[] }
  | { op: "scopeEq"; field: string; value: string }
  | { op: "statusEq"; value: string }
  | { op: "statusIn"; values: string[] }
  | { op: "confidenceGt"; value: number }
  | { op: "tagIn"; values: string[] }
  | { op: "validAt"; t: number }
  | { op: "recordedAfter"; t: number }
  | { op: "and"; preds: Predicate[] }
  | { op: "or"; preds: Predicate[] }
  | { op: "not"; pred: Predicate }
  | ValuePredicate;

// Single source of truth for the value-op set (DRY): drives BOTH helpers.
export const VALUE_PREDICATE_KIND: Record<ValuePredicate["op"], PredicateKind> = {
  valueEq: "equality",
  valueGt: "range",
  valueIn: "set_membership",
  valueRegex: "regex",
  valueMatches: "structural_pattern",
  valueNull: "null_check",
  valueExists: "null_check",
};

export const isValuePredicate = (p: Predicate): p is ValuePredicate =>
  p.op in VALUE_PREDICATE_KIND;

export const predicateKindOf = (vp: ValuePredicate): PredicateKind =>
  VALUE_PREDICATE_KIND[vp.op];

export function matches(claim: Claim, p: Predicate): boolean {
  if (isValuePredicate(p)) return matchesValue(claim.value, p);
  switch (p.op) {
    case "subjectEq":
      return claim.subject === p.value;
    case "subjectIn":
      return p.values.includes(claim.subject);
    case "keyEq":
      return claim.key === p.value;
    case "keyIn":
      return p.values.includes(claim.key);
    case "scopeEq":
      return claim.scope[p.field] === p.value;
    case "statusEq":
      return claim.status === p.value;
    case "statusIn":
      return p.values.includes(claim.status);
    case "confidenceGt":
      return (claim.confidence.effective ?? pointEstimate(claim.confidence)) > p.value;
    case "tagIn":
      return p.values.some((v) => claim.tags.includes(v));
    case "validAt":
      return covers(claim.valid, p.t);
    case "recordedAfter":
      return claim.recorded > p.t;
    case "and":
      return p.preds.every((q) => matches(claim, q));
    case "or":
      return p.preds.some((q) => matches(claim, q));
    case "not":
      return !matches(claim, p.pred);
  }
}
