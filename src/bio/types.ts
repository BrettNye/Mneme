import type { Claim, CandidateClaim, Status } from "../core/claim.js";
import type { ClaimId } from "../core/ids.js";
import type { Instant } from "../core/time.js";
import type { ExecutionPlan } from "../adapters/adapter.js";

export type BioQuery = ExecutionPlan;                 // bio reads via Mneme's existing query spec

export type AppendOp =
  | { kind: "derive"; claim: CandidateClaim }                                   // wave-2/prediction; defined for contract stability
  | { kind: "supersede"; deprecate: ClaimId; with: CandidateClaim; reason: string }
  | { kind: "promote"; target: ClaimId; to: Status; reason: string };          // wave-2; defined for contract stability

export interface AppendResult {
  applied: number;
  skipped: number;
  rejected?: { key: string; status: string }[];
  results?: { status: string }[];   // per-op outcome, aligned to the ops array order (optional)
}

export type EpisodeId = string;
export interface Episode { id: EpisodeId; runIds: string[]; startedAt: Instant; endedAt?: Instant; }

export type Signal =
  | { kind: "usage"; claimIds: ClaimId[]; episode: EpisodeId }
  | { kind: "outcome"; episode: EpisodeId; result: "success" | "failure"; weight?: number };

export type DecayPolicy = (claim: Claim, now: Instant) => number;               // effective confidence in [0,1]
export interface RetrievalContext { now: Instant; decay: DecayPolicy; episode?: Episode; persona?: string; }
export interface RetrievalPolicy { name: string; apply(claims: Claim[], ctx: RetrievalContext): Claim[]; }

export interface SignalView {                                                   // read-only slice a process sees
  usageFor(e: EpisodeId): ClaimId[];
  outcomesFor(e: EpisodeId): { result: "success" | "failure"; weight?: number }[];
  surfacedFor(e: EpisodeId): ClaimId[];
}
export interface ProcessInput { read: (q: BioQuery) => Claim[]; readByIds: (ids: ClaimId[]) => Claim[]; episode: Episode; signals: SignalView; now: Instant; }
export interface CognitiveProcess { name: string; run(input: ProcessInput): AppendOp[]; }
export interface CycleReport { opsApplied: number; claimsSuperseded: number; errors: string[]; }
