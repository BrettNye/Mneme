import type { TierRequirement } from "./tiers.js";
import type { ClaimSchema } from "./schema.js";
import type { Status } from "../core/claim.js";

export type DecayPolicy =
  | { kind: "none" }
  | { kind: "exponential"; halfLifeDays: number }
  | { kind: "linear"; ratePerDay: number }
  | { kind: "step"; thresholdDays: number };

export type ContradictionPolicy =
  | { kind: "always_accept" }
  | { kind: "reject_on_contradiction" }
  | { kind: "accept_but_mark" }
  | { kind: "accept_and_resolve"; rule: "deprecate_lower" | "keep_newer" };

export interface CorpusDefaults {
  decayPolicy: DecayPolicy;
  confidenceThreshold: number;
  contradictionPolicy: ContradictionPolicy;
  defaultStatus: Status[];
}

export interface Corpus {
  id: string;
  displayName: string;
  schema: ClaimSchema;
  defaults: CorpusDefaults;
  requiredTiers: TierRequirement[];
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}
