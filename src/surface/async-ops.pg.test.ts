/**
 * task-pg-parity: the Docker-gated linchpin gate (spec §5.4).
 *
 * Same shape as task-fast-parity's parity matrix (async-ops.test.ts), but the async
 * side is a REAL `createMnemeAsync(createPostgresAdapter(...))` (per
 * parity.pg.test.ts's `dbPerTenantRouter` testcontainers pattern) instead of
 * `asyncifyAdapter` over the same in-memory sqlite store. Per the ratified narrowing
 * of §5.4's "same arg matrix": this suite carries ONLY the arms that exercise
 * adapter-visible behavior — subject+key scoping, alias-family expansion, no-filter
 * full scan, and the three-warning fixture (order asserted) — plus the remember/B3
 * supersession-attribution arm. The post-read pure-knob arms (recencyAlpha:1,
 * abstained, empty-corpus, unknown-corpus) are adapter-invisible by construction
 * (recallCore applies them in-memory, after the read) and stay fast-parity-only.
 *
 * Seeding: fixed/matching claim ids across backends are achieved via the SAME
 * remember()/rememberAsync() write sequence into each store, with a deterministic
 * `crypto.randomUUID` stub RESET per store (B3) — mirrors async-ops.test.ts's
 * `stubRandomUuid`/"remember parity" pattern. This gives byte-equal claims (same
 * ids, same recordedSeq ordering) across sqlite and postgres without hand-building
 * raw `Claim` rows.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { startPg } from "../adapters/postgres/test-support.js";
import { createPostgresAdapter } from "../adapters/postgres/index.js";
import { dbPerTenantRouter } from "../adapters/postgres/tenant-router.js";
import { createMnemeAsync, createSqliteAdapter } from "../index.js";
import { recall, recallAsync, type RecallResult } from "./recall.js";
import { remember, rememberAsync } from "./remember.js";
import { sessionOverAdapter, jaccardDeps } from "./test-support.js";
import { corpusDefFromSpec } from "./types.js";
import type { CorpusSpec } from "./types.js";
import type { AsyncMneme } from "../mneme-async.js";
import type { Session } from "./types.js";

const T0 = Date.parse("2026-01-01T00:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

let pool: Pool;
let stop: () => Promise<void>;

beforeAll(async () => {
  const pg = await startPg();
  pool = pg.pool;
  stop = pg.stop;
}, 180_000);

afterAll(async () => {
  await stop?.();
});

function makePgAdapter() {
  return createPostgresAdapter({ router: dbPerTenantRouter(() => pool), tenantId: "t1" });
}

/** Sync sqlite session + async pg-backed AsyncMneme — TWO SEPARATE stores, each
 *  with its own in-memory Catalog. Declares the SAME corpus spec into BOTH
 *  facades' catalogs (via corpusDefFromSpec for the async side) when provided. */
function syncSqliteVsAsyncPg(spec?: CorpusSpec): { syncSession: Session; asyncMneme: AsyncMneme } {
  const syncSession = sessionOverAdapter(createSqliteAdapter(":memory:"));
  const asyncMneme = createMnemeAsync({
    adapter: makePgAdapter(),
    availableTiers: [{ kind: "core" }],
  });
  if (spec) {
    syncSession.createCorpus(spec);
    asyncMneme.createCorpus(corpusDefFromSpec(spec));
  }
  return { syncSession, asyncMneme };
}

/** UUID stub helper (async-ops.test.ts's `stubRandomUuid` pattern): sequential
 *  deterministic ids, reset the counter before each store's writes (B3) so the
 *  cross-backend id comparison doesn't diverge on real-random id text. */
function stubRandomUuid(): { restore: () => void } {
  let seq = 0;
  const spy = vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(
    () => `00000000-0000-0000-0000-${String(seq++).padStart(12, "0")}` as `${string}-${string}-${string}-${string}-${string}`,
  );
  return { restore: () => spy.mockRestore() };
}

/** Classifies a warning string by which check emitted it (mirrors async-ops.test.ts's
 *  `kindOf`) — used ONLY to assert order, not to derive it. */
function kindOf(w: string): "alias" | "coverage" | "cardinality" {
  if (w.includes("no claim available to this recall")) return "coverage";
  if (w.includes("single-cardinality")) return "cardinality";
  return "alias";
}

