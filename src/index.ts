// Public library surface — re-export everything consumers need.

export { createMneme, sigma, tau, delta, rho, gamma, kappa, pipe, leaf, alpha, reweight, override, join } from "./mneme.js";
export { createSqliteAdapter } from "./adapters/sqlite.js";
export type { AggregateResult, AggValue, GroupKey } from "./algebra/aggregation.js";
export type { ReweightFn } from "./algebra/aggregate-join.js";
export type { BatchResult, BatchWriteResult, BatchWriteStatus, BatchPolicy } from "./write/pipeline.js";

// Binary corpus operators (pure forms) — ⊳ layered override (§4.10), ⋈ join (§4.11)
export { overrideOp } from "./algebra/override.js";
export { joinScope, joinSubject, joinEvidence } from "./algebra/join.js";

// Public core types
export type { Claim, CandidateClaim, Status, Source } from "./core/claim.js";
export type { Value } from "./core/value.js";
export type { Confidence } from "./core/confidence.js";
export type { Scope } from "./core/scope.js";
export type { Corpus as CorpusDef, DecayPolicy, ContradictionPolicy, CorpusDefaults } from "./catalog/corpus.js";
export type { ClaimSchema } from "./catalog/schema.js";
export type { TierRequirement } from "./catalog/tiers.js";
export type { Predicate } from "./algebra/predicate.js";
export type { ComposedContext, RankedCorpus, Corpus } from "./algebra/types.js";
export type { EvalContext, Stage } from "./algebra/expression.js";

// Bio layer public surface
export { createBioMemory } from "./bio/bio-memory.js";
export { createRunner } from "./bio/runner.js";
export { createMnemeGateway } from "./bio/gateway.js";
export type { MnemeGateway } from "./bio/gateway.js";
export { suppression, compose, exponentialDecay } from "./bio/policies/suppression.js";
export { evidenceUpdate } from "./bio/processes/evidence-update.js";
export type {
  BioQuery, AppendOp, AppendResult,
  EpisodeId, Episode, Signal,
  DecayPolicy as BioDecayPolicy,   // aliased: avoids clash with catalog/corpus.ts DecayPolicy
  RetrievalContext, RetrievalPolicy,
  SignalView, ProcessInput, CognitiveProcess, CycleReport,
} from "./bio/types.js";

// Dreaming public surface
export type { DreamFn, DreamInput, ProposedInsight, DreamReport } from "./bio/processes/dreaming-types.js";
export type { DreamPassOpts } from "./bio/processes/dreaming.js";
export { createDreamPass } from "./bio/processes/dreaming.js";

// Policy + consolidation public surface
export type { BioPolicy } from "./bio/policy.js";
export { DEFAULT_BIO_POLICY } from "./bio/policy.js";
export type { ConsolidationReport } from "./bio/processes/consolidation.js";
export { createConsolidatePass } from "./bio/processes/consolidation.js";

// Summarize public surface
export type { SummarizeFn, ProposedSummary, SummarizeInput, SummarizeReport } from "./bio/processes/summarize-types.js";
export { SUMMARY_WORKFLOW } from "./bio/processes/summarize-types.js";
export { createSummarizePass } from "./bio/processes/summarize.js";

// Similarity + embedding public surface
export { registerSimilarity, hybridMax, relevanceFloor, abstainBelowTop } from "./algebra/similarity.js";
export type { SimilarityFn } from "./algebra/similarity.js";
export { warmEmbeddings, cosineOver, registerEmbeddingAdapter, embeddingAdapter, EmbeddingCache } from "./algebra/embedding.js";
export type { EmbeddingAdapter } from "./algebra/embedding.js";

// Replay re-execution engine — AST
// Names that clash with the existing stage-builder exports from mneme.js are
// aliased with an "ast" prefix (leaf→astLeaf, sigma→astSigma, etc.).
export {
  leaf as astLeaf,
  sigma as astSigma,
  tau as astTau,
  delta as astDelta,
  rho as astRho,
  gamma as astGamma,
  kappa as astKappa,
  pi,
  combine,
  synthesize,
  resolve,
  aggregate,
} from "./algebra/ast.js";
export type { ExprNode } from "./algebra/ast.js";

// Replay re-execution engine — serialization
export { serializeExpr, parseExpr } from "./algebra/serialize.js";

// Replay re-execution engine — replay
export { replayStatus } from "./write/replay.js";
export type { ReplayStatus, ReplayResult } from "./write/replay.js";
