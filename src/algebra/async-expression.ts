import type { Corpus, RankedCorpus, ComposedContext } from "./types.js";
import { corpusOf } from "./types.js";
import type { AsyncStorageAdapter } from "../adapters/async-adapter.js";
import type { Catalog } from "../catalog/catalog.js";
import { gammaAsyncTraverse } from "./provenance-traversal.js";
import { now as nowClock, type Instant } from "../core/time.js";
import type { QueryWarning } from "./value-routing.js";
import type { Predicate } from "./predicate.js";
import type { Value } from "../core/value.js";

import { sigma as sigmaOp } from "./selection.js";
import {
  tauNow as tauNowOp,
  tauKnown as tauKnownOp,
  tauValid as tauValidOp,
  tauRecorded as tauRecordedOp,
} from "./temporal.js";
import { delta as deltaOp } from "./decay.js";
import { rho as rhoOp, similarityFn } from "./similarity.js";
import { kappa as kappaOp, type Format } from "./composition.js";
import { overrideOp } from "./override.js";
import { joinScope, joinSubject, joinEvidence } from "./join.js";

/**
 * Async twin of EvalContext (see expression.ts) — same 7 fields, but `adapter`
 * is an AsyncStorageAdapter so seam stages (leafAsync, gammaAsync) can await
 * storage calls.
 */
export interface AsyncEvalContext {
  adapter: AsyncStorageAdapter;
  catalog: Catalog;
  /** Pinned evaluation time for time-dependent operators (δ, τ_now); when set, replaces wall-clock. */
  evaluationClock?: Instant;
  /** Mutable accumulator populated during evaluation — records the similarity fn version used (ρ). */
  usedSimilarityVersions?: Record<string, string>;
  /** Mutable accumulator populated during evaluation — records the embedding model version used. */
  usedEmbeddingModelVersions?: Record<string, string>;
  /** Optional delivery channel for query warnings (e.g., fallback_in_memory over threshold). */
  onWarning?: (w: QueryWarning) => void;
  /** Working-set size above which fallback_in_memory predicates emit a warning. */
  fallbackWarnThreshold?: number;
}

/**
 * An AsyncStage receives the previous stage's output plus the async eval
 * context and returns the next stage's input — synchronously or as a
 * Promise. Pure-core wrappers (asyncSigma, asyncTauNow, ...) may return
 * synchronously; seam stages (leafAsync, gammaAsync, overrideAsync,
 * joinAsync) return Promises.
 */
export type AsyncStage<I, O> = (input: I, ctx: AsyncEvalContext) => Promise<O> | O;

/**
 * evaluateAsync: runs a pipeline (stage array), threading ctx through each
 * stage and awaiting every result (sync-returning stages resolve trivially).
 * Starts from `undefined` — the leaf stage ignores its input. Mirrors the
 * sync evaluate() in expression.ts.
 */
export async function evaluateAsync<O>(
  stages: AsyncStage<any, any>[],
  ctx: AsyncEvalContext,
): Promise<O> {
  let acc: unknown = undefined;
  for (const stage of stages) {
    acc = await stage(acc, ctx);
  }
  return acc as O;
}

// ---------------------------------------------------------------------------
// Seam stages — these are the async boundary; they touch the AsyncStorageAdapter.
// ---------------------------------------------------------------------------

/**
 * leafAsync(corpusId): validates corpus existence in the catalog (sync, same
 * as the sync leaf), then awaits claims from the adapter. Ignores its input.
 */
export function leafAsync(corpusId: string): AsyncStage<void, Corpus> {
  return async (_input, ctx) => {
    ctx.catalog.getCorpus(corpusId); // throws for unknown corpus
    return corpusOf(await ctx.adapter.query({ corpusId }));
  };
}

/**
 * gammaAsync: ctx-aware stage for γ (provenance traversal). Wires the
 * adapter's (async) getClaim into gammaAsyncTraverse so callers do not need
 * to manually thread it.
 */
export function gammaAsync(depth: number): AsyncStage<RankedCorpus, RankedCorpus> {
  return (rc, ctx) => gammaAsyncTraverse(rc, depth, (id) => ctx.adapter.getClaim(id));
}

/**
 * overrideAsync: async twin of override() in override.ts. The incoming
 * corpus is the dominator (left); `right` is its own sub-pipeline evaluated
 * in the same ctx via evaluateAsync, then the pure overrideOp applies
 * left-precedence.
 */
export const overrideAsync =
  (right: AsyncStage<any, any>[]): AsyncStage<Corpus, Corpus> =>
  async (c, ctx) =>
    overrideOp(c, await evaluateAsync<Corpus>(right, ctx));

/**
 * joinAsync: async twin of the joinScopeWith/joinSubjectWith/joinEvidenceWith
 * stage builders in join.ts. Each evaluates a right sub-pipeline via
 * evaluateAsync, then joins against it with the pure joinScope/joinSubject/joinEvidence.
 */
