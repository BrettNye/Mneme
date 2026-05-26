export const RULE = {
  WEIGHTED_AVG: "rule_weighted_avg",
  EVIDENCE_POOLED: "rule_evidence_pooled",
  MAX_MEAN: "rule_max_mean",
  MAX_CONCENTRATION: "rule_max_concentration",
  DEMPSTER: "rule_dempster",
} as const;
export type RuleId = (typeof RULE)[keyof typeof RULE];
// §5.6: rule_max_confidence is removed (ambiguous mean-vs-concentration). Referencing it MUST
// throw a typed error naming BOTH replacements and stating the distinction — no silent default.
export function assertNotDeprecatedRule(ruleId: string): void {
  if (ruleId === "rule_max_confidence") {
    throw new Error(
      `rule "rule_max_confidence" is removed (ambiguous): use "rule_max_mean" ` +
        `(select by point estimate) or "rule_max_concentration" (select by evidence weight) — choose explicitly`
    );
  }
}
