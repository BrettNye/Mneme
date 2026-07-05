/**
 * Fragmentation metric for the canon-priming benchmark arm.
 *
 * Entity fragmentation — the same real entity split across near-duplicate subjects
 * (`client:acme` vs `client:acme-corp` vs `client:acme-inc`) — is the #1 ingestion
 * failure mode and the thing canon-priming is supposed to reduce. `subjectCensus`
 * already scores near-duplicate subject pairs (`candidates`), so the metric is just:
 * count the pairs whose similarity clears a threshold. Fewer near-dup pairs ⇒ better
 * canonicalization.
 *
 * This is offline (no LLM) and deterministic given the rankFn in `deps`.
 */
import type { Session, ReadDeps } from "../../src/surface/index.js";
import { subjectCensus } from "../../src/surface/index.js";

export interface FragReport {
  corpus: string;
  distinctSubjects: number;
  /** near-duplicate subject pairs at/above `threshold`. */
  nearDupPairs: number;
  /** nearDupPairs normalized by distinct subjects — comparable across corpus sizes. */
  fragmentationRate: number;
  threshold: number;
  rankFn: string;
  /** the worst offenders, for eyeballing. */
  worst: { a: string; b: string; score: number }[];
}

export async function fragmentation(
  session: Session,
  corpus: string,
  deps: ReadDeps,
  opts: { threshold?: number; worstN?: number } = {},
): Promise<FragReport> {
  const threshold = opts.threshold ?? 0.6;
  const census = await subjectCensus(session, { corpus }, deps);
  const dup = census.candidates.filter((c) => c.score >= threshold);
  return {
    corpus,
    distinctSubjects: census.subjects.length,
    nearDupPairs: dup.length,
    fragmentationRate: dup.length / Math.max(1, census.subjects.length),
    threshold,
    rankFn: census.rankFn,
    worst: dup.slice(0, opts.worstN ?? 5),
  };
}
