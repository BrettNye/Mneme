import {
  resolveDeprecateLower,
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

const RESOLUTIONS: Record<string, unknown> = {
  resolveDeprecateLower,
  resolveKeepBoth,
  resolveFlagForReview,
  resolveDeprecateMinority,
  resolvePromoteConsensus,
  resolveSynthesizeBelief,
};

export function resolutionRegistry(name: string): unknown {
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
