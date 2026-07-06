/**
 * explainRecall — read-provenance for `recall`. Re-derives the SAME pipeline recall
 * composes, stage-by-stage, and attributes each candidate claim's disposition. Best-effort:
 * never throws for a re-derive failure — accumulates `warnings` and returns a partial trace.
 * recall() is untouched → zero hot-path cost. Consistency with the real pipeline is guarded
 * by the served-set invariant test in explain.test.ts.
 */
import type { RankedCorpus } from "../index.js";
import { pipe, leaf } from "../mneme.js";
import type { Session } from "./types.js";
import {
  parseAsOf,
  loadAliasContext,
  buildFilterPlan,
  buildRecallRanker,
  warmRecallValues,
  MCP_EVIDENCE_POOLING_RULE,
  type RecallArgs,
  type RecallDeps,
} from "./recall.js";
import { resolveKeyCardinality } from "./cardinality.js";
import { keyFamilyOf, isKeyAliasShaped } from "../retrieval/key-alias.js";
import { canonicalReadStages, DEDUPE_DEFAULTS } from "../retrieval/read-pipeline.js";
import { dedupeGroups } from "../algebra/combination.js";
import { pairsOf } from "../algebra/contradiction.js";
import { CONTRADICTION_FLAG_KEY } from "../algebra/resolution.js";
import { abstainBelowTop, relevanceFloor } from "../algebra/similarity.js";
import type { Corpus as AlgebraCorpus } from "../algebra/types.js";
import type { Claim } from "../core/claim.js";
import type { DispositionReason } from "./belief-change.js";

// MOVED to belief-change.ts (charter vocabulary home); re-exported here for back-compat.
export type { DispositionReason } from "./belief-change.js";

export interface ClaimDisposition {
  id: string;
  subject: string;
  key: string;
  disposition: "served" | "merged" | "deprecated" | "dropped";
  reason: DispositionReason;
  score?: number;
}

export interface RecallTrace {
  corpus: string;
  candidateCount: number;
  stageCounts: {
    afterTau: number;
    afterDedupe: number;
    afterContradiction: number;
    ranked: number;
    afterKnobs: number;
    served: number;
  };
  claims: ClaimDisposition[];
  warnings?: string[];
}

