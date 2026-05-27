import type { Status } from "../../core/claim.js";
import type { Confidence } from "../../core/confidence.js";
import { bindingFor } from "../../distribution/registry.js";

// Local promotion-tier ranking. The substrate's LIFECYCLE_ORDER (src/write/pipeline.ts)
// is NOT exported and includes "deprecated" (a fold/terminal concern); promotion only
// climbs candidate < provisional < validated.
export const PROMOTE_TIERS: Status[] = ["candidate", "provisional", "validated"];

/**
 * Compute the Beta lower bound via the `mean − k·σ` normal approximation.
 * For scalar distributions (variance = 0), returns the mean directly.
 * Result is clamped to [0, 1].
 */
export function lowerBound(confidence: Confidence, k: number): number {
  const b = bindingFor(confidence.distribution);
  const mean = b.mean(confidence.parameters as any);
  const variance = b.variance(confidence.parameters as any);
  return Math.max(0, mean - k * Math.sqrt(variance));
}

/**
 * Map a lower-bound value to the appropriate promotion tier using inclusive
 * threshold boundaries (>=).
 */
export function tierFor(lb: number, thresholds: { provisional: number; validated: number }): Status {
  if (lb >= thresholds.validated) return "validated";
  if (lb >= thresholds.provisional) return "provisional";
  return "candidate";
}

/** Returns the ordinal rank of a promotion tier (candidate=0, provisional=1, validated=2). */
export const rankOf = (s: Status): number => PROMOTE_TIERS.indexOf(s);
