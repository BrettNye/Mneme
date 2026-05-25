import type { Corpus } from "./types.js";
import { mapCorpus } from "./types.js";
import { pointEstimate } from "../core/confidence.js";
import type { DecayPolicy } from "../catalog/corpus.js";

const DAY = 86_400_000;

export function multiplier(policy: DecayPolicy, ageMs: number): number {
  ageMs = Math.max(0, ageMs);
  switch (policy.kind) {
    case "none":
      return 1;
    case "exponential":
      return Math.pow(0.5, ageMs / (policy.halfLifeDays * DAY));
    case "linear":
      return Math.max(0, 1 - policy.ratePerDay * (ageMs / DAY));
    case "step":
      return ageMs >= policy.thresholdDays * DAY ? 0 : 1;
  }
}

export const delta =
  (policy: DecayPolicy, nowMs: number) =>
  (c: Corpus): Corpus =>
    mapCorpus(c, (cl) => ({
      ...cl,
      confidence: {
        ...cl.confidence,
        effective:
          pointEstimate(cl.confidence) * multiplier(policy, nowMs - cl.recorded),
      },
    }));
