import type { Corpus, RankedCorpus } from "./types.js";
import type { Value } from "../core/value.js";
import { canonicalizeValue } from "../core/value.js";
import type { EvalContext } from "./expression.js";

export interface SimilarityFn {
  scoreOne(value: Value, query: Value): number;
  isPure: boolean;
  version: string; // math-only, e.g. "jaccard@1", "cosine@1" (audit B2)
  /** EmbeddingModelId → version; present only on embedding-backed fns (audit B2). */
  embeddingVersions?: Record<string, string>;
}

const tokens = (v: Value): Set<string> =>
  new Set(
    (typeof v === "string" ? v : canonicalizeValue(v)).toLowerCase().split(/\W+/).filter(Boolean)
  );

export const simJaccard: SimilarityFn = {
  isPure: true,
  version: "jaccard@1",
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
  version: "exact@1",
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

/** Throws a descriptive plain Error on collision with a DIFFERENT fn; same-object
 *  re-register is a no-op. Lookup error message `/no similarity fn/` unchanged. */
export function registerSimilarity(name: string, fn: SimilarityFn): void {
  const existing = registry[name];
  if (existing && existing !== fn) {
    throw new Error(`similarity fn "${name}" already registered with a different implementation`);
  }
  registry[name] = fn;
}

export const hybridMax = (a: SimilarityFn, b: SimilarityFn): SimilarityFn => ({
  isPure: a.isPure && b.isPure,
  version: `hybrid-max@1[${a.version},${b.version}]`,
  // b wins on key collision (last-writer)
  ...(a.embeddingVersions || b.embeddingVersions
    ? { embeddingVersions: { ...a.embeddingVersions, ...b.embeddingVersions } }
    : {}),
  scoreOne: (v, q) => {
    const sa = a.scoreOne(v, q);
    const sb = b.scoreOne(v, q);
    return Number.isFinite(sa) && Number.isFinite(sb) ? Math.max(sa, sb)
      : Number.isFinite(sa) ? sa
      : Number.isFinite(sb) ? sb
      : NaN; // both broken — nothing sane to return
  },
});

/** Filters RankedCorpus.scored to score >= minScore (order preserved). Empty
 *  survivors => caller's structural abstention. Throws if minScore outside [0,1]. */
export const relevanceFloor = (minScore: number): ((r: RankedCorpus, ctx?: EvalContext) => RankedCorpus) => {
  if (minScore < 0 || minScore > 1) {
    throw new Error(`relevanceFloor: minScore must be in [0,1], got ${minScore}`);
  }
  return (r: RankedCorpus, _ctx?: EvalContext): RankedCorpus => ({
    scored: r.scored.filter((s) => s.score >= minScore),
  });
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
