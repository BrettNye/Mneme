import { Catalog } from "./catalog/catalog.js";
import { Promoter } from "./write/pipeline.js";
import type { StorageAdapter, ExecutionPlan } from "./adapters/adapter.js";
import type { TierRequirement } from "./catalog/tiers.js";
import type { Corpus as CorpusDef, ContradictionPolicy } from "./catalog/corpus.js";
import type { CandidateClaim, Claim, Status } from "./core/claim.js";
import type { ClaimId } from "./core/ids.js";
import type { Predicate } from "./algebra/predicate.js";
import type { Corpus, RankedCorpus, ComposedContext } from "./algebra/types.js";
import type { Value } from "./core/value.js";
import {
  leaf as leafStage,
  liftOp,
  gammaStage,
  pipe as pipeStages,
  evaluate,
  type Stage,
  type EvalContext,
} from "./algebra/expression.js";
import { sigma as sigmaOp } from "./algebra/selection.js";
import {
  tauNow as tauNowOp,
  tauKnown as tauKnownOp,
  tauValid as tauValidOp,
  tauRecorded as tauRecordedOp,
} from "./algebra/temporal.js";
import { delta as deltaOp } from "./algebra/decay.js";
import { rho as rhoOp, similarityFn } from "./algebra/similarity.js";
import { kappa as kappaOp, type Format } from "./algebra/composition.js";
import type { Instant } from "./core/time.js";
import {
  alphaCount,
  alphaCountWhere,
  alphaGroupBy,
  alphaRate,
  alphaBinaryRate,
  alphaSum,
  alphaAvg,
  alphaMin,
  alphaMax,
  type AggregateResult,
  type AggValue,
} from "./algebra/aggregation.js";
import {
  alphaJoinAggregate,
  reweightMultiply,
  reweightMultiplyMean,
  reweightWilsonFloor,
  reweightNormalize,
  reweightBoost,
  type ReweightFn,
} from "./algebra/aggregate-join.js";

export type { Stage, EvalContext } from "./algebra/expression.js";
export type { Format } from "./algebra/composition.js";

// ── Stage-producing builders ────────────────────────────────────────────────

export const sigma = (p: Predicate): Stage<Corpus, Corpus> => liftOp(sigmaOp(p));

export const tau = {
  now: (): Stage<Corpus, Corpus> =>
    (c, ctx) => tauNowOp(() => ctx.evaluationClock ?? Date.now())(c),
  known: (t: Instant): Stage<Corpus, Corpus> => liftOp(tauKnownOp(t)),
  valid: (t: Instant): Stage<Corpus, Corpus> => liftOp(tauValidOp(t)),
  recorded: (t: Instant): Stage<Corpus, Corpus> => liftOp(tauRecordedOp(t)),
};

export const delta = {
  exponential: (halfLifeDays: number): Stage<Corpus, Corpus> =>
    (c, ctx) => deltaOp({ kind: "exponential", halfLifeDays }, ctx.evaluationClock ?? Date.now())(c),
  none: (): Stage<Corpus, Corpus> =>
    (c, ctx) => deltaOp({ kind: "none" }, ctx.evaluationClock ?? Date.now())(c),
  linear: (ratePerDay: number): Stage<Corpus, Corpus> =>
    (c, ctx) => deltaOp({ kind: "linear", ratePerDay }, ctx.evaluationClock ?? Date.now())(c),
  step: (thresholdDays: number): Stage<Corpus, Corpus> =>
    (c, ctx) => deltaOp({ kind: "step", thresholdDays }, ctx.evaluationClock ?? Date.now())(c),
};

export const rho = {
  jaccard: (query: Value): Stage<Corpus, RankedCorpus> =>
    (c, ctx) => {
      if (ctx.usedSimilarityVersions) {
        ctx.usedSimilarityVersions["jaccard"] = similarityFn("jaccard").version;
      }
      return rhoOp("jaccard", query)(c);
    },
  exact: (query: Value): Stage<Corpus, RankedCorpus> =>
    (c, ctx) => {
      if (ctx.usedSimilarityVersions) {
        ctx.usedSimilarityVersions["exact"] = similarityFn("exact").version;
      }
      return rhoOp("exact", query)(c);
    },
};

export const gamma = (depth: number): Stage<RankedCorpus, RankedCorpus> => gammaStage(depth);

export const kappa = {
  xml: (maxTokens: number, dedupThreshold?: number): Stage<RankedCorpus, ComposedContext> =>
    liftOp(kappaOp("xml", maxTokens, dedupThreshold)),
  markdown: (maxTokens: number, dedupThreshold?: number): Stage<RankedCorpus, ComposedContext> =>
    liftOp(kappaOp("markdown", maxTokens, dedupThreshold)),
  json: (maxTokens: number, dedupThreshold?: number): Stage<RankedCorpus, ComposedContext> =>
    liftOp(kappaOp("json", maxTokens, dedupThreshold)),
  text: (maxTokens: number, dedupThreshold?: number): Stage<RankedCorpus, ComposedContext> =>
    liftOp(kappaOp("text", maxTokens, dedupThreshold)),
};

// ── Aggregation stage builders ───────────────────────────────────────────────

