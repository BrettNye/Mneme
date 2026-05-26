import type { Source } from "../core/claim.js";
import type { Confidence } from "../core/confidence.js";
import { scalarToBeta, DEFAULT_PRIOR, type Prior } from "../core/confidence.js";
import { pseudocountFor, type ClaimSchema } from "../catalog/schema.js";
export { SOURCE_WEIGHT, HALF_LIFE_DAYS } from "../core/source-trust.js";

export function betaFromRaw(
  raw: number,
  source: Source,
  schema: ClaimSchema,
  prior: Prior = DEFAULT_PRIOR
): Confidence {
  const pseudocount = pseudocountFor(source, schema); // throws if undeclared
  return { distribution: "beta", parameters: scalarToBeta(raw, pseudocount, prior), raw };
}
