import type { Claim } from "../core/claim.js";
import { pointEstimate } from "../core/confidence.js";
import { covers } from "../core/time.js";

export type Predicate =
  | { op: "subjectEq"; value: string }
  | { op: "subjectIn"; values: string[] }
  | { op: "keyEq"; value: string }
  | { op: "scopeEq"; field: string; value: string }
  | { op: "statusEq"; value: string }
  | { op: "statusIn"; values: string[] }
  | { op: "confidenceGt"; value: number }
  | { op: "tagIn"; values: string[] }
  | { op: "validAt"; t: number }
  | { op: "recordedAfter"; t: number }
  | { op: "and"; preds: Predicate[] }
  | { op: "or"; preds: Predicate[] }
  | { op: "not"; pred: Predicate };

export function matches(claim: Claim, p: Predicate): boolean {
  switch (p.op) {
    case "subjectEq":
      return claim.subject === p.value;
    case "subjectIn":
      return p.values.includes(claim.subject);
    case "keyEq":
      return claim.key === p.value;
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
