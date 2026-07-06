// Async Postgres StorageAdapter. Behavioral mirror of src/adapters/sqlite.ts
// (executeQuery/scoped/appendEvent/toRow/fromRow/canonicalEvent), made async
// over `pg`, with per-corpus advisory-lock serialization for the hash-chained
// audit store. Pure SQL strings come from ./sql.js; row mapping and the
// canonical event serialization are OWNED here (byte-exact parity with sqlite).
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { AsyncStorageAdapter } from "../async-adapter.js";
import type {
  ExecutionPlan,
  AdapterCapabilities,
  IdempotencyRecord,
  ClaimEvent,
  AdapterScope,
  AnchoredRootRow,
} from "../adapter-types.js";
import type { TenantRouter } from "./tenant-router.js";
import {
  buildQuery,
  insertClaimSql,
  headHashSql,
  appendEventSql,
  putIdempotencySql,
  putAnchorSql,
} from "./sql.js";
import type { Claim, Status, Source } from "../../core/claim.js";
import { asCorpusId } from "../../core/ids.js";
import type { ClaimId, ProfileId, WorkspaceId } from "../../core/ids.js";
import type { Scope } from "../../core/scope.js";
import type { Value } from "../../core/value.js";
import type { Provenance } from "../../core/provenance.js";
import type { EvidenceRef } from "../../core/evidence.js";
import type { Confidence } from "../../core/confidence.js";
import { serializeParams, deserializeParams } from "../../distribution/registry.js";

export interface PostgresAdapterOptions {
  router: TenantRouter;
  tenantId: string;
}

// Shape of a `${prefix}claims` row as returned by `pg`. `text` columns come
// back as strings; `double precision` as numbers; `bigint` (recorded_seq) as a
// STRING by default (node-postgres does not lose precision by parsing int8) so
// we Number()-coerce it in fromRow.
interface PgClaimRow {
  id: string;
  corpus_id: string | null;
  profile: string;
  workspace: string;
  subject: string;
  key: string;
  scope_hash: string;
  scope_json: string;
  value_json: string;
  value_hash: string;
  conf_distribution: string;
  conf_params: string;
  conf_raw: number;
  conf_effective: number | null;
  valid_from: number;
  valid_to: number;
  recorded: number;
  recorded_seq: string | number;
  status: string;
  source: string;
  provenance_json: string;
  evidence_json: string;
  audience_json: string;
  tags_json: string;
  schema: string;
  run_id: string | null;
  tenant_id: string;
}

interface PgEventRow {
  seq_pk: string | number;
  op: string;
  corpus_id: string;
  writer: string;
  claim_id: string;
  deprecated_id: string | null;
  to_status: string | null;
  reason: string | null;
  recorded: number;
  recorded_seq: string | number;
  entry_hash: string | null;
  prev_hash: string | null;
}

interface PgIdempRow {
  scope: string;
  key: string;
  result: string;
  created_at: number;
}

interface PgAnchorRow {
  corpus_id: string;
  epoch_id: string;
  root: string;
  signature: string | null;
  guarantee: string;
  at: number;
}

const CAPABILITIES: AdapterCapabilities = {
  valuePredicateSupport: {
    equality: "fallback_in_memory",
    range: "fallback_in_memory",
    set_membership: "fallback_in_memory",
    regex: "fallback_in_memory",
    structural_pattern: "fallback_in_memory",
    null_check: "fallback_in_memory",
  },
};

/** Ordered parameter list matching insertClaimSql's column order (27 columns). */
function toRow(c: Claim, corpusId: string | null, tenantId: string): unknown[] {
  return [
    c.id,
    c.profile,
    c.workspace,
    c.subject,
    c.key,
    c.scopeHash,
    JSON.stringify(c.scope),
    JSON.stringify(c.value),
    c.valueHash,
    c.confidence.distribution,
    serializeParams(c.confidence.distribution, c.confidence.parameters),
    c.confidence.raw,
    c.confidence.effective ?? null,
    c.valid.from,
    c.valid.to,
    c.recorded,
    c.recordedSeq,
    c.status,
    c.source,
    JSON.stringify(c.provenance),
    JSON.stringify(c.evidence),
    JSON.stringify(c.audience ?? {}),
    JSON.stringify(c.tags),
    c.schema,
    c.provenance.runId ?? null,
    corpusId,
    tenantId,
  ];
}

