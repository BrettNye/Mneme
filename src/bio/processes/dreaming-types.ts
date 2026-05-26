import type { Claim } from "../../core/claim.js";
import type { ClaimId } from "../../core/ids.js";
import type { Key } from "../../core/key.js";
import type { Value } from "../../core/value.js";
import type { Scope } from "../../core/scope.js";
import type { Episode } from "../types.js";

export const DREAM_WORKFLOW = "dream";
export const MAX_DREAM_DEPTH = 3;
export const DREAM_PRIOR = { alpha: 1, beta: 3 };          // mean 0.25 — clearly subordinate

export type DreamFn = (input: DreamInput) => Promise<ProposedInsight[]>;
export interface DreamInput { episode: Episode; claims: Claim[]; maxInsights?: number; }
export interface ProposedInsight { key: Key; value: Value; scope?: Scope; cites: ClaimId[]; rationale?: string; }
export interface DreamReport { proposed: number; admitted: number; dropped: { key?: string; reason: string }[]; errors: string[]; }

export const depthTag = (n: number): string => `dream-depth:${n}`;
export function depthOf(claim: Claim): number {
  const t = claim.tags.find((x) => x.startsWith("dream-depth:"));
  if (!t) return 0;                                          // non-dream claim
  const n = Number(t.slice("dream-depth:".length));
  return Number.isFinite(n) ? n : MAX_DREAM_DEPTH;          // malformed → treat as at-cap (fail-safe: excluded from reseeding)
}
export const isUnvalidatedDream = (c: Claim): boolean =>
  c.provenance.workflow === DREAM_WORKFLOW && c.status === "candidate";
