import type { Claim } from "../../core/claim.js";
import type { Episode, BioQuery } from "../types.js";
import { MAX_DREAM_DEPTH, depthOf, isUnvalidatedDream } from "./dreaming-types.js";

export interface SelectOpts { corpusId?: string; maxInputClaims?: number; maxDepth?: number; }

export function selectDreamInput(
  read: (q: BioQuery) => Claim[],
  episode: Episode,
  opts: SelectOpts = {}
): Claim[] {
  if (episode.runIds.length === 0) return [];
  const depthCap = opts.maxDepth ?? MAX_DREAM_DEPTH;
  const pool = read({ corpusId: opts.corpusId ?? "bio", runIds: episode.runIds });
  const eligible = pool
    .filter((c) => !isUnvalidatedDream(c))          // collapse filter (primary)
    .filter((c) => depthOf(c) < depthCap);           // depth cap (backstop)
  const ranked = [...eligible].sort(
    (a, b) => b.recorded - a.recorded ||
      (b.confidence.raw ?? 0) - (a.confidence.raw ?? 0)
  );
  return ranked.slice(0, opts.maxInputClaims ?? 200);
}
