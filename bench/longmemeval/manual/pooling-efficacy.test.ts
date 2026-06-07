/**
 * P0 property tests for the arm-P pooling instrument.
 *
 * CI-safe: no embeddings, no network, no large models.
 * MUST NOT import embeddings-local.ts or pooling-efficacy.ts.
 * Alias maps are literals.
 */
import { describe, it, expect } from "vitest";
import type { ClaimSchema } from "../../../src/catalog/schema.js";
import { bindingFor } from "../../../src/distribution/registry.js";
import { RULE } from "../../../src/distribution/rules.js";
import { betaFromRaw } from "../../../src/write/source-weight.js";
import { clustersOf } from "../../../src/algebra/contradiction.js";
import type { Corpus } from "../../../src/algebra/types.js";
import type { Claim } from "../../../src/core/claim.js";

// ---------------------------------------------------------------------------
// Shared schema fixture (source-weight.test.ts cast precedent)
// ---------------------------------------------------------------------------

const schema2 = { scalarPseudocount: { imported: 2 } } as unknown as ClaimSchema;

// ---------------------------------------------------------------------------
// P0 — hard property: exact float64 fold values
// ---------------------------------------------------------------------------

it("P0: agreeing 0.8 inputs pool to the exact float64 fold values", () => {
  // raw 0.8, pseudocount 2, prior {W:2, a:0.5}:
  //   alpha = 0.8*2 + 0.5*2 = 1.6 + 1 = 2.6
  //   beta  = 0.2*2 + 0.5*2 = 0.4 + 1 = 1.4
  const x = betaFromRaw(0.8, "imported", schema2); // Beta(2.6, 1.4) — float-exact
  expect(x.parameters.alpha).toBe(2.6);
  expect(x.parameters.beta).toBe(1.4);

  const pooled = bindingFor("beta").combine(RULE.EVIDENCE_POOLED, x.parameters, x.parameters);
  // EVIDENCE_POOLED: alpha = 2.6 + 2.6 - 0.5*2 = 5.2 - 1 = 4.2
  // EVIDENCE_POOLED: beta  = 1.4 + 1.4 - 0.5*2 = 2.8 - 1 = 1.8
  // But float64: 1.4 + 1.4 - 1 = 1.7999999999999998 (1 ulp low — registered pin)
  expect(pooled.alpha).toBe(4.2);          // rational 21/5, float-exact
  expect(pooled.beta).toBe(1.4 + 1.4 - 1); // rational 9/5; float64 = 1.7999999999999998 (1 ulp low)

  // Concentration strictly increases: 4.0 -> 6.0
  const inputConc = x.parameters.alpha + x.parameters.beta;
  const pooledConc = pooled.alpha + pooled.beta;
  expect(pooledConc).toBeGreaterThan(inputConc);
});

it("P0 below-prior: raw 0.3 pools to exactly Beta(2.2, 3.8) and brackets", () => {
  // raw 0.3, pseudocount 2, prior {W:2, a:0.5}:
  //   alpha = 0.3*2 + 1 = 1.6
  //   beta  = 0.7*2 + 1 = 2.4
  //   inputMean = 1.6/(1.6+2.4) = 0.40
  const x = betaFromRaw(0.3, "imported", schema2);
  expect(x.parameters.alpha).toBe(1.6);
  expect(x.parameters.beta).toBe(2.4);

  const inputMean = x.parameters.alpha / (x.parameters.alpha + x.parameters.beta);
  expect(inputMean).toBe(0.4);

  const pooled = bindingFor("beta").combine(RULE.EVIDENCE_POOLED, x.parameters, x.parameters);
  // EVIDENCE_POOLED: alpha = 1.6 + 1.6 - 1 = 2.2
  //                  beta  = 2.4 + 2.4 - 1 = 3.8
  expect(pooled.alpha).toBe(2.2); // rational 11/5, float-exact
  expect(pooled.beta).toBe(3.8);  // rational 19/5, float-exact

  const pooledMean = pooled.alpha / (pooled.alpha + pooled.beta);
  // Bracketing invariant: raw(0.3) < pooledMean < inputMean(0.40) — strict both ends
  expect(pooledMean).toBeGreaterThan(0.3);
  expect(pooledMean).toBeLessThan(inputMean);

  // Concentration strictly increases: 4.0 -> 6.0
  const inputConc = x.parameters.alpha + x.parameters.beta;
  const pooledConc = pooled.alpha + pooled.beta;
  expect(pooledConc).toBeGreaterThan(inputConc);
});

