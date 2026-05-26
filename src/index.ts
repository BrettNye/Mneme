// Public library surface — re-export everything consumers need.

export { createMneme, sigma, tau, delta, rho, gamma, kappa, pipe, leaf, alpha, reweight } from "./mneme.js";
export { createSqliteAdapter } from "./adapters/sqlite.js";
export type { AggregateResult, AggValue, GroupKey } from "./algebra/aggregation.js";
export type { ReweightFn } from "./algebra/aggregate-join.js";

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
