import type { Claim } from "../../core/claim.js";
import type { ClaimId } from "../../core/ids.js";
import type { Key } from "../../core/key.js";
import type { Value } from "../../core/value.js";
import type { Scope } from "../../core/scope.js";
import type { Episode } from "../types.js";

export const SUMMARY_WORKFLOW = "summary";

export type SummarizeFn = (input: SummarizeInput) => Promise<ProposedSummary[]>;
export interface SummarizeInput { episode: Episode; claims: Claim[]; maxSummaries?: number; }
export interface ProposedSummary { key: Key; value: Value; scope?: Scope; cites: ClaimId[]; rationale?: string; }
export interface SummarizeReport { proposed: number; admitted: number; dropped: { key?: string; reason: string }[]; errors: string[]; }

export const isSummary = (c: Claim): boolean => c.provenance.workflow === SUMMARY_WORKFLOW;
