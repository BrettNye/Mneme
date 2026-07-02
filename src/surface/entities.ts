/**
 * entities.ts — shared read primitive consumed by both keyCensus and reconcile.
 *
 * Enumerate the corpus's LIVE distinct subjects/keys over canonicalReadStages
 * (the same live-set semantics as keyCensus: τ_valid → ⊕_dedupe → ⊥/resolveDeprecateOlder
 * → drop deprecated + flags + alias-shaped claims), plus a warm-then-score helper
 * mirroring keyCensus's key-pair scoring shape.
 */
import type { Session, ReadDeps } from "./types.js";
import type { Claim } from "../core/claim.js";
import type { Corpus } from "../algebra/types.js";
import type { EvalContext } from "../algebra/expression.js";
import type { KeyAliasMap } from "../retrieval/key-alias.js";
import { canonicalReadStages } from "../retrieval/read-pipeline.js";
import { similarityFn } from "../algebra/similarity.js";
import { warmValues } from "../algebra/embedding.js";
import { MCP_EVIDENCE_POOLING_RULE } from "./recall.js";

export type EntityAxis = "subject" | "key";
export interface DistinctEntity { value: string; claims: number }

/** Live distinct entities on `axis`, over canonicalReadStages (same live-set semantics as
 *  keyCensus). `aliasMap` AND `now` are passed in (not recomputed) so a single evaluation
 *  instant is shared with the caller's alias load — matching keyCensus's single-`now`
 *  behavior (recall.ts); recomputing `Date.now()` here would diverge on a tauValid boundary. */
export function distinctEntities(
  session: Session, corpus: string, axis: EntityAxis, deps: ReadDeps, aliasMap: KeyAliasMap, now: number,
): DistinctEntity[] {
  let live: Corpus = { claims: session.mneme.read(corpus, { corpusId: corpus }) as Claim[] };
  for (const stage of canonicalReadStages({
    evaluationInstant: now, keyCardinality: deps.keyCardinality,
    keyAliases: aliasMap, evidencePoolingRule: MCP_EVIDENCE_POOLING_RULE,
  })) live = stage(live, {} as EvalContext) as Corpus;

  const counts = new Map<string, number>();
  for (const c of live.claims) {
    const v = axis === "subject" ? c.subject : c.key;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, claims]) => ({ value, claims }))
    .sort((a, b) => b.claims - a.claims || a.value.localeCompare(b.value));
}

/** Warm the given strings (hybrid) then return a scorer; jaccard fallback on warm failure. */
export async function entityScorer(
  strings: string[], deps: ReadDeps,
): Promise<{ rankFn: string; warnings: string[]; scoreOne: (a: string, b: string) => number }> {
  const warnings: string[] = [];
  let rankFn = deps.embeddings.rankFn;
  let scorer = similarityFn(rankFn);
  if (rankFn !== "jaccard" && deps.embeddings.adapter && deps.embeddings.cache) {
    try {
      await warmValues(deps.embeddings.adapter, deps.embeddings.cache, strings as unknown[], []);
    } catch (e) {
      warnings.push(`entity warm-up failed — jaccard fallback: ${e instanceof Error ? e.message : String(e)}`);
      scorer = similarityFn("jaccard"); rankFn = "jaccard";
    }
  }
  return { rankFn, warnings, scoreOne: (a, b) => scorer.scoreOne(a, b) };
}
