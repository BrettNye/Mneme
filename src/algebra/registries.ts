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
    public readonly name: string,
  ) {
    super(`missing ${family} rule: ${name}`);
    // Do NOT set `this.name` here — `name` is the looked-up rule name,
    // not the Error.prototype.name discriminator.
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
  const fn = RESOLUTIONS[name];
  if (!fn) throw new MissingRule("resolution", name);
  return fn;
}

const REWEIGHTS: Record<string, unknown> = {
  reweightMultiply,
  reweightMultiplyMean,
  reweightWilsonFloor,
  reweightNormalize,
  reweightBoost,
};

export function reweightRegistry(name: string): unknown {
  const fn = REWEIGHTS[name];
  if (!fn) throw new MissingRule("reweight", name);
  return fn;
}