export const alpha = {
  count: (): Stage<Corpus, AggregateResult> => liftOp(alphaCount),
  countWhere: (p: Predicate): Stage<Corpus, AggregateResult> => liftOp(alphaCountWhere(p)),
  sum: (path: string): Stage<Corpus, AggregateResult> => liftOp(alphaSum(path)),
  avg: (path: string): Stage<Corpus, AggregateResult> => liftOp(alphaAvg(path)),
  min: (path: string): Stage<Corpus, AggregateResult> => liftOp(alphaMin(path)),
  max: (path: string): Stage<Corpus, AggregateResult> => liftOp(alphaMax(path)),
  groupBy: (field: string, core: (claims: Claim[]) => AggValue): Stage<Corpus, AggregateResult> =>
    liftOp(alphaGroupBy(field, core)),
  rate: (num: Predicate, denom: Predicate): Stage<Corpus, AggregateResult> =>
    liftOp(alphaRate(num, denom)),
  binaryRate: (valuePath: string): Stage<Corpus, AggregateResult> =>
    liftOp(alphaBinaryRate(valuePath)),
  joinAggregate: (
    aggregate: AggregateResult,
    joinKey: string,
    fn: ReweightFn
  ): Stage<RankedCorpus, RankedCorpus> => liftOp(alphaJoinAggregate(aggregate, joinKey, fn)),
};

export const reweight = {
  multiply: reweightMultiply,
  multiplyMean: reweightMultiplyMean,
  wilsonFloor: reweightWilsonFloor,
  normalize: reweightNormalize,
  boost: reweightBoost,
};

// Re-export pipe and leaf from expression so callers can import them from here.
export const pipe = pipeStages;
export const leaf = leafStage;

// ── createMneme ─────────────────────────────────────────────────────────────

export interface MnemeOptions {
  adapter: StorageAdapter;
  availableTiers: TierRequirement[];
}

export interface Mneme {
  createCorpus(corpus: CorpusDef): CorpusDef;
  commit(
    corpusId: string,
    candidate: CandidateClaim,
    opts: { policy?: ContradictionPolicy; writer: string; idempotencyKey?: string }
  ): { id: string; status: "committed" | "rejected" | "duplicate" };
  query<O>(corpusId: string, pipeline: Stage<any, any>[], opts?: { evaluationClock?: number }): O;
  supersede(
    corpusId: string,
    deprecateId: string,
    replacement: CandidateClaim,
    opts: { writer: string; idempotencyKey?: string }
  ): { id: string; status: string };
  promote(
    corpusId: string,
    targetId: string,
    to: Status,
    opts: { writer: string; reason?: string; idempotencyKey?: string }
  ): { id: string; status: string };
  read(corpusId: string, plan: ExecutionPlan): Claim[];
  readByIds(corpusId: string, ids: ClaimId[]): Claim[];
}

export function createMneme({ adapter, availableTiers }: MnemeOptions): Mneme {
  const catalog = new Catalog(availableTiers);
  const promoters = new Map<string, Promoter>();

  function promoterFor(corpusId: string): Promoter {
    let p = promoters.get(corpusId);
    if (!p) {
      p = new Promoter(adapter, catalog.getCorpusSchema(corpusId), corpusId);
      promoters.set(corpusId, p);
    }
    return p;
  }

  return {
    createCorpus(corpus: CorpusDef): CorpusDef {
      return catalog.createCorpus(corpus);
    },

    commit(
      corpusId: string,
      candidate: CandidateClaim,
      opts: { policy?: ContradictionPolicy; writer: string; idempotencyKey?: string }
    ) {
      const corpusDef = catalog.getCorpus(corpusId);
      const policy = opts.policy ?? corpusDef.defaults.contradictionPolicy;
      return promoterFor(corpusId).commit(candidate, {
        policy,
        writer: opts.writer,
        idempotencyKey: opts.idempotencyKey,
      });
    },

    query<O>(corpusId: string, pipeline: Stage<any, any>[], opts?: { evaluationClock?: number }): O {
      catalog.getCorpus(corpusId); // existence check — throws for unknown corpus
      const ctx: EvalContext = {
        adapter,
        catalog,
        evaluationClock: opts?.evaluationClock ?? Date.now(),
        usedSimilarityVersions: {},
        usedEmbeddingModelVersions: {},
      };
      return evaluate<O>(pipeline, ctx);
    },

    supersede(
      corpusId: string,
      deprecateId: string,
      replacement: CandidateClaim,
      opts: { writer: string; idempotencyKey?: string }
    ): { id: string; status: string } {
      return promoterFor(corpusId).supersede(deprecateId as any, replacement, opts);
    },

    promote(
      corpusId: string,
      targetId: string,
      to: Status,
      opts: { writer: string; reason?: string; idempotencyKey?: string }
    ): { id: string; status: string } {
      return promoterFor(corpusId).promote(targetId as any, to, opts);
    },

    read(corpusId: string, plan: ExecutionPlan): Claim[] {
      catalog.getCorpus(corpusId);
      return adapter.query({ ...plan, corpusId });
    },

    readByIds(corpusId: string, ids: ClaimId[]): Claim[] {
      catalog.getCorpus(corpusId);
      return ids.map(id => adapter.getClaim(id)).filter((c): c is Claim => c !== undefined);
    },
  };
}
