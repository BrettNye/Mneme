/**
 * Resolution-layer measurement for the drift-injection arm (bench-only).
 *
 * resolveOnly = answerArmA minus the ranking tail (canonicalReadStages only),
 * so its survivors isolate RESOLUTION from RANKING. The metrics quantify the
 * "ranking tax": resolution wins (stale claim deprecated) that the jaccard
 * served top-1 fails to surface.
 *
 * Spec: docs/superpowers/specs/2026-06-17-drift-resolution-vs-served-design.md
 */
import { leaf, pipe } from "../../../src/index.js";
import type { Corpus } from "../../../src/algebra/types.js";
import type { Claim } from "../../../src/core/claim.js";
import { canonicalReadStages } from "../../../src/retrieval/read-pipeline.js";
import type { Session } from "../../../src/surface/index.js";
import { categoryOf, parseLmeInstant, type LmeQuestionT } from "../types.js";
import { evaluationInstant } from "../answer.js";

export interface ResolveOnlyOpts {
  keyCardinality?: Record<string, "single" | "multi">;
  keyAliases?: Record<string, string>;
  evidencePoolingRule?: string;
}

/** Canonical read core with NO ranking tail — answerArmA minus rankedTailStages. */
export function resolveOnly(
  session: Session, corpusId: string, q: LmeQuestionT, opts: ResolveOnlyOpts,
): readonly Claim[] {
  const t = evaluationInstant(q);
  const stages = pipe(
    leaf(corpusId),
    ...canonicalReadStages({
      evaluationInstant: t,
      keyCardinality: opts.keyCardinality,
      keyAliases: opts.keyAliases,
      evidencePoolingRule: opts.evidencePoolingRule,
    }),
  );
  return session.mneme.query<Corpus>(corpusId, stages, { evaluationClock: t }).claims;
}

/** Latest answer session by date; ties → last in answer_session_ids. Mirrors score.ts:53-75. */
export function latestAnswerSessionId(q: LmeQuestionT): string | null {
  if (q.answer_session_ids.length === 0) return null;
  const dateMap = new Map<string, number>();
  for (const s of q.sessions) dateMap.set(s.sessionId, parseLmeInstant(s.date));
  let latestId: string | null = null;
  let latestMs = -Infinity;
  for (const sid of q.answer_session_ids) {
    const ms = dateMap.get(sid);
    if (ms === undefined) continue;
    if (ms >= latestMs) { latestMs = ms; latestId = sid; }
  }
  return latestId;
}

export function sessionTagOf(c: Claim): string | null {
  const tag = c.tags.find((t) => t.startsWith("session:"));
  return tag ? tag.slice("session:".length) : null;
}

/** Scorable ⇔ KU and a lineage exists to fragment/collapse (≥2 answer sessions). */
export function isResolutionScorable(q: LmeQuestionT): boolean {
  return categoryOf(q) === "knowledge-update" && q.answer_session_ids.length >= 2;
}

/** True ⇔ no surviving claim traces to a NON-latest answer session (complete collapse). */
export function staleDeprecationCorrect(q: LmeQuestionT, survivors: readonly Claim[]): boolean | undefined {
  if (!isResolutionScorable(q)) return undefined;
  const latest = latestAnswerSessionId(q);
  if (latest === null) return undefined;
  const answerIds = new Set(q.answer_session_ids);
  for (const c of survivors) {
    const s = sessionTagOf(c);
    if (s !== null && answerIds.has(s) && s !== latest) return false;
  }
  return true;
}

/** Negative control: newest-by-valid.from survivor is on the latest session. */
export function recencyTop1Correct(q: LmeQuestionT, survivors: readonly Claim[]): boolean | undefined {
  if (!isResolutionScorable(q)) return undefined;
  const latest = latestAnswerSessionId(q);
  if (latest === null) return undefined;
  if (survivors.length === 0) return false;
  let best = survivors[0];
  for (const c of survivors) {
    if (c.valid.from > best.valid.from) best = c;
    else if (c.valid.from === best.valid.from && c.recordedSeq >= best.recordedSeq) best = c;
  }
  return sessionTagOf(best) === latest;
}

/** Per-question ranking tax: resolution succeeded but served top-1 failed. */
export function droppedByRanking(
  q: LmeQuestionT, survivors: readonly Claim[], updateCorrect: boolean | undefined,
): boolean | undefined {
  const sd = staleDeprecationCorrect(q, survivors);
  if (sd === undefined) return undefined;
  return sd === true && updateCorrect === false;
}

/** Did drift split a canonical group across keys among this question's answer-session claims? */
export function lineageFragmented(
  q: LmeQuestionT, questionClaims: readonly Claim[], aliasMap: Record<string, string>,
): boolean | undefined {
  if (!isResolutionScorable(q)) return undefined;
  const answerIds = new Set(q.answer_session_ids);
  const byCanonical = new Map<string, Set<string>>();
  for (const c of questionClaims) {
    const s = sessionTagOf(c);
    if (s === null || !answerIds.has(s)) continue;
    const canonical = aliasMap[c.key] ?? c.key;
    const set = byCanonical.get(canonical) ?? new Set<string>();
    set.add(c.key);
    byCanonical.set(canonical, set);
  }
  for (const set of byCanonical.values()) if (set.size >= 2) return true;
  return false;
}
