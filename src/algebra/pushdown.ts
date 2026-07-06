import type { Predicate } from "./predicate.js";
import type { ExecutionPlan } from "../adapters/adapter-types.js";

export type LeafHints = Pick<ExecutionPlan, "subject" | "key" | "keys">;

/** Fold the top-level conjunction of σ predicates into an adapter plan fragment.
 *  INVARIANT: the hint is broader than or equal to the conjunction, never narrower —
 *  σ stages re-filter in memory, so an over-broad hint is harmless. */
export function leafHintsOf(preds: Predicate[]): LeafHints {
  const hints: LeafHints = {};
  const fold = (p: Predicate): void => {
    switch (p.op) {
      case "subjectEq": if (hints.subject === undefined) hints.subject = p.value; break;
      case "keyEq":     if (hints.key === undefined) hints.key = p.value; break;
      case "keyIn":
        if (p.values.length === 1) { if (hints.key === undefined) hints.key = p.values[0]; }
        else if (p.values.length > 1 && hints.keys === undefined) hints.keys = [...p.values];
        break; // empty keyIn contributes NOTHING (plan-level [] would mean "no condition")
      case "and": for (const q of p.preds) fold(q); break;
      default: break; // subjectIn/or/not/value/tag/status/scope/confidence/temporal: σ-only
    }
  };
  for (const p of preds) fold(p);
  return hints;
}
