// Backend-agnostic behavioral contract for AsyncStorageAdapter implementations.
// A drift guard: any backend (Postgres, and future async backends) that wires
// its `createXAdapter(...).scoped!({ corpus })` through `runAsyncAdapterContract`
// gets the SAME suite of behavioral assertions, so a regression in one backend's
// scoping/ordering/hash-chain/idempotency semantics fails loudly instead of only
// showing up in that backend's own bespoke test file.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import type { AsyncStorageAdapter } from "./async-adapter.js";
import type { ClaimEvent } from "./adapter-types.js";
import type { Claim } from "../core/claim.js";
import { newClaimId } from "../core/ids.js";
import type { ClaimId } from "../core/ids.js";

/**
 * A deterministic, minimal VALID `Claim` (all required fields populated),
 * local to this contract so it has no dependency on any backend-specific test
 * fixture. Fields are overridable via `over`.
 */
function fixtureClaim(over: Partial<Claim> = {}): Claim {
  const base: Claim = {
    id: newClaimId(),
    profile: "contract-profile" as Claim["profile"],
    workspace: "contract-workspace" as Claim["workspace"],
    subject: "project:contract-fixture",
    key: "contract.key",
    scope: { project: "contract-fixture" },
    scopeHash: "_",
    value: "active",
    valueHash: "0000000000000000",
    confidence: { distribution: "scalar", parameters: { p: 0.9 }, raw: 0.9 },
    valid: { from: 0, to: Number.POSITIVE_INFINITY },
    recorded: 0,
    recordedSeq: 1,
    status: "validated",
    source: "manual",
    provenance: {},
    evidence: [],
    audience: {},
    tags: [],
    schema: "v1",
  };
  return { ...base, ...over };
}

/**
 * Discovers the corpus a `make()`-produced adapter is actually bound to, by
 * inserting a throwaway claim and reading back its (backend-assigned)
 * `corpusId`. Needed because a scoped adapter's bound corpus is otherwise
 * opaque to the contract: `insertClaim` stamps rows with the adapter's own
 * bound scope regardless of any corpusId a caller passes elsewhere (e.g. to
 * `transaction`), and a scoped `readEvents` forces its filter to that same
 * bound corpus. Falls back to a literal for adapters that don't stamp
 * `corpusId` on read.
 */
async function boundCorpus(adapter: AsyncStorageAdapter): Promise<string> {
  const probe = fixtureClaim({ subject: `contract:probe:${newClaimId()}` });
  await adapter.transaction("contract-probe", () => adapter.insertClaim(probe));
  const got = await adapter.getClaim(probe.id);
  return got?.corpusId ?? "contract-probe";
}

