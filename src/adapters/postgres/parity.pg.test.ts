// Cross-backend parity proof: the async-Postgres StorageAdapter must agree,
// claim-for-claim and event-for-event, with the sync-SQLite adapter for the
// SAME write+query sequence on a SINGLE corpus (so recordedSeq values coincide).
//
// Where a strict cross-backend equality cannot hold for a principled reason it
// is documented inline and the strongest TRUE invariant is asserted instead:
//   - claim `id` is minted fresh per backend  -> compare an id-INDEPENDENT
//     projection (subject/key/value/status/confidence.raw/recordedSeq).
//   - `entryHash` folds in the per-backend claimId AND the wall-clock `recorded`
//     -> it CANNOT match cross-backend; instead we assert per-backend chain
//     integrity plus identical op/recordedSeq ordering + count.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { createHash } from "node:crypto";
import { startPg, sampleClaim } from "./test-support.js";
import { createPostgresAdapter } from "./index.js";
import { dbPerTenantRouter } from "./tenant-router.js";
import { createMneme } from "../../mneme.js";
import { createSqliteAdapter } from "../sqlite.js";
import { createMnemeAsync } from "../../mneme-async.js";
import type { AsyncStorageAdapter } from "../async-adapter.js";
import type { StorageAdapter } from "../adapter.js";
import type { ClaimEvent } from "../adapter-types.js";
import type { Claim } from "../../core/claim.js";
import type { ClaimId } from "../../core/ids.js";
import type { Corpus as CorpusDef } from "../../catalog/corpus.js";
import type { ContradictionPolicy } from "../../catalog/corpus.js";

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

function makePgAdapter(): AsyncStorageAdapter {
  return createPostgresAdapter({
    router: dbPerTenantRouter(() => pool),
    tenantId: "t1",
  });
}

const TIERS = [{ kind: "core" as const }];

function corpusDef(id: string, policy: ContradictionPolicy): CorpusDef {
  return {
    id,
    displayName: id,
    schema: {
      version: "1",
      subjects: [id],
      scopeFields: {},
      required: [],
      scalarPseudocount: { manual: 2 },
    },
    defaults: {
      decayPolicy: { kind: "none" },
      confidenceThreshold: 0.5,
      contradictionPolicy: policy,
      defaultStatus: ["validated"],
    },
    requiredTiers: TIERS,
    metadata: {},
    createdAt: 0,
    updatedAt: 0,
  };
}

function candidate(
  corpus: string,
  subject: string,
  key: string,
  value: unknown,
  raw = 0.9,
) {
  return {
    profile: "profile-1" as any,
    workspace: corpus as any,
    subject,
    key,
    scope: {},
    value: value as any,
    confidence: {
      distribution: "beta" as const,
      parameters: { alpha: 9, beta: 1 },
      raw,
    },
    valid: { from: 0, to: Infinity },
    source: "manual" as const,
    provenance: {},
    evidence: [],
    tags: [],
    schema: `${corpus}@1`,
  };
}

/** id-INDEPENDENT projection used for cross-backend served-set comparison. */
interface Proj {
  subject: string;
  key: string;
  value: string;
  status: string;
  raw: number;
  seq: number;
}
function project(claims: Claim[], opts: { valueless?: (c: Claim) => boolean } = {}): Proj[] {
  return claims
    .map((c) => ({
      subject: c.subject,
      key: c.key,
      // The contradiction artifact's value embeds per-backend claim ids, so
      // callers can blank it out via `valueless` and still compare the rest.
      value: opts.valueless?.(c) ? "<id-bearing>" : JSON.stringify(c.value),
      status: c.status,
      raw: c.confidence.raw,
      seq: c.recordedSeq,
    }))
    .sort((a, b) =>
      JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0,
    );
}

/** Re-derive and verify the sha256 hash chain from each event's own fields. */
function assertChainIntegrity(events: ClaimEvent[]): void {
  let prev = "";
  for (const e of events) {
    const canonical = JSON.stringify([
      e.op,
      e.corpusId,
      e.writer,
      e.claimId,
      e.deprecatedId ?? null,
      e.toStatus ?? null,
      e.reason ?? null,
      e.recorded,
      e.recordedSeq,
    ]);
    const expected = createHash("sha256").update(canonical + prev).digest("hex");
    expect(e.prevHash).toBe(prev);
    expect(e.entryHash).toBe(expected);
    prev = e.entryHash!;
  }
}