// ---------------------------------------------------------------------------
// P0 in-substrate: contested cluster's combinedConfidences matches binding fold
// ---------------------------------------------------------------------------

describe("P0 in-substrate: clustersOf combinedConfidences agreement", () => {
  /**
   * Contrived contested cluster:
   *   - Two claims with same-value ("val-a"), drifted keys ("employer", "job"),
   *     ratified alias: "job" -> "employer" (so they share canonical key).
   *   - One claim with different value ("val-b") on the same canonical key.
   * => clustersOf sees a contested cluster; majority group ("val-a") has 2 members.
   * The combinedConfidences for "val-a" must equal the binding-level fold.
   */

  const betaConf = (alpha: number, beta: number) => ({
    distribution: "beta" as const,
    parameters: { alpha, beta },
    raw: alpha / (alpha + beta),
  });

  // Both val-a claims use Beta(2.6, 1.4) — the 0.8/pc=2 promoted confidence
  const confA = betaConf(2.6, 1.4);

  const makeClaim = (id: string, key: string, value: string, valueHash: string, conf: typeof confA): Claim => ({
    id: id as any,
    profile: "test-profile" as any,
    workspace: "test-ws" as any,
    subject: "alice",
    key,
    scope: {},
    scopeHash: "scope-0",
    value,
    valueHash,
    confidence: conf,
    valid: { from: 0, to: Infinity },
    recorded: 0,
    recordedSeq: 0,
    status: "provisional",
    source: "imported",
    provenance: { source: "imported", recordedAt: 0, sessionId: undefined } as any,
    evidence: [],
    audience: { public: true } as any,
    tags: [],
    schema: "test-schema",
  });

  it("two same-value claims (aliased keys) vs one different-value claim", () => {
    // claim 1: key "employer", value "val-a", valueHash "vh-a"
    const c1 = makeClaim("claim-1", "employer", "val-a", "vh-a", confA);
    // claim 2: key "job" (alias for "employer"), value "val-a", valueHash "vh-a"
    const c2 = makeClaim("claim-2", "job", "val-a", "vh-a", confA);
    // claim 3: key "employer", value "val-b" (different), valueHash "vh-b"
    const c3 = makeClaim("claim-3", "employer", "val-b", "vh-b", betaConf(1.6, 2.4));

    const corpus: Corpus = { claims: [c1, c2, c3] };
    const keyAliases = { job: "employer" };

    const clusters = clustersOf(corpus, 0, { keyAliases });
    expect(clusters).toHaveLength(1);

    const cluster = clusters[0];
    // val-a group has 2 members
    expect(cluster.valueGroups.get("vh-a")).toHaveLength(2);
    expect(cluster.valueGroups.get("vh-b")).toHaveLength(1);

    // combinedConfidences for "vh-a" must match the binding-level fold exactly
    const inSubstrate = cluster.combinedConfidences.get("vh-a");
    expect(inSubstrate).toBeDefined();

    const bindingLevel = bindingFor("beta").combine(
      RULE.EVIDENCE_POOLED,
      confA.parameters,
      confA.parameters,
    );
    expect(inSubstrate!.parameters).toEqual(bindingLevel);
    expect(inSubstrate!.distribution).toBe("beta");
  });
});
