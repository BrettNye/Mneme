import type { Claim } from "../../core/claim.js";
import type { Episode, BioQuery } from "../types.js";
import { isSummary } from "./summarize-types.js";
import { DEFAULT_BIO_POLICY } from "../policy.js";

export interface SummarizeSelectOpts { corpusId?: string; maxInputClaims?: number; }

export function selectSummarizeInput(
  read: (q: BioQuery) => Claim[],
  episode: Episode,
  opts: SummarizeSelectOpts = {}
): Claim[] {
  // Guard: empty runIds would be an unfiltered whole-corpus read — return early without calling read
  if (episode.runIds.length === 0) return [];
  const corpusId = opts.corpusId ?? "bio";
  const max = opts.maxInputClaims ?? DEFAULT_BIO_POLICY.summarize.maxInputClaims;
  const claims = read({ corpusId, runIds: episode.runIds } as BioQuery)
    .filter((c) => c.status !== "deprecated" && !isSummary(c)); // exclude deprecated + prior summaries (collapse guard)
  return [...claims]
    .sort((a, b) =>
      b.recorded - a.recorded ||
      (b.confidence.raw ?? 0) - (a.confidence.raw ?? 0)
    )
    .slice(0, max);
}
