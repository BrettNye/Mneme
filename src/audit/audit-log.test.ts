import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { createSqliteAdapter } from "../adapters/sqlite.js";
import { createLocalAnchor } from "./local-anchor.js";
import { NoneSigner } from "./signers.js";
import { verifyChain, anchorEpoch, auditReport } from "./audit-log.js";
import type { ClaimEvent } from "../adapters/adapter.js";

// Helper: build minimal events for a given corpus
function appendTestEvent(
  adapter: ReturnType<typeof createSqliteAdapter>,
  corpusId: string,
  claimId: string,
  seq: number,
): void {
  const ev: ClaimEvent = {
    op: "commit",
    corpusId,
    writer: "test-writer",
    claimId,
    recorded: 1716000000000 + seq * 1000,
    recordedSeq: seq,
  };
  adapter.appendEvent(ev);
}

// ---------------------------------------------------------------------------
// 1. verifyChain — untampered chain returns { intact: true }
//    This test FAILS if canon in audit-log.ts drifts from sqlite.ts's canonicalEvent.
// ---------------------------------------------------------------------------

describe("verifyChain", () => {
  it("returns intact:true for an untampered chain of events", () => {
    const adapter = createSqliteAdapter();
    appendTestEvent(adapter, "c", "claim-1", 1);
    appendTestEvent(adapter, "c", "claim-2", 2);
    appendTestEvent(adapter, "c", "claim-3", 3);

    const result = verifyChain(adapter, "c");
    expect(result.intact).toBe(true);
    expect(result.brokenAt).toBeUndefined();
  });

  it("returns intact:true for an empty corpus (no events)", () => {
    const adapter = createSqliteAdapter();
    const result = verifyChain(adapter, "empty-corpus");
    expect(result.intact).toBe(true);
    expect(result.brokenAt).toBeUndefined();
  });

  it("returns intact:false with brokenAt when an event's entryHash is tampered", () => {
    const adapter = createSqliteAdapter();
    appendTestEvent(adapter, "c", "claim-1", 1);
    appendTestEvent(adapter, "c", "claim-2", 2);
    appendTestEvent(adapter, "c", "claim-3", 3);

    // Read the events to discover what we stored, then access the raw DB to tamper
    // We can't mutate the ClaimEvent objects returned by readEvents (they're value types),
    // so we create a "tampered" view by building a proxy adapter that returns corrupted events.
    // Instead, we use a second adapter on the same data and directly test the check logic by
    // constructing a fake adapter whose readEvents returns tampered data.
    const originalEvents = adapter.readEvents({ corpusId: "c" });
    expect(originalEvents).toHaveLength(3);

    // Build a tampered adapter that lies about event[1]'s entryHash
    const tamperedAdapter = {
      ...adapter,
      readEvents(filter?: { corpusId?: string; claimId?: string; since?: number }) {
        const evs = adapter.readEvents(filter);
        if (evs.length < 2) return evs;
        // Tamper with index 1 — change its entryHash so the chain breaks
        return evs.map((e, i) =>
          i === 1 ? { ...e, entryHash: "deadbeef".repeat(8) } : e,
        );
      },
    };

    const result = verifyChain(tamperedAdapter as any, "c");
    expect(result.intact).toBe(false);
    expect(result.brokenAt).toBe(1);
  });

  it("returns intact:false with brokenAt when prevHash doesn't match predecessor's entryHash", () => {
    const adapter = createSqliteAdapter();
    appendTestEvent(adapter, "c", "claim-1", 1);
    appendTestEvent(adapter, "c", "claim-2", 2);

    // Build a tampered adapter that lies about event[1]'s prevHash
    const tamperedAdapter = {
      ...adapter,
      readEvents(filter?: { corpusId?: string; claimId?: string; since?: number }) {
        const evs = adapter.readEvents(filter);
        return evs.map((e, i) =>
          i === 1 ? { ...e, prevHash: "aaaa".repeat(16) } : e,
        );
      },
    };

    const result = verifyChain(tamperedAdapter as any, "c");
    expect(result.intact).toBe(false);
    expect(result.brokenAt).toBe(1);
  });

  it("verifies chains for different corpora independently", () => {
    const adapter = createSqliteAdapter();
    appendTestEvent(adapter, "corp-A", "a1", 1);
    appendTestEvent(adapter, "corp-B", "b1", 1);
    appendTestEvent(adapter, "corp-A", "a2", 2);

    expect(verifyChain(adapter, "corp-A").intact).toBe(true);
    expect(verifyChain(adapter, "corp-B").intact).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. anchorEpoch — Merkle-roots the corpus's entry hashes, signs, calls anchor
// ---------------------------------------------------------------------------

describe("anchorEpoch", () => {
  it("returns a receipt with guarantee 'detect' when using NoneSigner + createLocalAnchor", async () => {
    const adapter = createSqliteAdapter();
    appendTestEvent(adapter, "c", "claim-1", 1);
    appendTestEvent(adapter, "c", "claim-2", 2);

    const anchor = createLocalAnchor(adapter, "c");
    const receipt = await anchorEpoch(adapter, "c", "epoch-1", {
      signer: NoneSigner,
      anchor,
    });

    expect(receipt.epochId).toBe("epoch-1");
    expect(receipt.guarantee).toBe("detect");
    expect(typeof receipt.at).toBe("number");
  });

  it("stores an anchored root that can be fetched back", async () => {
    const adapter = createSqliteAdapter();
    appendTestEvent(adapter, "c", "claim-1", 1);

    const anchor = createLocalAnchor(adapter, "c");
    await anchorEpoch(adapter, "c", "epoch-fetch", {
      signer: NoneSigner,
      anchor,
    });

    const roots = await anchor.fetch({ epochId: "epoch-fetch" });
    expect(roots).toHaveLength(1);
    expect(roots[0].epochId).toBe("epoch-fetch");
    expect(roots[0].root).toBeInstanceOf(Uint8Array);
    expect(roots[0].root.length).toBe(32); // sha256
  });

  it("can anchor an empty corpus (zero events — returns Merkle root of empty set)", async () => {
    const adapter = createSqliteAdapter();
    const anchor = createLocalAnchor(adapter, "empty-corpus");
    const receipt = await anchorEpoch(adapter, "empty-corpus", "epoch-empty", {
      signer: NoneSigner,
      anchor,
    });
    expect(receipt.epochId).toBe("epoch-empty");
    expect(receipt.guarantee).toBe("detect");
  });
});

// ---------------------------------------------------------------------------
// 3. auditReport — licensing tamper-evident vs tamper-detecting
// ---------------------------------------------------------------------------

describe("auditReport", () => {
  it("returns 'tamper-detecting' for guarantee='detect'", () => {
    const report = auditReport({ intact: true }, "detect");
    expect(report.claim).toBe("tamper-detecting");
    expect(report.guarantee).toBe("detect");
    expect(report.intact).toBe(true);
  });

  it("returns 'tamper-evident' for guarantee='external-immutable'", () => {
    const report = auditReport({ intact: true }, "external-immutable");
    expect(report.claim).toBe("tamper-evident");
    expect(report.guarantee).toBe("external-immutable");
    expect(report.intact).toBe(true);
  });

  it("returns 'tamper-evident' for guarantee='witnessed' (highest rank)", () => {
    const report = auditReport({ intact: true }, "witnessed");
    expect(report.claim).toBe("tamper-evident");
    expect(report.guarantee).toBe("witnessed");
    expect(report.intact).toBe(true);
  });

  it("propagates intact:false correctly", () => {
    const report = auditReport({ intact: false }, "detect");
    expect(report.intact).toBe(false);
    expect(report.claim).toBe("tamper-detecting");
  });

  it("propagates intact:false with external-immutable guarantee", () => {
    const report = auditReport({ intact: false }, "external-immutable");
    expect(report.intact).toBe(false);
    expect(report.claim).toBe("tamper-evident");
  });
});
