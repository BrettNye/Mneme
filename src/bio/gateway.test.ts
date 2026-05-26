import { createMnemeGateway, type MnemeGateway } from "./gateway.js";
import { createSqliteAdapter } from "../adapters/sqlite.js";
import type { StorageAdapter } from "../adapters/adapter.js";
import type { Claim, CandidateClaim } from "../core/claim.js";
import type { ClaimId } from "../core/ids.js";
import { newClaimId } from "../core/ids.js";
import { INFINITY } from "../core/time.js";
import type { AppendOp } from "./types.js";

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
// MnemeGateway interface compile-time check: no update/delete on the type
// ---------------------------------------------------------------------------

it("MnemeGateway interface has no update or delete methods (append-only enforcement)", () => {
  // If MnemeGateway had update/delete, these type assertions would fail at
  // compile time. We verify at runtime that the gateway object never exposes them.
  const gw = createMnemeGateway();
  expect("update" in gw).toBe(false);
  expect("delete" in gw).toBe(false);
  expect("deleteClaim" in gw).toBe(false);
});

// ---------------------------------------------------------------------------
// read / readByIds basic passthrough
// ---------------------------------------------------------------------------

it("read passes through to adapter.query", () => {
  const adapter = createSqliteAdapter();
  const gw = createMnemeGateway(adapter);

  // Insert a raw claim directly into adapter, then read via gateway
  const ops: AppendOp[] = [{ kind: "derive", claim: makeCandidateClaim({ subject: "s1" }) }];
  gw.apply(ops, (_op, i) => `key-${i}`);

  const results = gw.read({ corpusId: "ignored", subject: "s1" });
  expect(results.length).toBe(1);
  expect(results[0].subject).toBe("s1");
});

it("readByIds returns claims for present ids and omits missing ids", () => {
  const gw = createMnemeGateway();
  const ops: AppendOp[] = [{ kind: "derive", claim: makeCandidateClaim({ subject: "s2" }) }];
  const result = gw.apply(ops, (_op, i) => `rbi-${i}`);
  expect(result.applied).toBe(1);

  const all = gw.read({ corpusId: "c", subject: "s2" });
  const id = all[0].id;

  const fakeId = newClaimId();
  const found = gw.readByIds([id, fakeId]);
  expect(found.length).toBe(1);
  expect(found[0].id).toBe(id);
});

// ---------------------------------------------------------------------------
// derive op
// ---------------------------------------------------------------------------

it("apply derive inserts a new claim with a fresh id", () => {
  const gw = createMnemeGateway();
  const result = gw.apply(
    [{ kind: "derive", claim: makeCandidateClaim({ subject: "derive-test" }) }],
    (_op, i) => `derive-${i}`
  );

  expect(result.applied).toBe(1);
  expect(result.skipped).toBe(0);
  const claims = gw.read({ corpusId: "c", subject: "derive-test" });
  expect(claims.length).toBe(1);
  expect(claims[0].id).toBeTruthy();
});

// ---------------------------------------------------------------------------
// supersede op — centerpiece acceptance criteria
// ---------------------------------------------------------------------------

it("supersede inserts new claim with fresh id and marks old row as deprecated (both rows persist)", () => {
  const adapter = createSqliteAdapter();
  const gw = createMnemeGateway(adapter);

  // Step 1: insert original claim via derive
  gw.apply([{ kind: "derive", claim: makeCandidateClaim({ subject: "sup-test", value: "original" }) }], (_op, i) => `sup-orig-${i}`);
  const originals = gw.read({ corpusId: "c", subject: "sup-test" });
  expect(originals.length).toBe(1);
  const originalId = originals[0].id;
  const originalValue = originals[0].value;

  // Step 2: supersede it
  const supersedOp: AppendOp = {
    kind: "supersede",
    deprecate: originalId,
    with: makeCandidateClaim({ subject: "sup-test", value: "replacement" }),
    reason: "test supersede",
  };
  const supResult = gw.apply([supersedOp], (_op, i) => `sup-new-${i}`);
  expect(supResult.applied).toBe(1);

  // Both rows must persist — we query all statuses
  const deprecated = gw.readByIds([originalId]);
  expect(deprecated.length).toBe(1);
  expect(deprecated[0].status).toBe("deprecated");
  // Original value must not have changed (no in-place mutation)
  expect(deprecated[0].value).toEqual(originalValue);
  expect(deprecated[0].id).toBe(originalId);

  // The replacement is a NEW row with a different id
  const replacements = gw.read({ corpusId: "c", subject: "sup-test", status: ["validated"] });
  expect(replacements.length).toBe(1);
  expect(replacements[0].id).not.toBe(originalId);
  expect(replacements[0].value).toBe("replacement");
});

