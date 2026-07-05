import { Catalog } from "./catalog/catalog.js";
import { StagingBuffer } from "./write/staging.js";
import { createCatalogFacade, type CatalogFacade } from "./catalog/catalog-facade.js";
import { AsyncPromoter } from "./write/async-pipeline.js";
import { evaluateAsync, type AsyncStage, type AsyncEvalContext } from "./algebra/async-expression.js";
import type { AsyncStorageAdapter } from "./adapters/async-adapter.js";
import type { ExecutionPlan } from "./adapters/adapter-types.js";
import type { TierRequirement } from "./catalog/tiers.js";
import type { ContradictionPolicy } from "./catalog/corpus.js";
import type { CandidateClaim, Claim, Status } from "./core/claim.js";
import type { ClaimId } from "./core/ids.js";
import type { QueryWarning } from "./algebra/value-routing.js";
import type { BatchResult, BatchPolicy } from "./write/pipeline.js";

export type { AsyncStage, AsyncEvalContext } from "./algebra/async-expression.js";

/**
 * Async twin of `MnemeOptions` (src/mneme.ts) — same shape, but `adapter` is an
 * {@link AsyncStorageAdapter}.
 */
export interface MnemeAsyncOptions {
  adapter: AsyncStorageAdapter;
  availableTiers: TierRequirement[];
}

/**
 * Async twin of `Mneme` (src/mneme.ts). Spreads the backend-agnostic
 * {@link CatalogFacade} for the sync corpus-catalog/staging methods (Catalog is
 * in-memory, so those stay synchronous) and returns Promises for every
 * storage-touching method. `replay`/`derive` are intentionally OMITTED this
 * round — out of scope for the async surface.
 */
export interface AsyncMneme extends CatalogFacade {
  commit(
    corpusId: string,
    candidate: CandidateClaim,
    opts: { policy?: ContradictionPolicy; writer: string; idempotencyKey?: string }
  ): Promise<{ id: string; status: "committed" | "rejected" | "duplicate" }>;
  /**
   * Non-atomic batch write (§7.5): commits each claim independently with per-write
   * status; an individual failure does NOT roll back earlier successes. Policy
   * defaults to the corpus's contradiction policy when omitted.
   */
  commitBatch(
    corpusId: string,
    claims: (CandidateClaim & { idempotencyKey?: string })[],
    opts: { policy?: ContradictionPolicy; writer: string; batchPolicy?: BatchPolicy }
  ): Promise<BatchResult>;
  query<O>(
    corpusId: string,
    pipeline: AsyncStage<any, any>[],
    opts?: { evaluationClock?: number; onWarning?: (w: QueryWarning) => void; fallbackWarnThreshold?: number }
  ): Promise<O>;
  supersede(
    corpusId: string,
    deprecateId: string,
    replacement: CandidateClaim,
    opts: { writer: string; idempotencyKey?: string }
  ): Promise<{ id: string; status: string }>;
  promote(
    corpusId: string,
    targetId: string,
    to: Status,
    opts: { writer: string; reason?: string; idempotencyKey?: string }
  ): Promise<{ id: string; status: string }>;
  read(corpusId: string, plan: ExecutionPlan): Promise<Claim[]>;
  readByIds(corpusId: string, ids: ClaimId[]): Promise<Claim[]>;
  /** §7.1 Promote a staged entry via the normal (async) commit pipeline. Throws for an unknown stagingId. */
  promoteStaged(stagingId: string, opts: { writer: string; policy?: ContradictionPolicy; idempotencyKey?: string }): Promise<{ id: string; status: string }>;
  /** §7.1 Promote all staged entries for a corpus via (async) commitBatch. */
  promoteAllStaged(corpusId: string, opts: { writer: string; policy?: ContradictionPolicy; batchPolicy?: BatchPolicy }): Promise<BatchResult>;
}