function fromRow(row: PgClaimRow): Claim {
  const distribution = row.conf_distribution;
  const confidence = {
    distribution: distribution as Confidence["distribution"],
    parameters: deserializeParams(distribution, row.conf_params) as Confidence["parameters"],
    raw: Number(row.conf_raw),
    ...(row.conf_effective != null ? { effective: Number(row.conf_effective) } : {}),
  } as Confidence;

  return {
    id: row.id as ClaimId,
    profile: row.profile as ProfileId,
    workspace: row.workspace as WorkspaceId,
    subject: row.subject,
    key: row.key,
    scope: JSON.parse(row.scope_json) as Scope,
    scopeHash: row.scope_hash,
    value: JSON.parse(row.value_json) as Value,
    valueHash: row.value_hash,
    confidence,
    valid: { from: Number(row.valid_from), to: Number(row.valid_to) },
    recorded: Number(row.recorded),
    recordedSeq: Number(row.recorded_seq),
    status: row.status as Status,
    source: row.source as Source,
    provenance: JSON.parse(row.provenance_json) as Provenance,
    evidence: JSON.parse(row.evidence_json) as EvidenceRef[],
    audience: row.audience_json ? JSON.parse(row.audience_json) : {},
    tags: JSON.parse(row.tags_json) as string[],
    schema: row.schema,
    // Null corpus_id (base-adapter rows) => field absent. NO workspace fallback.
    ...(row.corpus_id != null ? { corpusId: asCorpusId(row.corpus_id) } : {}),
  };
}

/**
 * Canonical serialization for hash-chain computation. Field ORDER MUST match
 * sqlite.ts's canonicalEvent EXACTLY -- the cross-backend entryHash parity
 * test depends on identical serialization.
 */