// ---------------------------------------------------------------------------
// idempotency
// ---------------------------------------------------------------------------

it("re-applying ops with the same opKey skips and does not duplicate rows", () => {
  const gw = createMnemeGateway();
  const ops: AppendOp[] = [{ kind: "derive", claim: makeCandidateClaim({ subject: "idem-test" }) }];
  const key = (_op: AppendOp, i: number) => `idem-key-${i}`;

  const first = gw.apply(ops, key);
  expect(first.applied).toBe(1);
  expect(first.skipped).toBe(0);

  const second = gw.apply(ops, key);
  expect(second.applied).toBe(0);
  expect(second.skipped).toBe(1);

  // Only one claim in store
  const claims = gw.read({ corpusId: "c", subject: "idem-test" });
  expect(claims.length).toBe(1);
});

it("idempotency is per-key: different keys on the same op shape create separate records", () => {
  const gw = createMnemeGateway();
  const ops: AppendOp[] = [{ kind: "derive", claim: makeCandidateClaim({ subject: "idem2" }) }];

  const r1 = gw.apply(ops, (_op, i) => `key-a-${i}`);
  const r2 = gw.apply(ops, (_op, i) => `key-b-${i}`);
  expect(r1.applied).toBe(1);
  expect(r2.applied).toBe(1);
  // Two separate claims (different keys = treated as different ops)
  const claims = gw.read({ corpusId: "c", subject: "idem2" });
  expect(claims.length).toBe(2);
});

// ---------------------------------------------------------------------------
// promote op
// ---------------------------------------------------------------------------

it("promote changes a claim's status", () => {
  const gw = createMnemeGateway();
  gw.apply(
    [{ kind: "derive", claim: makeCandidateClaim({ subject: "prom-test", status: "candidate" }) }],
    (_op, i) => `prom-orig-${i}`
  );
  const [original] = gw.read({ corpusId: "c", subject: "prom-test" });

  gw.apply(
    [{ kind: "promote", target: original.id, to: "validated", reason: "passed review" }],
    (_op, i) => `prom-upd-${i}`
  );

  const updated = gw.readByIds([original.id]);
  expect(updated[0].status).toBe("validated");
});

