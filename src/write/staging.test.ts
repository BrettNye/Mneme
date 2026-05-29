import { StagingBuffer } from "./staging.js";
import type { CandidateClaim } from "../core/claim.js";

const cand: CandidateClaim = {
  workspace: "w" as any,
  profile: "p" as any,
  subject: "repo",
  key: "repo.x",
  scope: {},
  value: 1,
  confidence: { distribution: "beta" as const, parameters: { alpha: 9, beta: 1 }, raw: 0.9 },
  valid: { start: 0 },
  source: "manual" as const,
  provenance: { traceId: "t1" },
  evidence: [],
  tags: [],
  schema: "v1",
} as any;

it("emit buffers an entry, list reflects it, take removes it", () => {
  const b = new StagingBuffer();
  const id = b.emit("c1", cand);
  expect(b.list().map((e) => e.stagingId)).toEqual([id]);
  expect(b.take(id)?.corpusId).toBe("c1");
  expect(b.list()).toEqual([]);
});

it("emit returns distinct ids for two calls", () => {
  const b = new StagingBuffer();
  const id1 = b.emit("c1", cand);
  const id2 = b.emit("c1", cand);
  expect(id1).not.toBe(id2);
});

it("list filters by corpusId when provided", () => {
  const b = new StagingBuffer();
  const id1 = b.emit("corpus-A", cand);
  const id2 = b.emit("corpus-B", cand);
  const listA = b.list("corpus-A");
  expect(listA).toHaveLength(1);
  expect(listA[0].stagingId).toBe(id1);
  const listB = b.list("corpus-B");
  expect(listB).toHaveLength(1);
  expect(listB[0].stagingId).toBe(id2);
});

it("list without corpusId returns all entries", () => {
  const b = new StagingBuffer();
  b.emit("corpus-A", cand);
  b.emit("corpus-B", cand);
  expect(b.list()).toHaveLength(2);
});

it("take returns undefined for unknown stagingId", () => {
  const b = new StagingBuffer();
  expect(b.take("nonexistent-id")).toBeUndefined();
});

it("take returns the full StagedEntry with candidate and idempotencyKey", () => {
  const b = new StagingBuffer();
  const id = b.emit("c2", cand, "my-key");
  const entry = b.take(id);
  expect(entry).toBeDefined();
  expect(entry!.stagingId).toBe(id);
  expect(entry!.corpusId).toBe("c2");
  expect(entry!.candidate).toBe(cand);
  expect(entry!.idempotencyKey).toBe("my-key");
});

it("takeAll returns and removes all entries for the given corpus", () => {
  const b = new StagingBuffer();
  const id1 = b.emit("corpus-X", cand);
  const id2 = b.emit("corpus-X", cand);
  b.emit("corpus-Y", cand); // should not be returned

  const taken = b.takeAll("corpus-X");
  expect(taken).toHaveLength(2);
  const takenIds = taken.map((e) => e.stagingId);
  expect(takenIds).toContain(id1);
  expect(takenIds).toContain(id2);

  // corpus-X entries should be gone from buffer
  expect(b.list("corpus-X")).toHaveLength(0);
  // corpus-Y entry should remain
  expect(b.list("corpus-Y")).toHaveLength(1);
});

it("takeAll returns empty array when no entries for corpus", () => {
  const b = new StagingBuffer();
  b.emit("other-corpus", cand);
  expect(b.takeAll("empty-corpus")).toEqual([]);
});

it("discard removes the entry and returns true", () => {
  const b = new StagingBuffer();
  const id = b.emit("c3", cand);
  expect(b.discard(id)).toBe(true);
  expect(b.list()).toHaveLength(0);
});

it("discard returns false for unknown stagingId", () => {
  const b = new StagingBuffer();
  expect(b.discard("nonexistent")).toBe(false);
});

it("emit stores idempotencyKey as undefined when omitted", () => {
  const b = new StagingBuffer();
  const id = b.emit("c4", cand);
  const entry = b.take(id);
  expect(entry!.idempotencyKey).toBeUndefined();
});