describe("pg parity: sync recall (sqlite) vs recallAsync (postgres)", () => {
  it("parity: subject+key-scoped recall", async () => {
    const CORPUS = "pg-p-subject-key";
    const { syncSession, asyncMneme } = syncSqliteVsAsyncPg({ id: CORPUS });

    const uuid1 = stubRandomUuid();
    remember(syncSession, { subject: "host:a", key: "status", value: "healthy", corpus: CORPUS, validFrom: iso(T0) });
    remember(syncSession, { subject: "host:a", key: "owner", value: "team-a", corpus: CORPUS, validFrom: iso(T0) });
    remember(syncSession, { subject: "host:b", key: "status", value: "degraded", corpus: CORPUS, validFrom: iso(T0) });
    uuid1.restore();

    const uuid2 = stubRandomUuid();
    await rememberAsync(asyncMneme, { subject: "host:a", key: "status", value: "healthy", corpus: CORPUS, validFrom: iso(T0) });
    await rememberAsync(asyncMneme, { subject: "host:a", key: "owner", value: "team-a", corpus: CORPUS, validFrom: iso(T0) });
    await rememberAsync(asyncMneme, { subject: "host:b", key: "status", value: "degraded", corpus: CORPUS, validFrom: iso(T0) });
    uuid2.restore();

    const args = { about: "status", corpus: CORPUS, subject: "host:a", key: "status", asOf: T0 + 1000 };
    const s: RecallResult = await recall(syncSession, args, jaccardDeps);
    const a: RecallResult = await recallAsync(asyncMneme, args, jaccardDeps);
    expect(a).toEqual(s);
    expect(s.matches).toHaveLength(1);
    expect(s.matches[0]).toMatchObject({ subject: "host:a", key: "status" });
  }, 60_000);

  it("parity: alias-family recall (variant key retrieves across the family)", async () => {
    const CORPUS = "pg-p-alias";
    const { syncSession, asyncMneme } = syncSqliteVsAsyncPg({ id: CORPUS });

    const uuid1 = stubRandomUuid();
    remember(syncSession, { subject: "user:brett", key: "editor", value: "vim", corpus: CORPUS, validFrom: iso(T0) });
    remember(syncSession, { subject: "user:brett", key: "preferred_editor", value: "emacs", corpus: CORPUS, validFrom: iso(T0 + 1000) });
    remember(syncSession, { subject: "key:editor", key: "alias-of", value: "preferred_editor", corpus: CORPUS, validFrom: iso(T0) });
    uuid1.restore();

    const uuid2 = stubRandomUuid();
    await rememberAsync(asyncMneme, { subject: "user:brett", key: "editor", value: "vim", corpus: CORPUS, validFrom: iso(T0) });
    await rememberAsync(asyncMneme, { subject: "user:brett", key: "preferred_editor", value: "emacs", corpus: CORPUS, validFrom: iso(T0 + 1000) });
    await rememberAsync(asyncMneme, { subject: "key:editor", key: "alias-of", value: "preferred_editor", corpus: CORPUS, validFrom: iso(T0) });
    uuid2.restore();

    const args = { about: "editor", key: "editor", corpus: CORPUS, asOf: T0 + 100_000 };
    const s = await recall(syncSession, args, jaccardDeps);
    const a = await recallAsync(asyncMneme, args, jaccardDeps);
    expect(a).toEqual(s);
    expect(s.matches.map((m) => m.key)).toEqual(["preferred_editor"]);
  }, 60_000);

  it("parity: no-filter recall (whole corpus scored)", async () => {
    const CORPUS = "pg-p-nofilter";
    const { syncSession, asyncMneme } = syncSqliteVsAsyncPg({ id: CORPUS });

    const uuid1 = stubRandomUuid();
    remember(syncSession, { subject: "project:mneme", key: "fact", value: "Mneme dogfoods via MCP", corpus: CORPUS, validFrom: iso(T0) });
    remember(syncSession, { subject: "project:mneme", key: "note", value: "unrelated weather chatter", corpus: CORPUS, validFrom: iso(T0 + 1000) });
    uuid1.restore();

    const uuid2 = stubRandomUuid();
    await rememberAsync(asyncMneme, { subject: "project:mneme", key: "fact", value: "Mneme dogfoods via MCP", corpus: CORPUS, validFrom: iso(T0) });
    await rememberAsync(asyncMneme, { subject: "project:mneme", key: "note", value: "unrelated weather chatter", corpus: CORPUS, validFrom: iso(T0 + 1000) });
    uuid2.restore();

    const args = { about: "Mneme dogfoods via MCP", corpus: CORPUS, asOf: T0 + 100_000 };
    const s = await recall(syncSession, args, jaccardDeps);
    const a = await recallAsync(asyncMneme, args, jaccardDeps);
    expect(a).toEqual(s);
    expect(s.matches.length).toBeGreaterThan(0);
  }, 60_000);

  it("parity: golden three-warning fixture — alias -> coverage -> cardinality order preserved", async () => {
    const CORPUS = "pg-p-golden";
    const { syncSession, asyncMneme } = syncSqliteVsAsyncPg({ id: CORPUS });

    const uuid1 = stubRandomUuid();
    // 1. Meta-alias loader warning.
    remember(syncSession, { subject: "key:variant", key: "alias-of", value: "alias-of", corpus: CORPUS, validFrom: iso(T0) });
    // 2 + 3. Two "status" claims — token-dissimilar values, undeclared cardinality.
    remember(syncSession, { subject: "svc", key: "status", value: "green light everywhere", corpus: CORPUS, validFrom: iso(T0) });
    remember(syncSession, { subject: "svc", key: "status", value: "totally broken outage", corpus: CORPUS, validFrom: iso(T0 + 1_000) });
    uuid1.restore();

    const uuid2 = stubRandomUuid();
    await rememberAsync(asyncMneme, { subject: "key:variant", key: "alias-of", value: "alias-of", corpus: CORPUS, validFrom: iso(T0) });
    await rememberAsync(asyncMneme, { subject: "svc", key: "status", value: "green light everywhere", corpus: CORPUS, validFrom: iso(T0) });
    await rememberAsync(asyncMneme, { subject: "svc", key: "status", value: "totally broken outage", corpus: CORPUS, validFrom: iso(T0 + 1_000) });
    uuid2.restore();

    const args = { about: "status Budget", corpus: CORPUS, key: "status", asOf: T0 + 100_000 };
    const s = await recall(syncSession, args, jaccardDeps);
    const a = await recallAsync(asyncMneme, args, jaccardDeps);
    expect(a).toEqual(s);
    expect(s.warnings?.length).toBe(3);
    expect(s.warnings!.map(kindOf)).toEqual(["alias", "coverage", "cardinality"]);
  }, 60_000);
});

