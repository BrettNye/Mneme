import { Catalog } from "./catalog/catalog.js";
import { Promoter } from "./write/pipeline.js";
import { StagingBuffer } from "./write/staging.js";
import { replayStatus, type ReplayResult } from "./write/replay.js";
import { deriveClaimFrom } from "./write/derive.js";
import { commitDerived } from "./write/derived-write.js";
import type { ExprNode } from "./algebra/ast.js";
import type { Scope } from "./core/scope.js";
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
import { routeValuePredicates, type QueryWarning } from "./algebra/value-routing.js";
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
import { override as overrideBuilder } from "./algebra/override.js";
import { joinScopeWith, joinSubjectWith, joinEvidenceWith } from "./algebra/join.js";
import type { BatchResult, BatchPolicy } from "./write/pipeline.js";

export type { Stage, EvalContext } from "./algebra/expression.js";
export type { Format } from "./algebra/composition.js";
export type { QueryWarning } from "./algebra/value-routing.js";

/**
 * Default working-set size above which a `fallback_in_memory` value predicate emits a
 * §10.2 warning. Applied by the query/sigma layer when `EvalContext.fallbackWarnThreshold`
 * is unset (EvalContext itself enforces no default — see expression.ts).
 */
export const DEFAULT_FALLBACK_WARN_THRESHOLD = 10_000;

// ── Stage-producing builders ────────────────────────────────────────────────

export const sigma = (p: Predicate): Stage<Corpus, Corpus> => (c, ctx) => {
  routeValuePredicates(p, ctx.adapter.capabilities(), {
    workingSetSize: c.claims.length,
    threshold: ctx.fallbackWarnThreshold ?? DEFAULT_FALLBACK_WARN_THRESHOLD,
    onWarning: ctx.onWarning ?? ((w) => console.warn(w.message)),
  });
  return sigmaOp(p)(c);
};

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

// ── Binary corpus operators (⊳ layered override §4.10, ⋈ join §4.11) ──────────
// Each takes its right operand as a sub-pipeline evaluated in the same ctx, so it
// composes inside pipe(): pipe(leaf(c1), sigma(...), override(pipe(leaf(c2), ...))).

/** ⊳ layered override: the piped (left) corpus dominates `right` on matching (subject,key,scope) triples. */
export const override = overrideBuilder;

/** ⋈ join: collect the related claims from the piped (left) corpus and a `right` sub-pipeline. */
export const join = {
  scope: joinScopeWith,
  subject: joinSubjectWith,
  evidence: joinEvidenceWith,
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
  /** Remove a corpus from the catalog registry (§6.1). Throws for an unknown corpus. */
  deleteCorpus(corpusId: string): void;
  /** List registered corpora (§6.2), optionally narrowed by a predicate. */
  listCorpora(filter?: (c: CorpusDef) => boolean): CorpusDef[];
  commit(
    corpusId: string,
    candidate: CandidateClaim,
    opts: { policy?: ContradictionPolicy; writer: string; idempotencyKey?: string }
  ): { id: string; status: "committed" | "rejected" | "duplicate" };
  /**
   * Non-atomic batch write (§7.5): commits each claim independently with per-write
   * status; an individual failure does NOT roll back earlier successes. Policy
   * defaults to the corpus's contradiction policy when omitted.
   */
  commitBatch(
    corpusId: string,
    claims: (CandidateClaim & { idempotencyKey?: string })[],
    opts: { policy?: ContradictionPolicy; writer: string; batchPolicy?: BatchPolicy }
  ): BatchResult;
  query<O>(corpusId: string, pipeline: Stage<any, any>[], opts?: { evaluationClock?: number; onWarning?: (w: QueryWarning) => void; fallbackWarnThreshold?: number }): O;
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
  /**
   * Verify a derived claim by re-executing its recorded query against the current
   * store, threading this instance's adapter and catalog. Returns the §7.6 replay
   * status (`exact`/`mismatch`/`missing_inputs`/`unavailable_models`/`integrity_unknown`/`failed`).
   */
  replay(claim: Claim): ReplayResult;
  /**
   * Derive and commit a claim from an algebra expression, recording the serialized query
   * as provenance so it can later be re-executed via `replay`. Threads this instance's
   * adapter / catalog / corpus promoter.
   *
   * For `replay` to return `exact`, choose a query that does NOT re-select the derived
   * claim itself (e.g. derive under a `key` the query's predicate excludes) — otherwise
   * re-execution includes the derived claim and the comparison may mismatch.
   */
  derive(
    corpusId: string,
    expr: ExprNode,
    opts: {
      subject: string;
      key: string;
      scope: Scope;
      writer: string;
      evaluationClock?: number;
      combination?: string;
      policy?: ContradictionPolicy;
      idempotencyKey?: string;
    },
  ): { id: string; status: string };
  /** §7.1 Stage a candidate without committing it. Throws for an unknown corpus. */
  emitCandidate(corpusId: string, candidate: CandidateClaim, opts?: { idempotencyKey?: string }): { stagingId: string };
  /** §7.1 Promote a staged entry via the normal commit pipeline. Throws for an unknown stagingId. */
  promoteStaged(stagingId: string, opts: { writer: string; policy?: ContradictionPolicy; idempotencyKey?: string }): { id: string; status: string };
  /** §7.1 Promote all staged entries for a corpus via commitBatch. */
  promoteAllStaged(corpusId: string, opts: { writer: string; policy?: ContradictionPolicy; batchPolicy?: BatchPolicy }): BatchResult;
  /** §7.1 List staged entries, optionally filtered by corpusId. */
  listStaged(corpusId?: string): { stagingId: string; corpusId: string }[];
  /** §7.1 Discard a staged entry without committing. Returns true if found, false if absent. */
  discardStaged(stagingId: string): boolean;
}

