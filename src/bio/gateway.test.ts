import { createMnemeGateway, type MnemeGateway } from "./gateway.js";
import { makeBioMneme } from "./test-support.js";
import { newClaimId } from "../core/ids.js";
import { INFINITY } from "../core/time.js";
import type { CandidateClaim } from "../core/claim.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCandidateClaim(overrides: Partial<CandidateClaim> = {}): CandidateClaim {
  return {
    profile: "p1" as any,
    workspace: "w1" as any,
    subject: "test-subject",
    key: "test-key",
    scope: {},
    value: "test-value",
    confidence: { distribution: "scalar", parameters: { p: 0.9 }, raw: 0.9 },
    valid: { from: 0, to: INFINITY },
    status: "validated",
    source: "manual",
    provenance: { runId: "run-1" } as any,
    evidence: [],
    tags: [],
    schema: "text",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Interface compile-time check: no update/delete on the type
// ---------------------------------------------------------------------------

it("MnemeGateway interface has no update or delete methods (append-only enforcement)", () => {
  const { mneme, corpusId } = makeBioMneme();
  const gw = createMnemeGateway(mneme, corpusId);
  expect("update" in gw).toBe(false);
  expect("delete" in gw).toBe(false);
  expect("deleteClaim" in gw).toBe(false);
});

// ---------------------------------------------------------------------------
// derive → mneme.commit: claim lands in corpus
// ---------------------------------------------------------------------------

it("derive routes through mneme.commit and lands a claim in the corpus", () => {
  const { mneme, corpusId } = makeBioMneme();
  const gw = createMnemeGateway(mneme, corpusId);

  const res = gw.apply(
    [{ kind: "derive", claim: makeCandidateClaim({ subject: "derive-test" }) }],
    () => "k1"
  );

  expect(res.applied).toBe(1);
  expect(res.skipped).toBe(0);

  // Claim is readable via gw.read
  const claims = gw.read({ corpusId, subject: "derive-test" });
  expect(claims.length).toBe(1);
  expect(claims[0].subject).toBe("derive-test");
});

// ---------------------------------------------------------------------------
// read / readByIds delegate to mneme.read / mneme.readByIds
// ---------------------------------------------------------------------------

it("read delegates to mneme.read and returns claims matching query", () => {
  const { mneme, corpusId } = makeBioMneme();
  const gw = createMnemeGateway(mneme, corpusId);

  gw.apply(
    [{ kind: "derive", claim: makeCandidateClaim({ subject: "read-test" }) }],
    (_op, i) => `read-key-${i}`
  );

  const results = gw.read({ corpusId, subject: "read-test" });
  expect(results.length).toBe(1);
  expect(results[0].subject).toBe("read-test");
});

it("readByIds returns claims for present ids and omits missing ids", () => {
  const { mneme, corpusId } = makeBioMneme();
  const gw = createMnemeGateway(mneme, corpusId);

  gw.apply(
    [{ kind: "derive", claim: makeCandidateClaim({ subject: "rbi-test" }) }],
    (_op, i) => `rbi-${i}`
  );

  const all = gw.read({ corpusId, subject: "rbi-test" });
  const id = all[0].id;

  const fakeId = newClaimId();
  const found = gw.readByIds([id, fakeId]);
  expect(found.length).toBe(1);
  expect(found[0].id).toBe(id);
});

// ---------------------------------------------------------------------------
// supersede → mneme.supersede: old deprecated, new replacement readable
// ---------------------------------------------------------------------------

it("supersede marks old claim as deprecated and creates a new replacement", () => {
  const { mneme, corpusId } = makeBioMneme();
  const gw = createMnemeGateway(mneme, corpusId);

  // Insert original
  gw.apply(
    [{ kind: "derive", claim: makeCandidateClaim({ subject: "sup-test", value: "original" }) }],
    (_op, i) => `sup-orig-${i}`
  );
  const originals = gw.read({ corpusId, subject: "sup-test" });
  expect(originals.length).toBe(1);
  const originalId = originals[0].id;

  // Supersede it
  const supResult = gw.apply(
    [
      {
        kind: "supersede",
        deprecate: originalId,
        with: makeCandidateClaim({ subject: "sup-test", value: "replacement" }),
        reason: "test supersede",
      },
    ],
    (_op, i) => `sup-new-${i}`
  );
  expect(supResult.applied).toBe(1);

  // Old claim deprecated, new replacement present
  const deprecated = gw.readByIds([originalId]);
  expect(deprecated.length).toBe(1);
  expect(deprecated[0].status).toBe("deprecated");
  expect(deprecated[0].value).toEqual("original");

  const replacements = gw.read({ corpusId, subject: "sup-test", status: ["validated"] });
  expect(replacements.length).toBe(1);
  expect(replacements[0].id).not.toBe(originalId);
  expect(replacements[0].value).toBe("replacement");
});

// ---------------------------------------------------------------------------
// promote → mneme.promote: status changes
// ---------------------------------------------------------------------------

it("promote changes a claim's status via mneme.promote", () => {
  const { mneme, corpusId } = makeBioMneme();
  const gw = createMnemeGateway(mneme, corpusId);

  gw.apply(
    [{ kind: "derive", claim: makeCandidateClaim({ subject: "prom-test", status: "candidate" }) }],
    (_op, i) => `prom-orig-${i}`
  );
  const [original] = gw.read({ corpusId, subject: "prom-test" });

  const promResult = gw.apply(
    [{ kind: "promote", target: original.id, to: "validated", reason: "passed review" }],
    (_op, i) => `prom-upd-${i}`
  );
  expect(promResult.applied).toBe(1);

  const updated = gw.readByIds([original.id]);
  expect(updated[0].status).toBe("validated");
});

it("promote preserves the claim id (id is unchanged after status transition)", () => {
  const { mneme, corpusId } = makeBioMneme();
  const gw = createMnemeGateway(mneme, corpusId);

  gw.apply(
    [{ kind: "derive", claim: makeCandidateClaim({ subject: "prom-id-test", status: "candidate" }) }],
    (_op, i) => `prom-id-orig-${i}`
  );
  const [original] = gw.read({ corpusId, subject: "prom-id-test" });
  const originalId = original.id;

  gw.apply(
    [{ kind: "promote", target: originalId, to: "validated", reason: "checking id preservation" }],
    (_op, i) => `prom-id-upd-${i}`
  );

  const updated = gw.readByIds([originalId]);
  expect(updated.length).toBe(1);
  expect(updated[0].id).toBe(originalId);
  expect(updated[0].status).toBe("validated");
});

// ---------------------------------------------------------------------------
// promote non-existent target → surfaces as rejected (not_found)
// ---------------------------------------------------------------------------

it("promote non-existent target surfaces as rejected (not_found status)", () => {
  const { mneme, corpusId } = makeBioMneme();
  const gw = createMnemeGateway(mneme, corpusId);

  const nonExistentId = newClaimId();
  const result = gw.apply(
    [{ kind: "promote", target: nonExistentId, to: "validated", reason: "should be not_found" }],
    (_op, i) => `prom-miss-${i}`
  );

  expect(result.applied).toBe(0);
  expect(result.skipped).toBe(0);
  expect(result.rejected).toBeDefined();
  expect(result.rejected!.length).toBe(1);
  expect(result.rejected![0].status).toBe("not_found");
});

// ---------------------------------------------------------------------------
// opKey idempotency dedup: second identical apply → skipped
// ---------------------------------------------------------------------------

it("re-applying ops with the same opKey skips and does not duplicate rows", () => {
  const { mneme, corpusId } = makeBioMneme();
  const gw = createMnemeGateway(mneme, corpusId);

  const ops = [{ kind: "derive" as const, claim: makeCandidateClaim({ subject: "idem-test" }) }];
  const key = (_op: any, i: number) => `idem-key-${i}`;

  const first = gw.apply(ops, key);
  expect(first.applied).toBe(1);
  expect(first.skipped).toBe(0);

  const second = gw.apply(ops, key);
  expect(second.applied).toBe(0);
  expect(second.skipped).toBe(1);

  // Only one claim in store
  const claims = gw.read({ corpusId, subject: "idem-test" });
  expect(claims.length).toBe(1);
});

it("idempotency is per-key: different keys on the same op shape create separate records", () => {
  const { mneme, corpusId } = makeBioMneme();
  const gw = createMnemeGateway(mneme, corpusId);

  const ops = [{ kind: "derive" as const, claim: makeCandidateClaim({ subject: "idem2" }) }];

  const r1 = gw.apply(ops, (_op, i) => `key-a-${i}`);
  const r2 = gw.apply(ops, (_op, i) => `key-b-${i}`);
  expect(r1.applied).toBe(1);
  expect(r2.applied).toBe(1);
  // Two separate claims (different keys = treated as different ops)
  const claims = gw.read({ corpusId, subject: "idem2" });
  expect(claims.length).toBe(2);
});

// ---------------------------------------------------------------------------
// AppendResult.rejected is optional — consumers only reading applied/skipped unaffected
// ---------------------------------------------------------------------------

it("AppendResult.rejected is optional and absent consumers only need applied/skipped", () => {
  const { mneme, corpusId } = makeBioMneme();
  const gw = createMnemeGateway(mneme, corpusId);

  const result = gw.apply(
    [{ kind: "derive", claim: makeCandidateClaim() }],
    () => "opt-key"
  );

  // Consumer only reads applied/skipped — this is valid without rejected
  const { applied, skipped } = result;
  expect(applied).toBe(1);
  expect(skipped).toBe(0);
});

// ---------------------------------------------------------------------------
// apply aggregates: mixed ops applied/skipped/rejected counts
// ---------------------------------------------------------------------------

it("apply aggregates applied, skipped, and rejected counts across multiple ops", () => {
  const { mneme, corpusId } = makeBioMneme();
  const gw = createMnemeGateway(mneme, corpusId);

  // First apply — 1 derive op
  const firstApply = gw.apply(
    [{ kind: "derive", claim: makeCandidateClaim({ subject: "agg-test" }) }],
    () => "agg-key-1"
  );
  expect(firstApply.applied).toBe(1);

  const nonExistentId = newClaimId();

  // Second apply: 1 duplicate (same key), 1 not_found promote, 1 new derive
  const result = gw.apply(
    [
      { kind: "derive", claim: makeCandidateClaim({ subject: "agg-test" }) },          // duplicate → skipped
      { kind: "promote", target: nonExistentId, to: "validated", reason: "miss" },     // not_found → rejected
      { kind: "derive", claim: makeCandidateClaim({ subject: "agg-test-2" }) },        // new → applied
    ],
    (_op, i) => i === 0 ? "agg-key-1" : `agg-key-new-${i}`
  );

  expect(result.applied).toBe(1);
  expect(result.skipped).toBe(1);
  expect(result.rejected).toBeDefined();
  expect(result.rejected!.length).toBe(1);
  expect(result.rejected![0].status).toBe("not_found");
});
