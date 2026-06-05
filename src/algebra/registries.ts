import {
  resolveDeprecateLower,
  resolveDeprecateOlder,
  resolveKeepBoth,
  resolveFlagForReview,
  resolveDeprecateMinority,
  resolvePromoteConsensus,
} from "./resolution.js";
import { resolveSynthesizeBelief } from "./synthesis.js";
import {
  reweightMultiply,
  reweightMultiplyMean,
  reweightWilsonFloor,
  reweightNormalize,
  reweightBoost,
} from "./aggregate-join.js";

export class MissingRule extends Error {
  constructor(
    public readonly family: string,
    public readonly ruleName: string,
  ) {
    super(`missing ${family} rule: ${ruleName}`);
  }
}

export type ResolutionInput = "pairs" | "clusters";
export interface ResolutionEntry { fn: unknown; input: ResolutionInput; }

const RESOLUTIONS: Record<string, ResolutionEntry> = {
  resolveDeprecateLower:    { fn: resolveDeprecateLower,    input: "pairs" },
  resolveDeprecateOlder:    { fn: resolveDeprecateOlder,    input: "pairs" },
  resolveKeepBoth:          { fn: resolveKeepBoth,          input: "pairs" },
  resolveFlagForReview:     { fn: resolveFlagForReview,     input: "pairs" },
  resolveDeprecateMinority: { fn: resolveDeprecateMinority, input: "clusters" },
  resolvePromoteConsensus:  { fn: resolvePromoteConsensus,  input: "clusters" },
  resolveSynthesizeBelief:  { fn: resolveSynthesizeBelief,  input: "clusters" },
};

export function resolutionRegistry(name: string): ResolutionEntry {
  if (!Object.hasOwn(RESOLUTIONS, name)) throw new MissingRule("resolution", name);
  return RESOLUTIONS[name];
}

const REWEIGHTS: Record<string, unknown> = {
  reweightMultiply,
  reweightMultiplyMean,
  reweightWilsonFloor,
  reweightNormalize,
  reweightBoost,
};

export function reweightRegistry(name: string): unknown {
  if (!Object.hasOwn(REWEIGHTS, name)) throw new MissingRule("reweight", name);
  return REWEIGHTS[name];
}
