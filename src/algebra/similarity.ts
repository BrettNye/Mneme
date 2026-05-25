import type { Corpus, RankedCorpus } from "./types.js";
import type { Value } from "../core/value.js";
import { canonicalizeValue } from "../core/value.js";

export interface SimilarityFn {
  scoreOne(value: Value, query: Value): number;
  isPure: boolean;
}

const tokens = (v: Value): Set<string> =>
  new Set(
    (typeof v === "string" ? v : canonicalizeValue(v)).toLowerCase().split(/\W+/).filter(Boolean)
  );

export const simJaccard: SimilarityFn = {
  isPure: true,
  scoreOne(v, q) {
    const a = tokens(v);
    const b = tokens(q);
    if (!a.size && !b.size) return 1;
    const inter = [...a].filter((x) => b.has(x)).length;
    return inter / (a.size + b.size - inter);
  },
};

export const simExact: SimilarityFn = {
  isPure: true,
  scoreOne: (v, q) => (canonicalizeValue(v) === canonicalizeValue(q) ? 1 : 0),
};

const registry: Record<string, SimilarityFn> = {
  jaccard: simJaccard,
  exact: simExact,
};

export const similarityFn = (name: string): SimilarityFn => {
  const f = registry[name];
  if (!f) throw new Error(`no similarity fn "${name}"`);
  return f;
};

export const rho =
  (name: string, query: Value) =>
  (c: Corpus): RankedCorpus => {
    const fn = similarityFn(name);
    return {
      scored: c.claims
        .map((claim) => ({ claim, score: fn.scoreOne(claim.value, query) }))
        .sort((a, b) => b.score - a.score),
    };
  };
