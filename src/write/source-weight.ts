import type { Source } from "../core/claim.js";
import type { Confidence } from "../core/confidence.js";
import { scalarToBeta, DEFAULT_PRIOR, type Prior } from "../core/confidence.js";
import { pseudocountFor, type ClaimSchema } from "../catalog/schema.js";

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

export function betaFromRaw(
  raw: number,
  source: Source,
  schema: ClaimSchema,
  prior: Prior = DEFAULT_PRIOR
): Confidence {
  const pseudocount = pseudocountFor(source, schema); // throws if undeclared
  return { distribution: "beta", parameters: scalarToBeta(raw, pseudocount, prior), raw };
}
