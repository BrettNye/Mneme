import { assertNotDeprecatedRule, RULE } from "./rules.js";
it("rejects the removed rule_max_confidence naming both replacements", () => {
  expect(() => assertNotDeprecatedRule("rule_max_confidence")).toThrow(/rule_max_mean/);
  expect(() => assertNotDeprecatedRule("rule_max_confidence")).toThrow(/rule_max_concentration/);
  expect(() => assertNotDeprecatedRule(RULE.WEIGHTED_AVG)).not.toThrow();
});