export function createMneme({ adapter, availableTiers }: MnemeOptions): Mneme {
  const catalog = new Catalog(availableTiers);
  const promoters = new Map<string, Promoter>();
  const staging = new StagingBuffer();

  function scopedFor(corpusId: string): StorageAdapter {
    const s = adapter.scoped!({ corpus: corpusId });
    // Propagate the outer adapter's capabilities override (e.g. custom adapters in tests
    // may override capabilities() but still delegate scoped() to the base implementation
    // which captures the base capabilities in its closure — so we re-stamp here).
    return { ...s, capabilities: () => adapter.capabilities() };
  }

  function promoterFor(corpusId: string): Promoter {
    let p = promoters.get(corpusId);
    if (!p) {
      p = new Promoter(scopedFor(corpusId), catalog.getCorpusSchema(corpusId), corpusId);
      promoters.set(corpusId, p);
    }
    return p;
  }

  return {
    createCorpus(corpus: CorpusDef): CorpusDef {
      return catalog.createCorpus(corpus);
    },

    deleteCorpus(corpusId: string): void {
      catalog.deleteCorpus(corpusId); // throws for unknown corpus
      promoters.delete(corpusId);     // drop the cached promoter for the removed corpus
    },

    listCorpora(filter?: (c: CorpusDef) => boolean): CorpusDef[] {
      return catalog.listCorpora(filter);
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

    commitBatch(
      corpusId: string,
      claims: (CandidateClaim & { idempotencyKey?: string })[],
      opts: { policy?: ContradictionPolicy; writer: string; batchPolicy?: BatchPolicy }
    ): BatchResult {
      const corpusDef = catalog.getCorpus(corpusId);
      const policy = opts.policy ?? corpusDef.defaults.contradictionPolicy;
      return promoterFor(corpusId).commitBatch(claims, {
        policy,
        writer: opts.writer,
        batchPolicy: opts.batchPolicy,
      });
    },

    query<O>(corpusId: string, pipeline: Stage<any, any>[], opts?: { evaluationClock?: number; onWarning?: (w: QueryWarning) => void; fallbackWarnThreshold?: number }): O {
      catalog.getCorpus(corpusId); // existence check — throws for unknown corpus
      const ctx: EvalContext = {
        adapter: scopedFor(corpusId),
        catalog,
        evaluationClock: opts?.evaluationClock ?? Date.now(),
        usedSimilarityVersions: {},
        usedEmbeddingModelVersions: {},
        onWarning: opts?.onWarning,
        fallbackWarnThreshold: opts?.fallbackWarnThreshold,
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
      return scopedFor(corpusId).query({ ...plan, corpusId });
    },

    readByIds(corpusId: string, ids: ClaimId[]): Claim[] {
      catalog.getCorpus(corpusId);
      const s = scopedFor(corpusId);
      return ids.map(id => s.getClaim(id)).filter((c): c is Claim => c !== undefined);
    },

    replay(claim: Claim): ReplayResult {
      // Derive the corpus from claim.workspace (== corpusId by convention throughout this codebase)
      const corpusId = claim.workspace as unknown as string;
      return replayStatus(claim, scopedFor(corpusId), catalog);
    },

    derive(
      corpusId: string,
      expr: ExprNode,
      opts: {
        subject: string;
        key: string;
        scope: Scope;
        writer: string;
        evaluationClock?: number;
        combination?: string;
        policy?: ContradictionPolicy;
        idempotencyKey?: string;
      },
    ): { id: string; status: string } {
      catalog.getCorpus(corpusId); // existence check — throws for unknown corpus
      const candidate = deriveClaimFrom(adapter, catalog, expr, {
        subject: opts.subject,
        key: opts.key,
        scope: opts.scope,
        combination: opts.combination,
        evaluationClock: opts.evaluationClock,
      });
      const df = candidate.provenance!.derivedFrom!; // deriveClaimFrom always sets this
      return commitDerived(promoterFor(corpusId), candidate, {
        queryExpression: df.queryExpression,
        corpusState: df.corpusState,
        writer: opts.writer,
        policy: opts.policy,
        idempotencyKey: opts.idempotencyKey,
      });
    },

    emitCandidate(corpusId: string, candidate: CandidateClaim, opts?: { idempotencyKey?: string }): { stagingId: string } {
      catalog.getCorpus(corpusId); // throws for unknown corpus
      return { stagingId: staging.emit(corpusId, candidate, opts?.idempotencyKey) };
    },

    promoteStaged(stagingId: string, opts: { writer: string; policy?: ContradictionPolicy; idempotencyKey?: string }): { id: string; status: string } {
      const e = staging.take(stagingId);
      if (!e) throw new Error(`unknown stagingId "${stagingId}"`);
      return this.commit(e.corpusId, e.candidate, { writer: opts.writer, policy: opts.policy, idempotencyKey: opts.idempotencyKey ?? e.idempotencyKey });
    },

    promoteAllStaged(corpusId: string, opts: { writer: string; policy?: ContradictionPolicy; batchPolicy?: BatchPolicy }): BatchResult {
      const es = staging.takeAll(corpusId);
      return this.commitBatch(corpusId, es.map((e) => ({ ...e.candidate, idempotencyKey: e.idempotencyKey })), opts);
    },

    listStaged(corpusId?: string) { return staging.list(corpusId); },

    discardStaged(stagingId: string): boolean { return staging.discard(stagingId); },
  };
}
