import type { Corpus, RankedCorpus, ComposedContext } from "./types.js";
import { corpusOf } from "./types.js";
import type { StorageAdapter } from "../adapters/adapter.js";
import type { Catalog } from "../catalog/catalog.js";
import { gamma } from "./provenance-traversal.js";
import type { Instant } from "../core/time.js";
import type { QueryWarning } from "./value-routing.js";

export interface EvalContext {
  adapter: StorageAdapter;
  catalog: Catalog;
  /** Pinned evaluation time for time-dependent operators (δ, τ_now); when set, replaces wall-clock. */
  evaluationClock?: Instant;
  /** Mutable accumulator populated during evaluation — records the similarity fn version used (ρ). */
  usedSimilarityVersions?: Record<string, string>;
  /** Mutable accumulator populated during evaluation — records the embedding model version used. */
  usedEmbeddingModelVersions?: Record<string, string>;
  /** Optional delivery channel for query warnings (e.g., fallback_in_memory over threshold). */
  onWarning?: (w: QueryWarning) => void;
  /** Working-set size above which fallback_in_memory predicates emit a warning. When unset, the query/sigma layer applies its default (10_000); EvalContext itself enforces no default. */
  fallbackWarnThreshold?: number;
}

/**
 * A Stage receives the previous stage's output plus the eval context and
 * returns the next stage's input.
 */
export type Stage<I, O> = (input: I, ctx: EvalContext) => O;

/**
 * leaf(corpusId): validates corpus existence in the catalog, then loads claims
 * from the adapter. Ignores its input (leaf stage starts a pipeline).
 */
export function leaf(corpusId: string): Stage<void, Corpus> {
  return (_input, ctx) => {
    ctx.catalog.getCorpus(corpusId); // throws for unknown corpus
    return corpusOf(ctx.adapter.query({ corpusId }));
  };
}

/**
 * liftOp: wraps a ctx-ignoring operator (σ, τ, δ, π, ρ, κ) into a Stage so it
 * can be included in a pipeline evaluated by evaluate().
 */
export function liftOp<I, O>(op: (x: I) => O): Stage<I, O> {
  return (input, _ctx) => op(input);
}

/**
 * gammaStage: ctx-aware stage for γ (provenance traversal). Wires the adapter's
 * getClaim into the gamma operator so callers do not need to manually thread it.
 */
export function gammaStage(depth: number): Stage<RankedCorpus, RankedCorpus> {
  return (rc, ctx) => gamma(depth, (id) => ctx.adapter.getClaim(id))(rc);
}

/**
 * pipe: bundles an ordered list of stages into an array that evaluate() can run.
 * Keeps stage ordering explicit and lets the façade compose pipelines without
 * needing to call evaluate directly.
 */
export function pipe(...stages: Stage<any, any>[]): Stage<any, any>[] {
  return stages;
}

/**
 * evaluate: runs a pipeline (stage array) produced by pipe() or assembled
 * manually, threading ctx through each stage. Starts from `undefined` — the
 * leaf stage ignores its input.
 *
 * Returns the terminal value (Corpus | RankedCorpus | ComposedContext).
 * No optimizer reordering in the MVP.
 */
export function evaluate<O>(stages: Stage<any, any>[], ctx: EvalContext): O {
  return stages.reduce<any>(
    (acc, stage) => stage(acc, ctx),
    undefined
  ) as O;
}