export const joinAsync = {
  scope:
    (right: AsyncStage<any, any>[]): AsyncStage<Corpus, Corpus> =>
    async (c, ctx) =>
      joinScope(c, await evaluateAsync<Corpus>(right, ctx)),
  subject:
    (right: AsyncStage<any, any>[]): AsyncStage<Corpus, Corpus> =>
    async (c, ctx) =>
      joinSubject(c, await evaluateAsync<Corpus>(right, ctx)),
  evidence:
    (right: AsyncStage<any, any>[]): AsyncStage<Corpus, Corpus> =>
    async (c, ctx) =>
      joinEvidence(c, await evaluateAsync<Corpus>(right, ctx)),
};

// ---------------------------------------------------------------------------
// Async pure-core Stage builders — wrap the SAME pure operator cores used by
// the sync builders (mneme.ts), re-threading AsyncEvalContext instead of the
// sync EvalContext. The underlying math is imported, never reimplemented.
// ---------------------------------------------------------------------------

/** σ: wraps the pure sigmaOp core. Reads nothing from ctx (pure filter). */
export const asyncSigma = (p: Predicate): AsyncStage<Corpus, Corpus> => (c, _ctx) => sigmaOp(p)(c);

export const asyncTauNow = (): AsyncStage<Corpus, Corpus> =>
  (c, ctx) => tauNowOp(() => ctx.evaluationClock ?? nowClock())(c);
export const asyncTauKnown = (t: Instant): AsyncStage<Corpus, Corpus> =>
  (c, _ctx) => tauKnownOp(t)(c);
export const asyncTauValid = (t: Instant): AsyncStage<Corpus, Corpus> =>
  (c, _ctx) => tauValidOp(t)(c);
export const asyncTauRecorded = (t: Instant): AsyncStage<Corpus, Corpus> =>
  (c, _ctx) => tauRecordedOp(t)(c);

export const asyncDelta = {
  exponential: (halfLifeDays: number): AsyncStage<Corpus, Corpus> =>
    (c, ctx) => deltaOp({ kind: "exponential", halfLifeDays }, ctx.evaluationClock ?? nowClock())(c),
  none: (): AsyncStage<Corpus, Corpus> =>
    (c, ctx) => deltaOp({ kind: "none" }, ctx.evaluationClock ?? nowClock())(c),
  linear: (ratePerDay: number): AsyncStage<Corpus, Corpus> =>
    (c, ctx) => deltaOp({ kind: "linear", ratePerDay }, ctx.evaluationClock ?? nowClock())(c),
  step: (thresholdDays: number): AsyncStage<Corpus, Corpus> =>
    (c, ctx) => deltaOp({ kind: "step", thresholdDays }, ctx.evaluationClock ?? nowClock())(c),
};

const _asyncRhoBy = (name: string, query: Value): AsyncStage<Corpus, RankedCorpus> => (c, ctx) => {
  const fn = similarityFn(name); // throws /no similarity fn/ for unknown names
  if (ctx.usedSimilarityVersions) ctx.usedSimilarityVersions[name] = fn.version;
  if (fn.embeddingVersions && ctx.usedEmbeddingModelVersions) {
    Object.assign(ctx.usedEmbeddingModelVersions, fn.embeddingVersions);
  }
  return rhoOp(name, query)(c);
};

export const asyncRho = {
  jaccard: (query: Value): AsyncStage<Corpus, RankedCorpus> => _asyncRhoBy("jaccard", query),
  exact: (query: Value): AsyncStage<Corpus, RankedCorpus> => _asyncRhoBy("exact", query),
  by: _asyncRhoBy,
};

export const asyncKappa = {
  xml: (maxTokens: number, dedupThreshold?: number): AsyncStage<RankedCorpus, ComposedContext> =>
    (rc, _ctx) => kappaOp("xml", maxTokens, dedupThreshold)(rc),
  markdown: (maxTokens: number, dedupThreshold?: number): AsyncStage<RankedCorpus, ComposedContext> =>
    (rc, _ctx) => kappaOp("markdown", maxTokens, dedupThreshold)(rc),
  json: (maxTokens: number, dedupThreshold?: number): AsyncStage<RankedCorpus, ComposedContext> =>
    (rc, _ctx) => kappaOp("json", maxTokens, dedupThreshold)(rc),
  text: (maxTokens: number, dedupThreshold?: number): AsyncStage<RankedCorpus, ComposedContext> =>
    (rc, _ctx) => kappaOp("text", maxTokens, dedupThreshold)(rc),
  by: (fmt: Format, maxTokens: number, dedupThreshold?: number): AsyncStage<RankedCorpus, ComposedContext> =>
    (rc, _ctx) => kappaOp(fmt, maxTokens, dedupThreshold)(rc),
};
