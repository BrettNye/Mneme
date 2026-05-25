import type { SLOpinion } from "./subjective-logic.js";

export interface DistributionProtocol<T> {
  serialize(d: T): string;
  deserialize(b: string): T;
  canonicalize(d: T): string;
  mean(d: T): number;
  variance(d: T): number;
  toOpinion?(d: T): SLOpinion;
  fromOpinion?(o: SLOpinion): T;
  combine(ruleId: string, a: T, b: T, params?: unknown): T;
  supportedRules(): Set<string>;
  isIdempotent(ruleId: string): boolean;
}

export function assertSupportsRule<T>(binding: DistributionProtocol<T>, ruleId: string): void {
  if (!binding.supportedRules().has(ruleId)) {
    throw new Error(`rule "${ruleId}" not supported by this binding`);
  }
}
