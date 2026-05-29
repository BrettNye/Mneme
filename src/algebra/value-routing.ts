import type { Predicate } from "./predicate.js";
import { isValuePredicate, predicateKindOf } from "./predicate.js";
import type { ValuePredicate } from "./value-predicate.js";
import { valuePredicateLevel, type AdapterCapabilities, type PredicateKind } from "../adapters/adapter.js";

export class UnsupportedValuePredicateError extends Error {
  constructor(public readonly predicateKind: PredicateKind, public readonly path?: string) {
    super(
      `value predicate kind "${predicateKind}"${path ? ` on path "${path}"` : ""} is unsupported by this adapter`
    );
    this.name = "UnsupportedValuePredicateError";
  }
}

export interface QueryWarning {
  kind: "fallback_in_memory";
  predicateKind: PredicateKind;
  path?: string;
  workingSetSize: number;
  threshold: number;
  message: string;
}

export function collectValuePredicates(p: Predicate): ValuePredicate[] {
  if (isValuePredicate(p)) return [p];
  if (p.op === "and" || p.op === "or") return p.preds.flatMap(collectValuePredicates);
  if (p.op === "not") return collectValuePredicates(p.pred);
  return [];
}

export function routeValuePredicates(
  p: Predicate,
  caps: AdapterCapabilities,
  opts: { workingSetSize: number; threshold: number; onWarning: (w: QueryWarning) => void }
): void {
  for (const vp of collectValuePredicates(p)) {
    const kind = predicateKindOf(vp);
    const level = valuePredicateLevel(caps, kind);
    const path = "path" in vp ? vp.path : undefined;

    if (level === "unsupported") {
      throw new UnsupportedValuePredicateError(kind, path);
    }

    if (level === "fallback_in_memory" && opts.workingSetSize > opts.threshold) {
      opts.onWarning({
        kind: "fallback_in_memory",
        predicateKind: kind,
        path,
        workingSetSize: opts.workingSetSize,
        threshold: opts.threshold,
        message: `value predicate "${kind}" runs as in-memory fallback over ${opts.workingSetSize} claims (threshold ${opts.threshold})`,
      });
    }

    // native_indexed / native_unindexed → proceed silently (no push-down this pass).
  }
}