it("promote preserves the claim id (id is unchanged after status transition)", () => {
  const gw = createMnemeGateway();
  gw.apply(
    [{ kind: "derive", claim: makeCandidateClaim({ subject: "prom-id-test", status: "candidate" }) }],
    (_op, i) => `prom-id-orig-${i}`
  );
  const [original] = gw.read({ corpusId: "c", subject: "prom-id-test" });
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

it("promote non-existent target yields applied: 0 and changes nothing", () => {
  const gw = createMnemeGateway();
  // Insert a known claim so we can verify it is unchanged
  gw.apply(
    [{ kind: "derive", claim: makeCandidateClaim({ subject: "prom-missing-bystander" }) }],
    (_op, i) => `prom-miss-orig-${i}`
  );
  const beforeClaims = gw.read({ corpusId: "c", subject: "prom-missing-bystander" });
  expect(beforeClaims.length).toBe(1);

  // Promote a non-existent id
  const nonExistentId = newClaimId();
  const result = gw.apply(
    [{ kind: "promote", target: nonExistentId, to: "validated", reason: "should be a no-op" }],
    (_op, i) => `prom-miss-upd-${i}`
  );

  expect(result.applied).toBe(0);
  expect(result.skipped).toBe(0);

  // Bystander claim unchanged
  const afterClaims = gw.read({ corpusId: "c", subject: "prom-missing-bystander" });
  expect(afterClaims.length).toBe(1);
  expect(afterClaims[0].status).toBe(beforeClaims[0].status);
});

// ---------------------------------------------------------------------------
// Invariant property test (design spec §11)
//
// Over a randomized sequence of apply calls, no claim row is ever physically
// removed and no existing row's value/confidence/evidence ever changes.
// Only new ids appear and statuses transition.
// ---------------------------------------------------------------------------

function getAllClaims(adapter: StorageAdapter): Claim[] {
  // `corpusId` is intentionally unfiltered here — the adapter ignores it when
  // no other predicates narrow the result set, so this acts as "read everything".
  // We use the raw adapter (not the gateway's read path) to capture all rows
  // regardless of status, which is required for the append-only invariant check.
  return adapter.query({ corpusId: "invariant" });
}

function seededRand(seed: number) {
  // Mulberry32 — deterministic, portable, no external deps
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 0xffffffff;
  };
}

it("invariant: no claim row is physically removed and no value/confidence/evidence mutates across random op sequences", () => {
  const ROUNDS = 20;
  const OPS_PER_ROUND = 8;

  for (let round = 0; round < ROUNDS; round++) {
    const rand = seededRand(round * 7919 + 13);
    const adapter = createSqliteAdapter();
    const gw = createMnemeGateway(adapter);

    // Snapshot: map from id -> { value, confidence, evidence }
    type Snapshot = Record<string, { value: unknown; confidence: unknown; evidence: unknown }>;
    const snapshot: Snapshot = {};

    for (let opIndex = 0; opIndex < OPS_PER_ROUND; opIndex++) {
      const existingClaims = getAllClaims(adapter);

      // Build a random op
      const choice = rand();
      let op: AppendOp;
      if (existingClaims.length === 0 || choice < 0.5) {
        // derive a new claim
        op = {
          kind: "derive",
          claim: makeCandidateClaim({
            subject: `subj-${Math.floor(rand() * 5)}`,
            value: `val-${opIndex}-${round}`,
          }),
        };
      } else if (choice < 0.8) {
        // supersede a random existing claim
        const target = existingClaims[Math.floor(rand() * existingClaims.length)];
        op = {
          kind: "supersede",
          deprecate: target.id,
          with: makeCandidateClaim({ subject: target.subject, value: `sup-${opIndex}` }),
          reason: "random supersede",
        };
      } else {
        // promote a random existing claim
        const statuses: Claim["status"][] = ["candidate", "provisional", "validated", "deprecated"];
        const target = existingClaims[Math.floor(rand() * existingClaims.length)];
        op = {
          kind: "promote",
          target: target.id,
          to: statuses[Math.floor(rand() * statuses.length)],
          reason: "random promote",
        };
      }

      // Snapshot current state before applying
      for (const c of existingClaims) {
        if (!(c.id in snapshot)) {
          snapshot[c.id] = {
            value: c.value,
            confidence: c.confidence,
            evidence: c.evidence,
          };
        }
      }

      // Apply the op
      gw.apply([op], (_o, i) => `round-${round}-op-${opIndex}-${i}-${Math.floor(rand() * 1e9)}`);

      // INVARIANT CHECK: every previously-snapshotted row must still exist
      // and its value/confidence/evidence must be unchanged.
      const afterClaims = getAllClaims(adapter);
      const afterMap = new Map(afterClaims.map((c) => [c.id, c]));

      for (const [id, snap] of Object.entries(snapshot)) {
        const current = afterMap.get(id as ClaimId);
        // Row must still be physically present (no hard delete)
        expect(current, `Round ${round} op ${opIndex}: row ${id} was physically removed`).toBeDefined();
        if (current) {
          // id must not have changed (promote must not swap the id for a new one)
          expect(current.id, `Round ${round} op ${opIndex}: id changed for ${id}`).toBe(id);
          // value must not have changed
          expect(JSON.stringify(current.value), `Round ${round} op ${opIndex}: value mutated for ${id}`).toBe(
            JSON.stringify(snap.value)
          );
          // confidence must not have changed
          expect(JSON.stringify(current.confidence), `Round ${round} op ${opIndex}: confidence mutated for ${id}`).toBe(
            JSON.stringify(snap.confidence)
          );
          // evidence must not have changed
          expect(JSON.stringify(current.evidence), `Round ${round} op ${opIndex}: evidence mutated for ${id}`).toBe(
            JSON.stringify(snap.evidence)
          );
        }
      }
    }
  }
});
