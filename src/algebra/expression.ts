import type { Corpus, RankedCorpus, ComposedContext } from "./types.js";
import { corpusOf } from "./types.js";
import type { StorageAdapter } from "../adapters/adapter.js";
import type { Catalog } from "../catalog/catalog.js";
import { gamma } from "./provenance-traversal.js";
import type { Instant } from "../core/time.js";
import type { QueryWarning } from "./value-routing.js";
import type { LeafHints } from "./pushdown.js";

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
 * leaf(corpusId, hints?): validates corpus existence in the catalog, then loads
 * claims from the adapter. Ignores its input (leaf stage starts a pipeline).
 * Optional LeafHints (subject/key/keys) are spread into the adapter plan as-is;
 * leaf performs no interpretation of the hints (see pushdown.ts for the fold
 * that produces them).
 */
export function leaf(corpusId: string, hints?: LeafHints): Stage<void, Corpus> {
  return (_input, ctx) => {
    ctx.catalog.getCorpus(corpusId); // throws for unknown corpus
    return corpusOf(ctx.adapter.query({ corpusId, ...hints }));
  };
}

/**
 * fromCorpus: starts a pipeline from an already-materialized corpus (spec §5,
 * amendment A7). A physical seam, not an algebra operator — leaf() with the
 * I/O already done. No new algebra semantics, so it needs no AST node and
 * never appears in replay provenance. Returns the corpus by reference (no
 * copy); downstream stages already treat inputs as immutable.
 *
 * Async-pipeline note: fromCorpus's returned Stage<void, Corpus> ignores its
 * `ctx` argument entirely, so it is safe to run inside an evaluateAsync
 * pipeline via `as unknown as AsyncStage<any, any>` — see the cast in
 * expression.test.ts's "fromCorpus works in an evaluateAsync pipeline" case.
 * That cast is sound ONLY because both fromCorpus and liftOp-wrapped pure ops
 * never read ctx.adapter/ctx.catalog, so the sync-vs-async EvalContext shape
 * mismatch is nominal, not behavioral. This does NOT generalize: ctx-aware
 * seams like leaf() and gammaStage() DO read ctx.adapter/ctx.catalog and must
 * never be smuggled into an async pipeline via the same cast — use their
 * dedicated *Async twins instead, or a context-generic signature.
 */
export function fromCorpus(c: Corpus): Stage<void, Corpus> {
  return () => c;
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