export async function explainRecall(
  session: Session,
  args: RecallArgs,
  deps: RecallDeps,
): Promise<RecallTrace> {
  const warnings: string[] = [];
  const embeddings = deps.embeddings;
  // Resolve per-corpus effective cardinality (schema declaration over deps), exactly as
  // recall/census/reconcile do — otherwise explain's served set diverges from recall's on a
  // schema-declared key, breaking the consistency invariant. Safe on unknown corpus (returns deps map).
  const keyCardinality = resolveKeyCardinality(session, args.corpus, deps.keyCardinality);
  const limit = args.limit ?? 5;

  const empty: RecallTrace = {
    corpus: args.corpus,
    candidateCount: 0,
    stageCounts: { afterTau: 0, afterDedupe: 0, afterContradiction: 0, ranked: 0, afterKnobs: 0, served: 0 },
    claims: [],
  };

  // Read-only: unknown corpus → empty trace (mirror recall's early return; never create it).
  if (!session.listCorpora().some((c) => c.id === args.corpus)) return empty;

  // Best-effort re-derivation: never throws. Any failure here (bad asOf, a query stage
  // erroring, etc.) degrades to a partial trace with a warning instead of propagating.
  try {
    const now = parseAsOf(args.asOf) ?? Date.now();
    const { aliasMap, warnings: aliasWarnings } = loadAliasContext(session, args.corpus, now, keyCardinality);
    warnings.push(...aliasWarnings);
    const family = args.key ? keyFamilyOf(args.key, aliasMap) : undefined;

    try {
      await warmRecallValues(session, args, embeddings, family);
    } catch (err) {
      warnings.push(`warm-up failed — scores may differ from recall: ${err instanceof Error ? err.message : String(err)}`);
    }

    const { sigmas, hints } = buildFilterPlan(args, family);
    const canon = canonicalReadStages({
      evaluationInstant: now,
      keyCardinality,
      keyAliases: aliasMap,
      evidencePoolingRule: MCP_EVIDENCE_POOLING_RULE,
    });
    const ranker = buildRecallRanker(args, embeddings.rankFn);
    const clock = { evaluationClock: now };

    // Re-derive stage-by-stage (recall() untouched). canon = [τ_valid, ⊕_dedupe, ⊥/resolve, drop].
    const afterSigma = session.mneme.query<AlgebraCorpus>(args.corpus, pipe(leaf(args.corpus, hints), ...sigmas), clock);
    const afterTau = session.mneme.query<AlgebraCorpus>(args.corpus, pipe(leaf(args.corpus, hints), ...sigmas, canon[0]), clock);
    const afterDedupe = session.mneme.query<AlgebraCorpus>(args.corpus, pipe(leaf(args.corpus, hints), ...sigmas, canon[0], canon[1]), clock);
    const afterDrop = session.mneme.query<AlgebraCorpus>(args.corpus, pipe(leaf(args.corpus, hints), ...sigmas, canon[0], canon[1], canon[2], canon[3]), clock);
    const ranked = session.mneme.query<RankedCorpus>(args.corpus, pipe(leaf(args.corpus, hints), ...sigmas, ...canon, ranker), clock);

    const idSet = (c: { claims: readonly Claim[] }) => new Set(c.claims.map((cl) => cl.id));
    const tauIds = idSet(afterTau);
    const dedupeIds = idSet(afterDedupe);
    const dropIds = idSet(afterDrop);

    // merged-into: run the identical dedupe to recover which survivor absorbed each merged claim.
    let mergedInto = new Map<string, string>();
    try {
      mergedInto = dedupeGroups(DEDUPE_DEFAULTS.rule, undefined, {
        similarity: { fn: DEDUPE_DEFAULTS.fn, cutoff: DEDUPE_DEFAULTS.cutoff },
      })(afterTau).mergedInto;
    } catch (err) {
      warnings.push(`merge attribution failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // deprecated-by: same ⊥ opts as canon[2]. resolveDeprecateOlder deprecates the OLDER
    // (smaller valid.from) member of each value-difference pair; ties survive (flagged), not deprecated.
    // A claim can lose several pairs → attribute to the NEWEST winner (max valid.from; id-asc tie-break).
    // NOTE: in a transitive A→B→C deprecation chain, `byId` names the direct pairwise winner,
    // which may itself be deprecated by a later claim — the loser's disposition is always
    // correct, but this winner label can be imprecise (best-effort debug field only).
    const deprecatedBy = new Map<string, string>();
    try {
      const byId = new Map<string, Claim>();
      for (const cl of afterDedupe.claims) byId.set(cl.id, cl);
      const pairs = pairsOf(afterDedupe, 0, {
        keyCardinality,
        keyAliases: aliasMap,
        evidencePoolingRule: MCP_EVIDENCE_POOLING_RULE,
      });
      for (const p of pairs) {
        if (p.left.valid.from === p.right.valid.from) continue; // tie → not deprecated
        const older = p.left.valid.from < p.right.valid.from ? p.left : p.right;
        const newer = p.left.valid.from < p.right.valid.from ? p.right : p.left;
        const cur = deprecatedBy.get(older.id);
        if (cur === undefined) { deprecatedBy.set(older.id, newer.id); continue; }
        const curClaim = byId.get(cur);
        const curFrom = curClaim ? curClaim.valid.from : -Infinity;
        if (newer.valid.from > curFrom || (newer.valid.from === curFrom && newer.id < cur)) {
          deprecatedBy.set(older.id, newer.id);
        }
      }
    } catch (err) {
      warnings.push(`deprecation attribution failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Ranking + knobs (identical to recall).
    const scoreById = new Map<string, number>();
    for (const s of ranked.scored) scoreById.set(s.claim.id, s.score);
    const topScore = ranked.scored[0]?.score;

    const abstainThreshold = args.abstainBelowTop ?? 0;
    const floorThreshold = args.relevanceFloor ?? 0;
    const afterAbstain = abstainBelowTop(abstainThreshold)(ranked);
    const abstained = ranked.scored.length > 0 && afterAbstain.scored.length === 0 && abstainThreshold > 0;
    const knobbed = relevanceFloor(floorThreshold)(afterAbstain);

    const knobbedIds = new Set(knobbed.scored.map((s) => s.claim.id));
    const rankIndex = new Map<string, number>();
    knobbed.scored.forEach((s, i) => rankIndex.set(s.claim.id, i));
    const servedIds = new Set(knobbed.scored.slice(0, limit).map((s) => s.claim.id));

    // Attribute each candidate to the FIRST stage it exited at (sequential pipeline → one disposition each).
    const claims: ClaimDisposition[] = afterSigma.claims.map((cl) => {
      const base = { id: cl.id, subject: cl.subject, key: cl.key };
      if (!tauIds.has(cl.id)) return { ...base, disposition: "dropped", reason: { kind: "tau-invalid" } };
      if (!dedupeIds.has(cl.id)) {
        return { ...base, disposition: "merged", reason: { kind: "merged-into", targetId: mergedInto.get(cl.id) ?? "" } };
      }
      if (!dropIds.has(cl.id)) {
        if (isKeyAliasShaped(cl) || cl.key === CONTRADICTION_FLAG_KEY) {
          return { ...base, disposition: "dropped", reason: { kind: "alias-or-flag" } };
        }
        return { ...base, disposition: "deprecated", reason: { kind: "deprecated-by", byId: deprecatedBy.get(cl.id) ?? "", via: "single-cardinality" } };
      }
      // reached ranking
      const score = scoreById.get(cl.id);
      if (abstained) return { ...base, disposition: "dropped", reason: { kind: "abstained", topScore: topScore ?? 0, threshold: abstainThreshold }, score };
      if (!knobbedIds.has(cl.id)) return { ...base, disposition: "dropped", reason: { kind: "below-floor", score: score ?? 0, floor: floorThreshold }, score };
      if (!servedIds.has(cl.id)) return { ...base, disposition: "dropped", reason: { kind: "over-limit", rank: rankIndex.get(cl.id) ?? -1, limit }, score };
      return { ...base, disposition: "served", reason: { kind: "served" }, score };
    });

    return {
      corpus: args.corpus,
      candidateCount: afterSigma.claims.length,
      stageCounts: {
        afterTau: afterTau.claims.length,
        afterDedupe: afterDedupe.claims.length,
        afterContradiction: afterDrop.claims.length,
        ranked: ranked.scored.length,
        afterKnobs: knobbed.scored.length,
        served: Math.min(knobbed.scored.length, limit),
      },
      claims,
      warnings: warnings.length ? warnings : undefined,
    };
  } catch (err) {
    warnings.push(`re-derivation failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ...empty, corpus: args.corpus, warnings };
  }
}
