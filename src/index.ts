// Public library surface — re-export everything consumers need.

export { createMneme, sigma, tau, delta, rho, gamma, kappa, pipe, leaf } from "./mneme.js";
export { createSqliteAdapter } from "./adapters/sqlite.js";

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