export function runAsyncAdapterContract(
  name: string,
  make: () => Promise<AsyncStorageAdapter>
): void {
  describe(`AsyncStorageAdapter contract: ${name}`, () => {
    it("insert then getClaim returns the claim (byte-equal)", async () => {
      const adapter = await make();
      const claim = fixtureClaim();

      await adapter.transaction("t-roundtrip", () => adapter.insertClaim(claim));

      const got = await adapter.getClaim(claim.id);
      expect(got).toBeDefined();
      // Neutralize any backend-assigned `corpusId` (absent on the original,
      // written fixture) before the exact-equality check on every other field.
      expect({ ...got, corpusId: undefined }).toEqual(claim);
    });

    it("query returns inserted claims ordered by recorded_seq ASC, id ASC", async () => {
      const adapter = await make();
      const subject = "project:contract-order";
      const lowSeq = fixtureClaim({ subject, recordedSeq: 1, id: "order-z" as ClaimId });
      const tieB = fixtureClaim({ subject, recordedSeq: 5, id: "order-b" as ClaimId });
      const tieA = fixtureClaim({ subject, recordedSeq: 5, id: "order-a" as ClaimId });

      await adapter.transaction("t-order", () => adapter.insertBatch([tieB, lowSeq, tieA]));

      const rows = await adapter.query({ corpusId: "unused-by-scoped-adapters", subject });
      expect(rows.map((r) => r.id)).toEqual([lowSeq.id, tieA.id, tieB.id]);
    });

    it("putIdempotencyRecord then getIdempotencyRecord returns it; absent key returns undefined", async () => {
      const adapter = await make();

      expect(await adapter.getIdempotencyRecord("contract-scope", "missing-key")).toBeUndefined();

      const rec = { result: "ok", createdAt: 12345 };
      await adapter.putIdempotencyRecord("contract-scope", "present-key", rec);
      expect(await adapter.getIdempotencyRecord("contract-scope", "present-key")).toEqual(rec);
    });

    it("a claim inserted under one scoped corpus is invisible to a differently-scoped adapter", async () => {
      const adapterA = await make();
      const adapterB = await make();
      const claim = fixtureClaim({ subject: "project:contract-isolation" });

      await adapterA.transaction("t-iso", () => adapterA.insertClaim(claim));

      expect(await adapterB.getClaim(claim.id)).toBeUndefined();
      const rows = await adapterB.query({ corpusId: "unused-by-scoped-adapters", subject: claim.subject });
      expect(rows).toHaveLength(0);

      // Sanity: the writing adapter's own scope still sees it.
      expect((await adapterA.getClaim(claim.id))?.id).toBe(claim.id);
    });

    it("appendEvent chains entryHash/prevHash across successive events in a corpus", async () => {
      const adapter = await make();
      const corpusId = await boundCorpus(adapter);

      const e1: ClaimEvent = {
        op: "commit",
        corpusId,
        writer: "contract-writer",
        claimId: "contract-claim-a",
        recorded: 0,
        recordedSeq: 100,
      };
      const e2: ClaimEvent = { ...e1, claimId: "contract-claim-b", recordedSeq: 101 };

      await adapter.transaction(corpusId, async () => {
        await adapter.appendEvent(e1);
        await adapter.appendEvent(e2);
      });

      const events = await adapter.readEvents({ corpusId });
      expect(events).toHaveLength(2);
      expect(events[0].prevHash ?? "").toBe("");
      expect(events[0].entryHash).toBeTruthy();
      expect(events[1].prevHash).toBe(events[0].entryHash);

      // The chain is a real, recomputable sha256 over canonical(event) + prevHash.
      const canonical = JSON.stringify([
        e1.op,
        e1.corpusId,
        e1.writer,
        e1.claimId,
        null,
        null,
        null,
        e1.recorded,
        e1.recordedSeq,
      ]);
      const recomputed = createHash("sha256")
        .update(canonical + (events[0].prevHash ?? ""))
        .digest("hex");
      expect(events[0].entryHash).toBe(recomputed);
    });

    it("maxRecordedSeq(corpus) reflects the max recorded_seq for that corpus and is monotonic", async () => {
      const adapter = await make();
      const corpusId = await boundCorpus(adapter);
      const baseline = await adapter.maxRecordedSeq(corpusId);

      const higher = fixtureClaim({ recordedSeq: baseline + 10 });
      await adapter.transaction(corpusId, () => adapter.insertClaim(higher));
      expect(await adapter.maxRecordedSeq(corpusId)).toBe(baseline + 10);

      // Inserting a LOWER recordedSeq afterwards must not decrease the max.
      const lower = fixtureClaim({ recordedSeq: baseline + 1 });
      await adapter.transaction(corpusId, () => adapter.insertClaim(lower));
      expect(await adapter.maxRecordedSeq(corpusId)).toBe(baseline + 10);
    });

    it("keys plan equals the in-memory keyIn filter for non-empty keys, order preserved", async () => {
      const adapter = await make();
      const subject = "project:contract-keys";
      await adapter.transaction("t-keys", async () => {
        for (const [i, key] of ["k1", "k2", "k3"].entries()) {
          await adapter.insertClaim(fixtureClaim({ subject, key, recordedSeq: i + 1 }));
        }
      });

      const all = await adapter.query({ corpusId: "unused-by-scoped-adapters", subject });
      const filtered = await adapter.query({
        corpusId: "unused-by-scoped-adapters",
        subject,
        keys: ["k1", "k3"],
      });
      expect(filtered).toEqual(all.filter((c) => ["k1", "k3"].includes(c.key)));
    });

    it("keys: [] equals the unfiltered query (plan-level empty array is NOT keyIn-equivalent)", async () => {
      const adapter = await make();
      const subject = "project:contract-keys-empty";
      await adapter.transaction("t-keys-empty", async () => {
        for (const [i, key] of ["k1", "k2"].entries()) {
          await adapter.insertClaim(fixtureClaim({ subject, key, recordedSeq: i + 1 }));
        }
      });

      const all = await adapter.query({ corpusId: "unused-by-scoped-adapters", subject });
      const emptyKeys = await adapter.query({
        corpusId: "unused-by-scoped-adapters",
        subject,
        keys: [],
      });
      expect(emptyKeys).toEqual(all);
    });

    it("keys composes (ANDs) with subject and with key", async () => {
      const adapter = await make();
      const subjectA = "project:contract-keys-and-a";
      const subjectB = "project:contract-keys-and-b";
      await adapter.transaction("t-keys-and", async () => {
        await adapter.insertClaim(fixtureClaim({ subject: subjectA, key: "k1", recordedSeq: 1 }));
        await adapter.insertClaim(fixtureClaim({ subject: subjectA, key: "k2", recordedSeq: 2 }));
        await adapter.insertClaim(fixtureClaim({ subject: subjectB, key: "k1", recordedSeq: 3 }));
      });

      // keys ANDs with subject: subject alone would also match subjectA/k2, but
      // keys=["k1"] narrows it away -- a real (discriminating) AND, not a subset
      // that subject-alone would already produce.
      const bySubjectAndKeys = await adapter.query({
        corpusId: "unused-by-scoped-adapters",
        subject: subjectA,
        keys: ["k1"],
      });
      expect(bySubjectAndKeys.map((c) => `${c.subject}/${c.key}`)).toEqual([`${subjectA}/k1`]);

      // keys ANDs with key: key="k1" plus a DISJOINT keys=["k2","k3"] must match
      // NOTHING -- if `keys` were silently ignored, key="k1" alone would still
      // return rows, so this discriminates a broken/ignored `keys` branch.
      const byKeyAndDisjointKeys = await adapter.query({
        corpusId: "unused-by-scoped-adapters",
        key: "k1",
        keys: ["k2", "k3"],
      });
      expect(byKeyAndDisjointKeys).toEqual([]);
    });

    it("a keys query through corpus A's scope never returns corpus B's claims", async () => {
      const adapterA = await make();
      const adapterB = await make();
      const subject = "project:contract-keys-scope";

      const claimA = fixtureClaim({ subject, key: "shared-key" });
      const claimB = fixtureClaim({ subject, key: "shared-key" });
      await adapterA.transaction("t-keys-scope-a", () => adapterA.insertClaim(claimA));
      await adapterB.transaction("t-keys-scope-b", () => adapterB.insertClaim(claimB));

      const rowsA = await adapterA.query({
        corpusId: "unused-by-scoped-adapters",
        subject,
        keys: ["shared-key"],
      });
      expect(rowsA.map((c) => c.id)).toEqual([claimA.id]);
      expect(rowsA.some((c) => c.id === claimB.id)).toBe(false);
    });
  });
}
