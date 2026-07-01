// TEMPORARY back-compat shim during the operations migration (deleted in Task 3).
export { recall, keyCensus, parseAsOf } from "../surface/recall.js";
export type {
  EmbeddingState, RecallDeps, RecallArgs, RecallMatch, RecallResult, CensusArgs, CensusResult,
} from "../surface/recall.js";
export { remember, ensureCorpus, listCorpora } from "../surface/remember.js";
export type { RememberArgs, RememberResult, ListResult } from "../surface/remember.js";