describe("pg parity: remember (sqlite) vs rememberAsync (postgres) — supersession attribution", () => {
  it("rememberAsync on pg attributes supersession identically to sync-on-sqlite", async () => {
    const CORPUS = "pg-parity-remember";

    // Store 1: sync remember over sqlite, single-cardinality corpus, pinned
    // pairwise-distinct validFroms so the second write supersedes the first.
    const uuid1 = stubRandomUuid();
    const syncSession = sessionOverAdapter(createSqliteAdapter(":memory:"));
    syncSession.createCorpus({ id: CORPUS, keyCardinality: { plan: "single" } });
    remember(syncSession, { subject: "p", key: "plan", value: "alpha", corpus: CORPUS, validFrom: "2026-01-01T00:00:00Z" });
    const r1 = remember(syncSession, { subject: "p", key: "plan", value: "bravo", corpus: CORPUS, validFrom: "2026-02-01T00:00:00Z" });
    uuid1.restore();

    // Store 2: rememberAsync over a real Postgres-backed AsyncMneme, same shape,
    // its own per-store id-sequence reset (B3).
    const uuid2 = stubRandomUuid();
    const asyncMneme = createMnemeAsync({ adapter: makePgAdapter(), availableTiers: [{ kind: "core" }] });
    asyncMneme.createCorpus(corpusDefFromSpec({ id: CORPUS, keyCardinality: { plan: "single" } }));
    await rememberAsync(asyncMneme, { subject: "p", key: "plan", value: "alpha", corpus: CORPUS, validFrom: "2026-01-01T00:00:00Z" });
    const r2 = await rememberAsync(asyncMneme, { subject: "p", key: "plan", value: "bravo", corpus: CORPUS, validFrom: "2026-02-01T00:00:00Z" });
    uuid2.restore();

    expect({ status: r2.status, supersession: r2.supersession }).toEqual({
      status: r1.status,
      supersession: r1.supersession,
    });
  }, 60_000);
});
