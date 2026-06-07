// Source-trust data constants (core layer): per-source weights and confidence half-lives.
// Sibling A.1 table: DEFAULT_SCALAR_PSEUDOCOUNT (src/surface/types.ts) — per-source
// Beta pseudocounts, independently calibrated alongside the weights/half-lives here.
import type { Source } from "./claim.js";

export const SOURCE_WEIGHT: Record<Source, number> = {
  manual: 1.3,
  verification: 1.2,
  workflow: 1.0,
  heuristic: 0.9,
  llm: 0.7,
  imported: 0.6,
};

export const HALF_LIFE_DAYS: Record<Source, number> = {
  manual: 180,
  verification: 90,
  workflow: 60,
  heuristic: 30,
  llm: 14,
  imported: 60,
};