export function createMnemeAsync({ adapter, availableTiers }: MnemeAsyncOptions): AsyncMneme {
  const catalog = new Catalog(availableTiers);
  const staging = new StagingBuffer();
  const facade = createCatalogFacade(catalog, staging);
  const promoters = new Map<string, AsyncPromoter>();

  function scopedFor(corpusId: string): AsyncStorageAdapter {
    const s = adapter.scoped!({ corpus: corpusId });
    // Propagate the outer adapter's capabilities override (e.g. custom adapters in tests
    // may override capabilities() but still delegate scoped() to the base implementation
    // which captures the base capabilities in its closure — so we re-stamp here). Mirrors
    // the sync scopedFor in src/mneme.ts exactly.
    return { ...s, capabilities: () => adapter.capabilities() };
  }

  function promoterFor(corpusId: string): AsyncPromoter {
    let p = promoters.get(corpusId);
    if (!p) {
      p = new AsyncPromoter(scopedFor(corpusId), catalog.getCorpusSchema(corpusId), corpusId);
      promoters.set(corpusId, p);
    }
    return p;
  }

  return {
    ...facade,

    async commit(
      corpusId: string,
      candidate: CandidateClaim,
      opts: { policy?: ContradictionPolicy; writer: string; idempotencyKey?: string }
    ) {
      const corpusDef = catalog.getCorpus(corpusId); // existence check — throws for unknown corpus
      const policy = opts.policy ?? corpusDef.defaults.contradictionPolicy;
      return promoterFor(corpusId).commit(candidate, {
        policy,
        writer: opts.writer,
        idempotencyKey: opts.idempotencyKey,
      });
    },

    async commitBatch(
      corpusId: string,
      claims: (CandidateClaim & { idempotencyKey?: string })[],
      opts: { policy?: ContradictionPolicy; writer: string; batchPolicy?: BatchPolicy }
    ): Promise<BatchResult> {
      const corpusDef = catalog.getCorpus(corpusId);
      const policy = opts.policy ?? corpusDef.defaults.contradictionPolicy;
      return promoterFor(corpusId).commitBatch(claims, {
        policy,
        writer: opts.writer,
        batchPolicy: opts.batchPolicy,
      });
    },

    async query<O>(
      corpusId: string,
      pipeline: AsyncStage<any, any>[],
      opts?: { evaluationClock?: number; onWarning?: (w: QueryWarning) => void; fallbackWarnThreshold?: number }
    ): Promise<O> {
      catalog.getCorpus(corpusId); // existence check — throws for unknown corpus
      const ctx: AsyncEvalContext = {
        adapter: scopedFor(corpusId),
        catalog,
        evaluationClock: opts?.evaluationClock ?? Date.now(),
        usedSimilarityVersions: {},
        usedEmbeddingModelVersions: {},
        onWarning: opts?.onWarning,
        fallbackWarnThreshold: opts?.fallbackWarnThreshold,
      };
      return evaluateAsync<O>(pipeline, ctx);
    },

    async supersede(
      corpusId: string,
      deprecateId: string,
      replacement: CandidateClaim,
      opts: { writer: string; idempotencyKey?: string }
    ): Promise<{ id: string; status: string }> {
      return promoterFor(corpusId).supersede(deprecateId as any, replacement, opts);
    },

    async promote(
      corpusId: string,
      targetId: string,
      to: Status,
      opts: { writer: string; reason?: string; idempotencyKey?: string }
    ): Promise<{ id: string; status: string }> {
      return promoterFor(corpusId).promote(targetId as any, to, opts);
    },

    async read(corpusId: string, plan: ExecutionPlan): Promise<Claim[]> {
      catalog.getCorpus(corpusId);
      return scopedFor(corpusId).query({ ...plan, corpusId });
    },

    async readByIds(corpusId: string, ids: ClaimId[]): Promise<Claim[]> {
      catalog.getCorpus(corpusId);
      const s = scopedFor(corpusId);
      const claims = await Promise.all(ids.map((id) => s.getClaim(id)));
      return claims.filter((c): c is Claim => c !== undefined);
    },

    async promoteStaged(stagingId: string, opts: { writer: string; policy?: ContradictionPolicy; idempotencyKey?: string }): Promise<{ id: string; status: string }> {
      const e = facade.takeStaged(stagingId);
      if (!e) throw new Error(`unknown stagingId "${stagingId}"`);
      return this.commit(e.corpusId, e.candidate, { writer: opts.writer, policy: opts.policy, idempotencyKey: opts.idempotencyKey ?? e.idempotencyKey });
    },

    async promoteAllStaged(corpusId: string, opts: { writer: string; policy?: ContradictionPolicy; batchPolicy?: BatchPolicy }): Promise<BatchResult> {
      const es = facade.takeAllStaged(corpusId);
      return this.commitBatch(corpusId, es.map((e) => ({ ...e.candidate, idempotencyKey: e.idempotencyKey })), opts);
    },
  };
}
