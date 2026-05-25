import { assertSupportsRule, type DistributionProtocol } from "./protocol.js";

it("assertSupportsRule throws for an unsupported rule", () => {
  const stub = { supportedRules: () => new Set<string>() } as DistributionProtocol<number>;
  expect(() => assertSupportsRule(stub, "rule_weighted_avg")).toThrow(/not supported/);
});

it("assertSupportsRule error message names the rule", () => {
  const stub = { supportedRules: () => new Set<string>() } as DistributionProtocol<number>;
  expect(() => assertSupportsRule(stub, "rule_cumulative_fusion")).toThrow(
    /rule_cumulative_fusion/
  );
});

it("assertSupportsRule is a no-op when the rule is supported", () => {
  const stub = {
    supportedRules: () => new Set<string>(["rule_weighted_avg"]),
  } as DistributionProtocol<number>;
  expect(() => assertSupportsRule(stub, "rule_weighted_avg")).not.toThrow();
});
