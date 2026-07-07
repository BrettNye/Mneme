/**
 * task-fast-parity: the no-Docker parity harness (spec §5.2/§5.3).
 *
 * Two halves:
 *
 *  1. `asyncifyAdapter` unit tests — verifies the B2 member rules directly:
 *     capabilities() stays a sync passthrough, optional members mirror the
 *     wrapped adapter's own presence/absence, and transaction() is a NO-OP
 *     passthrough whose writes are still observable (no atomicity — see the
 *     doc comment on asyncifyAdapter in test-support.ts).
 *
 *  2. Parity matrix — ONE sqlite adapter, two facades sharing it
 *     (`sameStorePair`): sync `createMneme` (via `sessionOverAdapter`) and
 *     async `createMnemeAsync(asyncifyAdapter(same adapter))`. Each facade
 *     owns its own in-memory Catalog, so the corpus def is declared into BOTH
 *     before recall/recallAsync ever see it. Every arm pins `asOf` (B7) so
 *     recency-blended scores can't drift between the two calls, and asserts a
 *     FULL RecallResult deep-equal (ids, content, warnings + order, coverage,
 *     topScore, abstained, rankFn).
 */
import { describe, it, expect, vi } from "vitest";
import { recall, recallAsync, type RecallResult } from "./recall.js";
import { remember, rememberAsync } from "./remember.js";
import { asyncifyAdapter, sessionOverAdapter, jaccardDeps } from "./test-support.js";
import { corpusDefFromSpec } from "./types.js";
import type { CorpusSpec } from "./types.js";
import { createMnemeAsync, createSqliteAdapter } from "../index.js";
import type { StorageAdapter } from "../adapters/adapter.js";
import type { Claim } from "../core/claim.js";
import type { ClaimId } from "../core/ids.js";
import { scopeHash } from "../core/scope.js";
import { scalarConfidence } from "../core/confidence.js";