describe("cross-backend parity: sync-SQLite vs async-Postgres", () => {
  it("served-claim set + confidence.raw parity for identical write+read (single corpus)", async () => {
    const corpus = "parity:served";
    const def = corpusDef(corpus, { kind: "always_accept" });

    const sqliteAdapter = createSqliteAdapter();
    const sync = createMneme({ adapter: sqliteAdapter, availableTiers: TIERS });
    sync.createCorpus(def);

    const pgAdapter = makePgAdapter();
    const asyncM = createMnemeAsync({ adapter: pgAdapter, availableTiers: TIERS });
    asyncM.createCorpus(def);

    // The SAME ordered write sequence on both backends: two commits, then a
    // supersede of the first. recordedSeq coincides because it is a single
    // fresh corpus in each store.
    const a1 = sync.commit(corpus, candidate(corpus, "s1", "k1", "v1", 0.9), { writer: "w" });
    sync.commit(corpus, candidate(corpus, "s2", "k2", "v2", 0.8), { writer: "w" });
    sync.supersede(corpus, a1.id, candidate(corpus, "s1", "k1", "v1-replacement", 0.7), { writer: "w" });

    const b1 = await asyncM.commit(corpus, candidate(corpus, "s1", "k1", "v1", 0.9), { writer: "w" });
    await asyncM.commit(corpus, candidate(corpus, "s2", "k2", "v2", 0.8), { writer: "w" });
    await asyncM.supersede(corpus, b1.id, candidate(corpus, "s1", "k1", "v1-replacement", 0.7), { writer: "w" });

    const syncClaims = sync.read(corpus, { corpusId: corpus });
    const pgClaims = await asyncM.read(corpus, { corpusId: corpus });

    // Same number of served claims (2 commits + 1 supersede-replacement, plus the
    // soft-deprecated original that reads still surface = 4 rows each).
    expect(pgClaims).toHaveLength(syncClaims.length);

    // id-independent projection is identical -> served sets agree.
    expect(project(pgClaims)).toEqual(project(syncClaims));

    // confidence.raw is bit-identical (Object.is via toEqual on the sorted raws).
    // Redundant with the project(...) equality above (raw is already projected);
    // kept as intentional re-emphasis of the confidence invariant, not extra coverage.
    const syncRaws = project(syncClaims).map((p) => p.raw);
    const pgRaws = project(pgClaims).map((p) => p.raw);
    expect(pgRaws).toEqual(syncRaws);
  }, 60_000);

  it("event op/order/count parity + per-backend entryHash chain integrity", async () => {
    const corpus = "parity:events";
    const def = corpusDef(corpus, { kind: "always_accept" });

    const sqliteAdapter = createSqliteAdapter();
    const sync = createMneme({ adapter: sqliteAdapter, availableTiers: TIERS });
    sync.createCorpus(def);

    const pgAdapter = makePgAdapter();
    const asyncM = createMnemeAsync({ adapter: pgAdapter, availableTiers: TIERS });
    asyncM.createCorpus(def);

    const a1 = sync.commit(corpus, candidate(corpus, "s1", "k1", "v1"), { writer: "w" });
    sync.commit(corpus, candidate(corpus, "s2", "k2", "v2"), { writer: "w" });
    sync.supersede(corpus, a1.id, candidate(corpus, "s1", "k1", "v1b"), { writer: "w" });
    sync.promote(corpus, a1.id, "deprecated", { writer: "w" });

    const b1 = await asyncM.commit(corpus, candidate(corpus, "s1", "k1", "v1"), { writer: "w" });
    await asyncM.commit(corpus, candidate(corpus, "s2", "k2", "v2"), { writer: "w" });
    await asyncM.supersede(corpus, b1.id, candidate(corpus, "s1", "k1", "v1b"), { writer: "w" });
    await asyncM.promote(corpus, b1.id, "deprecated", { writer: "w" });

    const syncEvents = (sqliteAdapter as StorageAdapter).readEvents!({ corpusId: corpus });
    const pgEvents = await pgAdapter.readEvents({ corpusId: corpus });

    // Identical op sequence, recordedSeq sequence, and count across backends.
    expect(pgEvents.map((e) => e.op)).toEqual(syncEvents.map((e) => e.op));
    expect(pgEvents.map((e) => e.recordedSeq)).toEqual(syncEvents.map((e) => e.recordedSeq));
    expect(pgEvents).toHaveLength(syncEvents.length);

    // entryHash CANNOT match cross-backend: canonicalEvent folds in the per-backend
    // claimId (minted fresh) AND the wall-clock `recorded`. So assert the invariant
    // that IS true -- each backend's chain is internally self-consistent.
    assertChainIntegrity(syncEvents);
    assertChainIntegrity(pgEvents);
  }, 60_000);

  it("accept_but_mark: same-recorded_seq accepted+artifact folds to identical confidence on both backends", async () => {
    const corpus = "parity:mark";
    const def = corpusDef(corpus, { kind: "accept_but_mark" });

    const sqliteAdapter = createSqliteAdapter();
    const sync = createMneme({ adapter: sqliteAdapter, availableTiers: TIERS });
    sync.createCorpus(def);

    const pgAdapter = makePgAdapter();
    const asyncM = createMnemeAsync({ adapter: pgAdapter, availableTiers: TIERS });
    asyncM.createCorpus(def);

    // First write establishes a validated claim; the second conflicts on the same
    // (subject,key,scope) with a different value -> accept_but_mark inserts a
    // `contradiction` artifact sharing the accepted claim's recorded_seq.
    sync.commit(corpus, candidate(corpus, "s", "k", "first", 0.9), { writer: "w" });
    sync.commit(corpus, candidate(corpus, "s", "k", "second", 0.85), { writer: "w" });

    await asyncM.commit(corpus, candidate(corpus, "s", "k", "first", 0.9), { writer: "w" });
    await asyncM.commit(corpus, candidate(corpus, "s", "k", "second", 0.85), { writer: "w" });

    const syncClaims = sync.read(corpus, { corpusId: corpus });
    const pgClaims = await asyncM.read(corpus, { corpusId: corpus });

    // A same-recorded_seq pair (accepted claim + artifact) exists on each backend.
    const maxSeq = Math.max(...syncClaims.map((c) => c.recordedSeq));
    expect(syncClaims.filter((c) => c.recordedSeq === maxSeq)).toHaveLength(2);
    expect(pgClaims.filter((c) => c.recordedSeq === maxSeq)).toHaveLength(2);

    // The artifact value embeds per-backend ids, so blank it out; everything else
    // -- subject/key/status/confidence.raw/recordedSeq -- folds identically. This
    // proves the same-recorded_seq case yields identical served confidence.
    const isArtifact = (c: Claim) => c.subject === "contradiction";
    expect(project(pgClaims, { valueless: isArtifact })).toEqual(
      project(syncClaims, { valueless: isArtifact }),
    );
  }, 60_000);

  it("COLLATE \"C\": id tie-break at equal recorded_seq matches SQLite's binary order", async () => {
    // Two claims sharing recorded_seq whose ids sort DIFFERENTLY under a libc
    // locale ("a0" < "Z0") vs binary/byte order ("Z0" 0x5A < "a0" 0x61). The pg
    // adapter's `ORDER BY recorded_seq, id COLLATE "C"` must reproduce SQLite's
    // binary `id ASC`. Because we control the ids, the SAME ids exist in both
    // stores, so ordering IS comparable cross-backend here.
    const corpus = "parity:collate";

    const idUpper = "Z0-claim" as ClaimId;
    const idLower = "a0-claim" as ClaimId;
    const expectedBinaryOrder = [idUpper, idLower]; // 'Z'(0x5A) < 'a'(0x61)

    const upper = sampleClaim({ id: idUpper, subject: "s", key: "k", value: "upper", recordedSeq: 1 });
    const lower = sampleClaim({ id: idLower, subject: "s", key: "k", value: "lower", recordedSeq: 1 });

    // SQLite (sync) via a scoped handle.
    const sqliteAdapter = createSqliteAdapter();
    const sqScoped = sqliteAdapter.scoped!({ corpus });
    sqScoped.insertClaim(lower);
    sqScoped.insertClaim(upper);
    const sqOrder = sqScoped.query({ corpusId: corpus }).map((c) => c.id);

    // Postgres (async) via a scoped handle.
    const pgAdapter = makePgAdapter();
    const pgScoped = pgAdapter.scoped!({ corpus });
    await pgScoped.insertClaim(lower);
    await pgScoped.insertClaim(upper);
    const pgOrder = (await pgScoped.query({ corpusId: corpus })).map((c) => c.id);

    // SQLite already orders by binary id; assert both agree with it AND each other.
    expect(sqOrder).toEqual(expectedBinaryOrder);
    expect(pgOrder).toEqual(expectedBinaryOrder);
    expect(pgOrder).toEqual(sqOrder);
  }, 60_000);

  it("sqlite and pg return identical results for a keys plan (+ subject)", async () => {
    // Same shape as the COLLATE "C" test above: fixed ids + scoped handles, so
    // full deep-equality is well-defined (mneme-minted ids would differ per
    // backend and break a byte-comparison).
    const corpus = "parity:keys";
    const subject = sampleClaim({}).subject;

    const sqScoped = createSqliteAdapter().scoped!({ corpus });
    const pgScoped = makePgAdapter().scoped!({ corpus });

    for (const [i, key] of ["k1", "k2", "k3"].entries()) {
      const claim = sampleClaim({ id: `parity-keys-${i}` as ClaimId, key, recordedSeq: i + 1 });
      sqScoped.insertClaim(claim);
      await pgScoped.insertClaim(claim);
    }

    const plan = { corpusId: corpus, subject, keys: ["k1", "k3"] };
    const sqRows = sqScoped.query(plan);
    const pgRows = await pgScoped.query(plan);

    expect(pgRows).toEqual(sqRows);
    expect(pgRows.map((c) => c.key)).toEqual(["k1", "k3"]);
  }, 60_000);

  it("text round-trip: float / >2^53 int / unicode+duplicate-ish keys survive byte-exactly", async () => {
    // A jsonb column would re-canonicalize numbers and key order; the pg adapter
    // stores values in a `text` column so the exact JSON round-trips.
    //
    // NOTE ON `bigish`: it must be an UNSAFE integer that also survives the JS
    // source-literal parse unchanged. 9007199254740993 (=2^53+1) is silently
    // rounded to 2^53 by the engine at parse time, so it would NOT exercise an
    // unsafe int. 9007199254740994 (=2^53+2) is even, hence exactly
    // representable AND > Number.MAX_SAFE_INTEGER. Guard both properties below so
    // a future edit can't quietly reintroduce a value that no longer tests this.
    const BIGISH = 9007199254740994; // 2^53 + 2
    expect(BIGISH).toBe(9007199254740994); // parse survived unchanged
    expect(BIGISH > Number.MAX_SAFE_INTEGER).toBe(true);
    expect(Number.isSafeInteger(BIGISH)).toBe(false);

    // Keys are DELIBERATELY not in sorted order, so a jsonb-style key
    // canonicalization WOULD reorder them and the stringify check below WOULD
    // catch it. (Sorted order would be: café, dup.key, dup.key␠, emoji-🎉,
    // floaty, negFloat, zebra.)
    const value = {
      zebra: "last-alphabetically-but-written-first",
      floaty: 0.1 + 0.2, // 0.30000000000000004 -- exact IEEE-754 double
      bigish: BIGISH, // > 2^53, unsafe integer (see guards above)
      negFloat: -1.5e-10,
      café: "naïve", // unicode key + value
      "emoji-🎉": "值 unicode value",
      "dup.key": 1,
      "dup.key ": 2, // distinct-but-similar keys
    };

    const claim = sampleClaim({ id: "text-roundtrip" as ClaimId, value: value as any });

    const pgAdapter = makePgAdapter();
    await pgAdapter.insertClaim(claim);
    const got = await pgAdapter.getClaim("text-roundtrip" as ClaimId);

    expect(got).toBeDefined();
    // Structural equality (key-order-INSENSITIVE).
    expect(got!.value).toEqual(value);
    // Order-SENSITIVE checks: prove the `text` column preserved insertion key
    // order byte-for-byte. A jsonb canonicalization would reorder keys and fail
    // these even though `toEqual` above would still pass.
    expect(Object.keys(got!.value as object)).toEqual(Object.keys(value));
    expect(JSON.stringify(got!.value)).toBe(JSON.stringify(value));
  }, 60_000);
});
