import { resolvePolicy, DEFAULT_BIO_POLICY } from "./policy.js";

it("resolvePolicy(undefined) deep-equals the defaults", () => {
  expect(resolvePolicy()).toEqual(DEFAULT_BIO_POLICY);
});

it("a partial override keeps sibling defaults", () => {
  const r = resolvePolicy({ consolidation: { foldThreshold: 5 } });
  expect(r.consolidation.foldThreshold).toBe(5);
  expect(r.consolidation.promoteThresholds.validated).toBe(0.65); // sibling preserved
  expect(r.evidence.outcomeWeight).toBe(2.0);                     // sibling family preserved
});

it("a dreaming.prior partial merges with default beta", () => {
  const r = resolvePolicy({ dreaming: { prior: { alpha: 2 } } });
  expect(r.dreaming.prior.alpha).toBe(2);
  expect(r.dreaming.prior.beta).toBe(3); // default beta preserved via merge (not supplied in input)
});

it("DEFAULT_BIO_POLICY has the expected pre-refactor constant values", () => {
  expect(DEFAULT_BIO_POLICY.evidence.usageWeight).toBe(0.5);
  expect(DEFAULT_BIO_POLICY.evidence.outcomeWeight).toBe(2.0);
  expect(DEFAULT_BIO_POLICY.evidence.scalarPseudocount).toBe(2);
  expect(DEFAULT_BIO_POLICY.dreaming.prior.alpha).toBe(1);
  expect(DEFAULT_BIO_POLICY.dreaming.prior.beta).toBe(3);
  expect(DEFAULT_BIO_POLICY.dreaming.maxDepth).toBe(3);
  expect(DEFAULT_BIO_POLICY.dreaming.maxInputClaims).toBe(200);
  expect(DEFAULT_BIO_POLICY.consolidation.promoteThresholds.provisional).toBe(0.5);
  expect(DEFAULT_BIO_POLICY.consolidation.promoteThresholds.validated).toBe(0.65);
  expect(DEFAULT_BIO_POLICY.consolidation.lowerBoundK).toBe(1.645);
  expect(DEFAULT_BIO_POLICY.consolidation.foldRule).toBe("rule_weighted_avg");
  expect(DEFAULT_BIO_POLICY.consolidation.foldThreshold).toBe(3);
});

it("resolves summarize defaults and merges a partial prior", () => {
  expect(resolvePolicy().summarize).toEqual(DEFAULT_BIO_POLICY.summarize);
  const r = resolvePolicy({ summarize: { prior: { alpha: 5 } } });
  expect(r.summarize.prior).toEqual({ alpha: 5, beta: 3 }); // beta kept from default
  expect(r.summarize.maxInputClaims).toBe(200);             // sibling kept
});