const T0 = Date.parse("2026-01-01T00:00:00Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

// ── asyncifyAdapter — unit tests (B2 member rules) ──────────────────────────

/** A COMPLETE, valid single-claim Claim fixture (mirrors remember.test.ts's fullClaim):
 *  every field the pipeline actually reads is present, so writes round-trip cleanly
 *  through a real StorageAdapter. */
function fullClaim(id: string): Claim {
  const scope = {};
  return {
    id: id as ClaimId,
    profile: "test",
    workspace: "c",
    corpusId: "c",
    subject: "p",
    key: "k",
    scope,
    scopeHash: scopeHash(scope),
    value: "v",
    valueHash: "stub-value-hash",
    confidence: scalarConfidence(1),
    valid: { from: Date.now() - 1000, to: Infinity },
    recorded: Date.now(),
    recordedSeq: 0,
    status: "validated",
    source: "manual",
    provenance: {},
    evidence: [],
    audience: {},
    tags: [],
    schema: "c@1",
  } as unknown as Claim;
}

describe("asyncifyAdapter — unit (B2 member rules)", () => {
  it("capabilities() is a sync passthrough — not wrapped in a Promise", () => {
    const sync = createSqliteAdapter(":memory:");
    const asyncAdapter = asyncifyAdapter(sync);
    const caps = asyncAdapter.capabilities();
    expect(caps).not.toBeInstanceOf(Promise);
    expect(caps).toEqual(sync.capabilities());
  });

  it("an adapter WITHOUT close() produces a wrapper that also lacks close", () => {
    const base = createSqliteAdapter(":memory:");
    const { close: _close, ...rest } = base;
    const noCloseBase = rest as StorageAdapter;
    const asyncAdapter = asyncifyAdapter(noCloseBase);
    expect(asyncAdapter.close).toBeUndefined();
  });

  it("an adapter WITH close() produces a wrapper whose close() is async and delegates", async () => {
    const base = createSqliteAdapter(":memory:");
    const asyncAdapter = asyncifyAdapter(base);
    expect(typeof asyncAdapter.close).toBe("function");
    await expect(asyncAdapter.close!()).resolves.toBeUndefined();
  });

  it("optional members present when the wrapped adapter defines them (putAnchoredRoot/getAnchoredRoots/scoped)", () => {
    const base = createSqliteAdapter(":memory:");
    const asyncAdapter = asyncifyAdapter(base);
    expect(typeof asyncAdapter.putAnchoredRoot).toBe("function");
    expect(typeof asyncAdapter.getAnchoredRoots).toBe("function");
    expect(typeof asyncAdapter.scoped).toBe("function");
  });

  it("transaction() is a NO-OP passthrough: the async fn's awaited writes ARE observable in the store", async () => {
    const sync = createSqliteAdapter(":memory:");
    const asyncAdapter = asyncifyAdapter(sync);
    let ran = false;
    await asyncAdapter.transaction("some-corpus", async () => {
      ran = true;
      await asyncAdapter.insertClaim(fullClaim("txn-claim"));
    });
    expect(ran).toBe(true);
    const got = await asyncAdapter.getClaim("txn-claim" as ClaimId);
    expect(got?.id).toBe("txn-claim");
  });

  it("maxRecordedSeq(corpusId) delegates to the sync maxRecordedSeq(), ignoring the corpusId param", async () => {
    const sync = createSqliteAdapter(":memory:");
    const asyncAdapter = asyncifyAdapter(sync);
    await asyncAdapter.insertClaim(fullClaim("seq-claim"));
    // sync store's maxRecordedSeq is corpus-agnostic (no corpusId param) — recordedSeq is 0.
    await expect(asyncAdapter.maxRecordedSeq("any-corpus")).resolves.toBe(sync.maxRecordedSeq());
  });
});

// ── Parity matrix — sameStorePair over a shared sqlite adapter ───────────────

/** ONE sqlite adapter, two facades: sync `createMneme` (via sessionOverAdapter) and
 *  async `createMnemeAsync(asyncifyAdapter(same adapter))`. Each facade owns its own
 *  in-memory Catalog — declare `spec` into BOTH when provided; omit it to leave the
 *  corpus entirely undeclared (the unknown-corpus arm). */
function sameStorePair(spec?: CorpusSpec) {
  const adapter = createSqliteAdapter(":memory:");
  const syncSession = sessionOverAdapter(adapter);
  const asyncMneme = createMnemeAsync({
    adapter: asyncifyAdapter(adapter),
    availableTiers: [{ kind: "core" }],
  });
  if (spec) {
    syncSession.createCorpus(spec);
    asyncMneme.createCorpus(corpusDefFromSpec(spec));
  }
  return { syncSession, asyncMneme, adapter };
}

/** Classifies a warning string by which check emitted it (recall-golden.test.ts pattern) —
 *  used ONLY to assert order, not to derive it. */
function kindOf(w: string): "alias" | "coverage" | "cardinality" {
  if (w.includes("no claim available to this recall")) return "coverage";
  if (w.includes("single-cardinality")) return "cardinality";
  return "alias";
}

describe("parity matrix — sync recall vs recallAsync(asyncifyAdapter) over the SAME store", () => {
  it("parity: subject-scoped recall", async () => {
    const { syncSession, asyncMneme } = sameStorePair({ id: "p-subject" });
    remember(syncSession, { subject: "host:a", key: "status", value: "healthy", corpus: "p-subject", validFrom: iso(T0) });
    remember(syncSession, { subject: "host:b", key: "status", value: "degraded", corpus: "p-subject", validFrom: iso(T0) });
    const args = { about: "status", corpus: "p-subject", subject: "host:a", asOf: T0 + 1000 };

    const s: RecallResult = await recall(syncSession, args, jaccardDeps);
    const a: RecallResult = await recallAsync(asyncMneme, args, jaccardDeps);
    expect(a).toEqual(s);
    expect(s.matches.map((m) => m.subject)).toEqual(["host:a"]);
  });

  it("parity: key-scoped recall", async () => {
    const { syncSession, asyncMneme } = sameStorePair({ id: "p-key" });
    remember(syncSession, { subject: "svc", key: "status", value: "healthy", corpus: "p-key", validFrom: iso(T0) });
    remember(syncSession, { subject: "svc", key: "owner", value: "team-a", corpus: "p-key", validFrom: iso(T0) });
    const args = { about: "status", corpus: "p-key", key: "status", asOf: T0 + 1000 };

    const s = await recall(syncSession, args, jaccardDeps);
    const a = await recallAsync(asyncMneme, args, jaccardDeps);
    expect(a).toEqual(s);
    expect(s.matches.map((m) => m.key)).toEqual(["status"]);
  });

  it("parity: subject+key-scoped recall", async () => {
    const { syncSession, asyncMneme } = sameStorePair({ id: "p-subject-key" });
    remember(syncSession, { subject: "host:a", key: "status", value: "healthy", corpus: "p-subject-key", validFrom: iso(T0) });
    remember(syncSession, { subject: "host:a", key: "owner", value: "team-a", corpus: "p-subject-key", validFrom: iso(T0) });
    remember(syncSession, { subject: "host:b", key: "status", value: "degraded", corpus: "p-subject-key", validFrom: iso(T0) });
    const args = { about: "status", corpus: "p-subject-key", subject: "host:a", key: "status", asOf: T0 + 1000 };

    const s = await recall(syncSession, args, jaccardDeps);
    const a = await recallAsync(asyncMneme, args, jaccardDeps);
    expect(a).toEqual(s);
    expect(s.matches).toHaveLength(1);
    expect(s.matches[0]).toMatchObject({ subject: "host:a", key: "status" });
  });

  it("parity: alias-family recall (variant key retrieves across the family)", async () => {
    const { syncSession, asyncMneme } = sameStorePair({ id: "p-alias" });
    const CORPUS = "p-alias";
    remember(syncSession, { subject: "user:brett", key: "editor", value: "vim", corpus: CORPUS, validFrom: iso(T0) });
    remember(syncSession, { subject: "user:brett", key: "preferred_editor", value: "emacs", corpus: CORPUS, validFrom: iso(T0 + 1000) });
    remember(syncSession, { subject: "key:editor", key: "alias-of", value: "preferred_editor", corpus: CORPUS, validFrom: iso(T0) });
    const args = { about: "editor", key: "editor", corpus: CORPUS, asOf: T0 + 100_000 };

    const s = await recall(syncSession, args, jaccardDeps);
    const a = await recallAsync(asyncMneme, args, jaccardDeps);
    expect(a).toEqual(s);
    expect(s.matches.map((m) => m.key)).toEqual(["preferred_editor"]);
  });

  it("parity: no-filter recall (whole corpus scored)", async () => {
    const { syncSession, asyncMneme } = sameStorePair({ id: "p-nofilter" });
    remember(syncSession, { subject: "project:mneme", key: "fact", value: "Mneme dogfoods via MCP", corpus: "p-nofilter", validFrom: iso(T0) });
    remember(syncSession, { subject: "project:mneme", key: "note", value: "unrelated weather chatter", corpus: "p-nofilter", validFrom: iso(T0 + 1000) });
    const args = { about: "Mneme dogfoods via MCP", corpus: "p-nofilter", asOf: T0 + 100_000 };

    const s = await recall(syncSession, args, jaccardDeps);
    const a = await recallAsync(asyncMneme, args, jaccardDeps);
    expect(a).toEqual(s);
    expect(s.matches.length).toBeGreaterThan(0);
  });

  it("parity: unknown corpus — empty result both arms; async catalog not mutated (read-only)", async () => {
    const { syncSession, asyncMneme } = sameStorePair(); // corpus never declared anywhere
    const args = { about: "anything", corpus: "never-declared", asOf: T0 };
    const before = asyncMneme.listCorpora();

    const s = await recall(syncSession, args, jaccardDeps);
    const a = await recallAsync(asyncMneme, args, jaccardDeps);
    expect(a).toEqual(s);
    expect(s.matches).toEqual([]);
    expect(asyncMneme.listCorpora()).toEqual(before);
  });

  it("parity: recencyAlpha=1 (pure similarity, no recency blend)", async () => {
    const { syncSession, asyncMneme } = sameStorePair({ id: "p-alpha1" });
    remember(syncSession, { subject: "x", key: "fact", value: "the quick brown fox", corpus: "p-alpha1", validFrom: iso(T0 - 100 * DAY) });
    remember(syncSession, { subject: "x", key: "note", value: "totally unrelated", corpus: "p-alpha1", validFrom: iso(T0) });
    const args = { about: "the quick brown fox", corpus: "p-alpha1", recencyAlpha: 1, asOf: T0 + 1000 };

    const s = await recall(syncSession, args, jaccardDeps);
    const a = await recallAsync(asyncMneme, args, jaccardDeps);
    expect(a).toEqual(s);
    expect(s.matches[0]?.value).toBe("the quick brown fox");
  });

  it("parity: abstained (abstainBelowTop high)", async () => {
    const { syncSession, asyncMneme } = sameStorePair({ id: "p-abstain" });
    remember(syncSession, { subject: "s", key: "k", value: "xyz xyz xyz", corpus: "p-abstain", validFrom: iso(T0) });
    const args = { about: "abc", corpus: "p-abstain", abstainBelowTop: 0.99, asOf: T0 + 1000 };

    const s = await recall(syncSession, args, jaccardDeps);
    const a = await recallAsync(asyncMneme, args, jaccardDeps);
    expect(a).toEqual(s);
    expect(s.abstained).toBe(true);
    expect(s.matches).toEqual([]);
  });

  it("parity: existing-but-empty corpus", async () => {
    const { syncSession, asyncMneme } = sameStorePair({ id: "p-empty" });
    const args = { about: "anything here", corpus: "p-empty", asOf: T0 };

    const s = await recall(syncSession, args, jaccardDeps);
    const a = await recallAsync(asyncMneme, args, jaccardDeps);
    expect(a).toEqual(s);
    expect(s.matches).toEqual([]);
  });

  it("parity: golden three-warning fixture — alias -> coverage -> cardinality order preserved", async () => {
    const CORPUS = "p-golden";
    const { syncSession, asyncMneme } = sameStorePair({ id: CORPUS });

    // 1. Meta-alias loader warning.
    remember(syncSession, { subject: "key:variant", key: "alias-of", value: "alias-of", corpus: CORPUS, validFrom: iso(T0) });
    // 2 + 3. Two "status" claims — token-dissimilar values, undeclared cardinality.
    remember(syncSession, { subject: "svc", key: "status", value: "green light everywhere", corpus: CORPUS, validFrom: iso(T0) });
    remember(syncSession, { subject: "svc", key: "status", value: "totally broken outage", corpus: CORPUS, validFrom: iso(T0 + 1_000) });

    const args = { about: "status Budget", corpus: CORPUS, key: "status", asOf: T0 + 100_000 };
    const s = await recall(syncSession, args, jaccardDeps);
    const a = await recallAsync(asyncMneme, args, jaccardDeps);
    expect(a).toEqual(s);
    expect(s.warnings?.length).toBe(3);
    expect(s.warnings!.map(kindOf)).toEqual(["alias", "coverage", "cardinality"]);
  });
});

// ── Remember parity — real write sequence into TWO SEPARATE stores ──────────

/** UUID stub helper (recall-golden.test.ts / remember.test.ts pattern): sequential
 *  deterministic ids, reset the counter before each store's writes (B3) so the
 *  cross-store parity comparison doesn't diverge on real-random id text. */
function stubRandomUuid(): { restore: () => void } {
  let seq = 0;
  const spy = vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(
    () => `00000000-0000-0000-0000-${String(seq++).padStart(12, "0")}` as `${string}-${string}-${string}-${string}-${string}`,
  );
  return { restore: () => spy.mockRestore() };
}

describe("remember parity — same write sequence into TWO separate asyncifyAdapter(sqlite) stores", () => {
  it("sync remember vs rememberAsync over asyncifyAdapter: equal status + supersession", async () => {
    const CORPUS = "parity-remember";

    // Store 1: sync remember, over a fresh single-cardinality corpus.
    const uuid1 = stubRandomUuid();
    const adapter1 = createSqliteAdapter(":memory:");
    const s1 = sessionOverAdapter(adapter1);
    s1.createCorpus({ id: CORPUS, keyCardinality: { plan: "single" } });
    remember(s1, { subject: "p", key: "plan", value: "alpha", corpus: CORPUS, validFrom: "2026-01-01T00:00:00Z" });
    const r1 = remember(s1, { subject: "p", key: "plan", value: "bravo", corpus: CORPUS, validFrom: "2026-02-01T00:00:00Z" });
    uuid1.restore();

    // Store 2: rememberAsync over asyncifyAdapter(a DIFFERENT fresh sqlite adapter), same shape,
    // its own per-store id-sequence reset (B3).
    const uuid2 = stubRandomUuid();
    const adapter2 = createSqliteAdapter(":memory:");
    const asyncMneme2 = createMnemeAsync({ adapter: asyncifyAdapter(adapter2), availableTiers: [{ kind: "core" }] });
    asyncMneme2.createCorpus(corpusDefFromSpec({ id: CORPUS, keyCardinality: { plan: "single" } }));
    await rememberAsync(asyncMneme2, { subject: "p", key: "plan", value: "alpha", corpus: CORPUS, validFrom: "2026-01-01T00:00:00Z" });
    const r2 = await rememberAsync(asyncMneme2, { subject: "p", key: "plan", value: "bravo", corpus: CORPUS, validFrom: "2026-02-01T00:00:00Z" });
    uuid2.restore();

    expect({ status: r2.status, supersession: r2.supersession }).toEqual({
      status: r1.status,
      supersession: r1.supersession,
    });
  });
});
