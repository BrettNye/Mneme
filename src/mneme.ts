import { Catalog } from "./catalog/catalog.js";
import { Promoter } from "./write/pipeline.js";
import type { StorageAdapter } from "./adapters/adapter.js";
import type { TierRequirement } from "./catalog/tiers.js";
import type { Corpus as CorpusDef, ContradictionPolicy } from "./catalog/corpus.js";
import type { CandidateClaim } from "./core/claim.js";
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
import { rho as rhoOp } from "./algebra/similarity.js";
import { kappa as kappaOp, type Format } from "./algebra/composition.js";
import type { Instant } from "./core/time.js";

export type { Stage, EvalContext } from "./algebra/expression.js";
export type { Format } from "./algebra/composition.js";

// ── Stage-producing builders ────────────────────────────────────────────────

export const sigma = (p: Predicate): Stage<Corpus, Corpus> => liftOp(sigmaOp(p));

export const tau = {
  now: (): Stage<Corpus, Corpus> => liftOp(tauNowOp()),
  known: (t: Instant): Stage<Corpus, Corpus> => liftOp(tauKnownOp(t)),
  valid: (t: Instant): Stage<Corpus, Corpus> => liftOp(tauValidOp(t)),
  recorded: (t: Instant): Stage<Corpus, Corpus> => liftOp(tauRecordedOp(t)),
};

export const delta = {
  exponential: (halfLifeDays: number): Stage<Corpus, Corpus> =>
    liftOp(deltaOp({ kind: "exponential", halfLifeDays }, Date.now())),
  none: (): Stage<Corpus, Corpus> =>
    liftOp(deltaOp({ kind: "none" }, Date.now())),
  linear: (ratePerDay: number): Stage<Corpus, Corpus> =>
    liftOp(deltaOp({ kind: "linear", ratePerDay }, Date.now())),
  step: (thresholdDays: number): Stage<Corpus, Corpus> =>
    liftOp(deltaOp({ kind: "step", thresholdDays }, Date.now())),
};

export const rho = {
  jaccard: (query: Value): Stage<Corpus, RankedCorpus> => liftOp(rhoOp("jaccard", query)),
  exact: (query: Value): Stage<Corpus, RankedCorpus> => liftOp(rhoOp("exact", query)),
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
  query<O>(corpusId: string, pipeline: Stage<any, any>[]): O;
}

export function createMneme({ adapter, availableTiers }: MnemeOptions): Mneme {
  const catalog = new Catalog(availableTiers);
  const promoters = new Map<string, Promoter>();

  function promoterFor(corpusId: string): Promoter {
    let p = promoters.get(corpusId);
    if (!p) {
      p = new Promoter(adapter, catalog.getCorpusSchema(corpusId));
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

    query<O>(corpusId: string, pipeline: Stage<any, any>[]): O {
      catalog.getCorpus(corpusId); // existence check — throws for unknown corpus
      const ctx: EvalContext = { adapter, catalog };
      return evaluate<O>(pipeline, ctx);
    },
  };
}