function canonicalEvent(e: ClaimEvent): string {
  return JSON.stringify([
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
}

function mapEvent(row: PgEventRow): ClaimEvent {
  const event: ClaimEvent = {
    op: row.op as ClaimEvent["op"],
    corpusId: row.corpus_id,
    writer: row.writer,
    claimId: row.claim_id,
    recorded: Number(row.recorded),
    recordedSeq: Number(row.recorded_seq),
  };
  if (row.deprecated_id != null) event.deprecatedId = row.deprecated_id;
  if (row.to_status != null) event.toStatus = row.to_status;
  if (row.reason != null) event.reason = row.reason;
  if (row.entry_hash != null) event.entryHash = row.entry_hash;
  if (row.prev_hash != null) event.prevHash = row.prev_hash;
  return event;
}

export function createPostgresAdapter(opts: PostgresAdapterOptions): AsyncStorageAdapter {
  // Throws on invalid/unknown tenant.
  const rc = opts.router.resolve(opts.tenantId);
  const prefix = rc.schemaPrefix;
  // ONE effective tenant string. Routing providers leave rc.tenantId undefined
  // -> "" -> every row is "" and every filter is "" -> behavior is IDENTICAL to
  // a single-tenant deployment. Row-level routing yields a real tenant id.
  const tenantId = rc.tenantId ?? "";
  // Carries the active transaction client so autocommit reads/writes JOIN the tx.
  const txClient = new AsyncLocalStorage<PoolClient>();

  async function withConn<T>(f: (c: PoolClient) => Promise<T>): Promise<T> {
    const existing = txClient.getStore();
    if (existing) return f(existing);
    const c = await rc.connect();
    try {
      return await f(c);
    } finally {
      c.release();
    }
  }

  async function transaction<T>(corpusId: string, fn: () => Promise<T>): Promise<T> {
    // REENTRANT JOIN: an inner transaction runs on the already-held client. Do
    // NOT acquire a second client (pool-deadlock risk). This join assumes the
    // nested corpusId equals the outer one (single-corpus-per-tx usage): a
    // differently-scoped nested transaction() will NOT take its own advisory
    // lock -- it simply rides the enclosing tx's lock.
    if (txClient.getStore()) return fn();

    const c = await rc.connect();
    try {
      await c.query("BEGIN");
      // Session-config only (no data read) precedes the lock so lock_timeout
      // bounds the lock-acquisition wait: a wedged lock surfaces as a
      // retryable error instead of hanging the corpus.
      await c.query("SET LOCAL lock_timeout = '15s'");
      await c.query("SET LOCAL statement_timeout = '30s'");
      // The advisory lock is the FIRST statement that READS shared state, and
      // it precedes every claims/chain read below -- so no writer can act on a
      // stale per-corpus head. Held until COMMIT/ROLLBACK so the hash chain
      // for this corpus cannot fork. Per-corpus key => cross-corpus writers
      // don't contend.
      // Compose tenant + corpus so per-(tenant,corpus) chains lock
      // independently. tenantId==="" keeps today's key = corpusId exactly.
      const lockKey = tenantId ? `${tenantId}:${corpusId}` : corpusId;
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
      const r = await txClient.run(c, fn);
      await c.query("COMMIT");
      c.release();
      return r;
    } catch (e) {
      try {
        await c.query("ROLLBACK");
        c.release();
      } catch {
        // Rollback failed -> the client is poisoned; destroy it on release.
        c.release(e as Error);
      }
      throw e;
    }
  }

  async function runQuery(plan: ExecutionPlan, force: AdapterScope | undefined): Promise<Claim[]> {
    return withConn(async (c) => {
      const { text, params } = buildQuery(prefix, plan, force, tenantId);
      const { rows } = await c.query<PgClaimRow>(text, params);
      return rows.map(fromRow);
    });
  }

  async function getClaimById(id: ClaimId): Promise<PgClaimRow | undefined> {
    return withConn(async (c) => {
      const { rows } = await c.query<PgClaimRow>(
        `SELECT * FROM ${prefix}claims WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId]
      );
      return rows[0];
    });
  }

  async function insertRow(c: Claim, corpusId: string | null): Promise<void> {
    await withConn((conn) => conn.query(insertClaimSql(prefix), toRow(c, corpusId, tenantId)));
  }

  async function insertLoop(conn: PoolClient, cs: Claim[], corpusId: string | null): Promise<void> {
    for (const cl of cs) {
      await conn.query(insertClaimSql(prefix), toRow(cl, corpusId, tenantId));
    }
  }

  async function insertMany(cs: Claim[], corpusId: string | null): Promise<void> {
    // Inside an ambient transaction(): the enclosing tx already provides
    // atomicity (and, for scoped writes, the per-corpus advisory lock). Loop
    // the inserts on the held client.
    const ambient = txClient.getStore();
    if (ambient) {
      await insertLoop(ambient, cs, corpusId);
      return;
    }
    // No ambient tx. Make the batch SELF-ATOMIC so a mid-batch failure cannot
    // leave a partially-committed batch in the hash-chained store (parity with
    // sqlite's IMMEDIATE-wrapped insertBatch).
    if (corpusId != null) {
      // Scoped batch: borrow transaction() for BOTH atomicity AND the
      // per-corpus advisory lock -- mirroring the single-claim scoped write.
      await transaction(corpusId, () => insertLoop(txClient.getStore()!, cs, corpusId));
      return;
    }
    // Base (unscoped) batch: no corpus to key an advisory lock on. Wrap the
    // loop in a plain BEGIN/COMMIT with the same release/rollback discipline
    // as transaction() (single release on every path; poisoned-client
    // release(err) if ROLLBACK throws).
    const c = await rc.connect();
    try {
      await c.query("BEGIN");
      await insertLoop(c, cs, corpusId);
      await c.query("COMMIT");
      c.release();
    } catch (e) {
      try {
        await c.query("ROLLBACK");
        c.release();
      } catch {
        c.release(e as Error);
      }
      throw e;
    }
  }

  async function readEventsImpl(filter?: {
    corpusId?: string;
    claimId?: string;
    since?: number;
  }): Promise<ClaimEvent[]> {
    return withConn(async (c) => {
      const conditions: string[] = [];
      const params: unknown[] = [];
      let n = 0;
      conditions.push(`tenant_id = $${++n}`);
      params.push(tenantId);
      if (filter?.corpusId !== undefined) {
        conditions.push(`corpus_id = $${++n}`);
        params.push(filter.corpusId);
      }
      if (filter?.claimId !== undefined) {
        conditions.push(`claim_id = $${++n}`);
        params.push(filter.claimId);
      }
      if (filter?.since !== undefined) {
        conditions.push(`recorded >= $${++n}`);
        params.push(filter.since);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const { rows } = await c.query<PgEventRow>(
        `SELECT * FROM ${prefix}claim_events ${where} ORDER BY seq_pk ASC`,
        params
      );
      return rows.map(mapEvent);
    });
  }

  const base: AsyncStorageAdapter = {
    async close(): Promise<void> {
      // Pools are owned by the router (closeAll); nothing to release per-adapter.
    },

    async insertClaim(c: Claim): Promise<void> {
      await insertRow(c, null);
    },

    async insertBatch(cs: Claim[]): Promise<void> {
      await insertMany(cs, null);
    },

    async getClaim(id: ClaimId): Promise<Claim | undefined> {
      const row = await getClaimById(id);
      return row ? fromRow(row) : undefined;
    },

    async deleteClaim(id: ClaimId): Promise<void> {
      await withConn((c) =>
        c.query(`UPDATE ${prefix}claims SET status = 'deprecated' WHERE id = $1 AND tenant_id = $2`, [id, tenantId])
      );
    },

    async query(plan: ExecutionPlan): Promise<Claim[]> {
      return runQuery(plan, undefined);
    },

    async getIdempotencyRecord(scope: string, key: string): Promise<IdempotencyRecord | undefined> {
      return withConn(async (c) => {
        const { rows } = await c.query<PgIdempRow>(
          `SELECT * FROM ${prefix}idempotency WHERE scope = $1 AND key = $2 AND tenant_id = $3`,
          [scope, key, tenantId]
        );
        const row = rows[0];
        return row ? { result: row.result, createdAt: Number(row.created_at) } : undefined;
      });
    },

    async putIdempotencyRecord(scope: string, key: string, rec: IdempotencyRecord): Promise<void> {
      await withConn((c) =>
        c.query(putIdempotencySql(prefix), [scope, key, rec.result, rec.createdAt, tenantId])
      );
    },

    capabilities: () => CAPABILITIES,

    transaction,

    async maxRecordedSeq(corpusId: string): Promise<number> {
      return withConn(async (c) => {
        const { rows } = await c.query<{ m: string | number }>(
          `SELECT COALESCE(MAX(recorded_seq), 0) AS m FROM ${prefix}claims WHERE corpus_id = $1 AND tenant_id = $2`,
          [corpusId, tenantId]
        );
        return Number(rows[0].m);
      });
    },

    async appendEvent(e: ClaimEvent): Promise<void> {
      await withConn(async (c) => {
        const head = await c.query<{ entry_hash: string | null }>(headHashSql(prefix), [e.corpusId, tenantId]);
        const prevHash = head.rows[0]?.entry_hash ?? "";
        const entryHash = createHash("sha256")
          .update(canonicalEvent(e) + prevHash)
          .digest("hex");
        await c.query(appendEventSql(prefix), [
          e.op,
          e.corpusId,
          e.writer,
          e.claimId,
          e.deprecatedId ?? null,
          e.toStatus ?? null,
          e.reason ?? null,
          e.recorded,
          e.recordedSeq,
          entryHash,
          prevHash,
          tenantId,
        ]);
      });
    },

    readEvents(filter?): Promise<ClaimEvent[]> {
      return readEventsImpl(filter);
    },

    async putAnchoredRoot(row: AnchoredRootRow): Promise<void> {
      await withConn((c) =>
        c.query(putAnchorSql(prefix), [
          row.corpusId,
          row.epochId,
          row.root,
          row.signature,
          row.guarantee,
          row.at,
          tenantId,
        ])
      );
    },

    async getAnchoredRoots(
      corpusId: string,
      range?: { epochId?: string; since?: number }
    ): Promise<AnchoredRootRow[]> {
      return withConn(async (c) => {
        const conditions: string[] = ["corpus_id = $1", "tenant_id = $2"];
        const params: unknown[] = [corpusId, tenantId];
        let n = 2;
        if (range?.epochId !== undefined) {
          conditions.push(`epoch_id = $${++n}`);
          params.push(range.epochId);
        }
        if (range?.since !== undefined) {
          conditions.push(`at >= $${++n}`);
          params.push(range.since);
        }
        const { rows } = await c.query<PgAnchorRow>(
          `SELECT * FROM ${prefix}audit_anchors WHERE ${conditions.join(" AND ")} ORDER BY at ASC`,
          params
        );
        return rows.map((r) => ({
          corpusId: r.corpus_id,
          epochId: r.epoch_id,
          root: r.root,
          signature: r.signature,
          guarantee: r.guarantee,
          at: Number(r.at),
        }));
      });
    },

    scoped(scope: AdapterScope): AsyncStorageAdapter {
      return {
        ...base,
        async insertClaim(c: Claim): Promise<void> {
          await insertRow(c, scope.corpus);
        },
        async insertBatch(cs: Claim[]): Promise<void> {
          await insertMany(cs, scope.corpus);
        },
        async query(plan: ExecutionPlan): Promise<Claim[]> {
          // Ignore caller-supplied corpusId; force our bound scope (bypass-proof).
          return runQuery(plan, scope);
        },
        async deleteClaim(id: ClaimId): Promise<void> {
          await withConn((c) =>
            c.query(
              `UPDATE ${prefix}claims SET status = 'deprecated' WHERE id = $1 AND corpus_id = $2 AND tenant_id = $3`,
              [id, scope.corpus, tenantId]
            )
          );
        },
        async getClaim(id: ClaimId): Promise<Claim | undefined> {
          const row = await getClaimById(id);
          if (!row) return undefined;
          // corpus_id is NULL for base (un-scoped) inserts; null !== any string,
          // so base claims are invisible to scoped handles.
          if (row.corpus_id !== scope.corpus) return undefined;
          return fromRow(row);
        },
        readEvents(filter?): Promise<ClaimEvent[]> {
          return readEventsImpl({ ...filter, corpusId: scope.corpus });
        },
        capabilities: () => CAPABILITIES,
        scoped(s: AdapterScope): AsyncStorageAdapter {
          // Re-scoping delegates to base so it uses the new scope, not this one.
          return base.scoped!(s);
        },
      };
    },
  };

  return base;
}
