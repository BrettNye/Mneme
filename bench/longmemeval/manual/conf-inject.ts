/**
 * Oracle confidence injection for the confidence-aware serving instrument
 * (bench-only). HI on the latest-evidence-session claim (what a perfect bio
 * layer would have learned), LO otherwise; deterministic corruption for the
 * degradation sweep. Injected AFTER resolveOnly, so it never changes the
 * survivor set — only ranking sees it.
 *
 * Spec: docs/superpowers/specs/2026-06-22-confidence-aware-serving-design.md
 */
import type { Claim } from "../../../src/core/claim.js";
import { scalarConfidence } from "../../../src/core/confidence.js";
import type { LmeQuestionT } from "../types.js";
import { latestAnswerSessionId, sessionTagOf } from "./drift-resolution-metrics.js";

export const HI = 0.95;
export const LO = 0.05;

/** Deterministic [0,1) from two strings (FNV-1a 32-bit). No clock, no RNG. */
export function seededUnit(a: string, b: string): number {
  let h = 2166136261 >>> 0;
  const s = `${a}\x1f${b}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0) / 4294967296;
}

/**
 * Oracle confidence for a survivor under quality p:
 *  - oracle value = HI if the claim traces to the latest answer session, else LO.
 *  - with prob p keep the oracle value; with prob (1−p) replace by a seeded
 *    random HI/LO draw (the degradation corruption).
 */
export function injectedConfidenceValue(claim: Claim, q: LmeQuestionT, p: number): number {
  const latest = latestAnswerSessionId(q);
  const oracle = latest !== null && sessionTagOf(claim) === latest ? HI : LO;
  if (p >= 1) return oracle;
  if (seededUnit(q.question_id, claim.id) < p) return oracle;
  return seededUnit(claim.id, q.question_id) < 0.5 ? LO : HI;
}

/** Map survivors to copies carrying the injected (scalar) confidence. */
export function injectConfidence(survivors: readonly Claim[], q: LmeQuestionT, p: number): Claim[] {
  return survivors.map((c) => ({ ...c, confidence: scalarConfidence(injectedConfidenceValue(c, q, p)) }));
}
