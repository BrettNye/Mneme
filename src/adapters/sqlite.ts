import Database from "better-sqlite3";
import type {
  StorageAdapter,
  ExecutionPlan,
  AdapterCapabilities,
  IdempotencyRecord,
  ClaimEvent,
  AdapterScope,
} from "./adapter.js";
import type { Claim, Status, Source } from "../core/claim.js";
import type { ClaimId, ProfileId, WorkspaceId } from "../core/ids.js";
import type { Scope } from "../core/scope.js";
import type { Value } from "../core/value.js";
import type { Provenance } from "../core/provenance.js";
import type { EvidenceRef } from "../core/evidence.js";
import type { Confidence } from "../core/confidence.js";
import { serializeParams, deserializeParams } from "../distribution/registry.js";

interface ClaimRow {
  id: string;
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
  recorded_seq: number;
  status: string;
  source: string;
  provenance_json: string;
  evidence_json: string;
  audience_json: string;
  tags_json: string;
  schema: string;
  run_id: string | null;
  corpus_id: string | null;
}

interface IdempotencyRow {
  scope: string;
  key: string;
  result: string;
  created_at: number;
}

interface ClaimEventRow {
  seq_pk: number;
  op: string;
  corpus_id: string;
  writer: string;
  claim_id: string;
  deprecated_id: string | null;
  to_status: string | null;
  reason: string | null;
  recorded: number;
  recorded_seq: number;
}

function toRow(c: Claim, corpusId: string | null = null): ClaimRow {
  return {
    id: c.id,
    profile: c.profile,
    workspace: c.workspace,
    subject: c.subject,
    key: c.key,
    scope_hash: c.scopeHash,
    scope_json: JSON.stringify(c.scope),
    value_json: JSON.stringify(c.value),
    value_hash: c.valueHash,
    conf_distribution: c.confidence.distribution,
    conf_params: serializeParams(c.confidence.distribution, c.confidence.parameters),
    conf_raw: c.confidence.raw,
    conf_effective: c.confidence.effective ?? null,
    valid_from: c.valid.from,
    valid_to: c.valid.to,
    recorded: c.recorded,
    recorded_seq: c.recordedSeq,
    status: c.status,
    source: c.source,
    provenance_json: JSON.stringify(c.provenance),
    evidence_json: JSON.stringify(c.evidence),
    audience_json: JSON.stringify(c.audience ?? {}),
    tags_json: JSON.stringify(c.tags),
    schema: c.schema,
    run_id: c.provenance.runId ?? null,
    corpus_id: corpusId,
  };
}

function fromRow(row: ClaimRow): Claim {
  const distribution = row.conf_distribution;
  const confidence = {
    distribution: distribution as Confidence["distribution"],
    parameters: deserializeParams(distribution, row.conf_params) as Confidence["parameters"],
    raw: row.conf_raw,
    ...(row.conf_effective != null ? { effective: row.conf_effective } : {}),
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
    valid: { from: row.valid_from, to: row.valid_to },
    recorded: row.recorded,
    recordedSeq: row.recorded_seq,
    status: row.status as Status,
    source: row.source as Source,
    provenance: JSON.parse(row.provenance_json) as Provenance,
    evidence: JSON.parse(row.evidence_json) as EvidenceRef[],
    audience: row.audience_json ? JSON.parse(row.audience_json) : {},
    tags: JSON.parse(row.tags_json) as string[],
    schema: row.schema,
  };
}

export function createSqliteAdapter(path = ":memory:"): StorageAdapter {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS claims (
      id TEXT PRIMARY KEY,
      profile TEXT,
      workspace TEXT,
      subject TEXT,
      key TEXT,
      scope_hash TEXT,
      scope_json TEXT,
      value_json TEXT,
      value_hash TEXT,
      conf_distribution TEXT,
      conf_params TEXT,
      conf_raw REAL,
      conf_effective REAL,
      valid_from REAL,
      valid_to REAL,  -- JS Infinity round-trips correctly: IEEE-754 REAL stores +Inf, so open intervals survive a db reload
      recorded REAL,
      recorded_seq INTEGER,
      status TEXT,
      source TEXT,
      provenance_json TEXT,
      evidence_json TEXT,
      audience_json TEXT,
      tags_json TEXT,
      schema TEXT,
      run_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_claims_pks ON claims(profile, key, scope_hash);
    CREATE INDEX IF NOT EXISTS idx_claims_subject ON claims(subject);
    CREATE INDEX IF NOT EXISTS idx_claims_run_id ON claims(run_id);
    -- maxRecordedSeq() runs SELECT MAX(recorded_seq) on every commit; without this
    -- index that is a full-table scan (O(n) per insert → O(n^2) import). With it,
    -- SQLite reads the max from the index tail in O(log n).
    CREATE INDEX IF NOT EXISTS idx_claims_recorded_seq ON claims(recorded_seq);
    CREATE TABLE IF NOT EXISTS idempotency (
      scope TEXT,
      key TEXT,
      result TEXT,
      created_at REAL,
      PRIMARY KEY(scope, key)
    );
    CREATE TABLE IF NOT EXISTS claim_events (
      seq_pk INTEGER PRIMARY KEY AUTOINCREMENT,
      op TEXT,
      corpus_id TEXT,
      writer TEXT,
      claim_id TEXT,
      deprecated_id TEXT,
      to_status TEXT,
      reason TEXT,
      recorded REAL,
      recorded_seq INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_events_claim ON claim_events(claim_id);
  `);

  // Idempotent migration: add corpus_id column if it doesn't exist yet
  const claimColumns = (db.pragma("table_info(claims)") as Array<{ name: string }>).map(
    (col) => col.name
  );
  if (!claimColumns.includes("corpus_id")) {
    db.exec("ALTER TABLE claims ADD COLUMN corpus_id TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_claims_corpus ON claims(corpus_id)");

  const insertStmt = db.prepare<ClaimRow>(`
    INSERT OR REPLACE INTO claims (
      id, profile, workspace, subject, key, scope_hash, scope_json,
      value_json, value_hash, conf_distribution, conf_params, conf_raw,
      conf_effective, valid_from, valid_to, recorded, recorded_seq,
      status, source, provenance_json, evidence_json, audience_json, tags_json, schema,
      run_id, corpus_id
    ) VALUES (
      @id, @profile, @workspace, @subject, @key, @scope_hash, @scope_json,
      @value_json, @value_hash, @conf_distribution, @conf_params, @conf_raw,
      @conf_effective, @valid_from, @valid_to, @recorded, @recorded_seq,
      @status, @source, @provenance_json, @evidence_json, @audience_json, @tags_json, @schema,
      @run_id, @corpus_id
    )
  `);

  const getStmt = db.prepare<[string], ClaimRow>(
    "SELECT * FROM claims WHERE id = ?"
  );

  const deleteStmt = db.prepare<[string]>(
    "UPDATE claims SET status = 'deprecated' WHERE id = ?"
  );

  const scopedDeleteStmt = db.prepare<[string, string]>(
    "UPDATE claims SET status = 'deprecated' WHERE id = ? AND corpus_id = ?"
  );

  const getIdempotencyStmt = db.prepare<[string, string], IdempotencyRow>(
    "SELECT * FROM idempotency WHERE scope = ? AND key = ?"
  );

  const putIdempotencyStmt = db.prepare<IdempotencyRow>(
    "INSERT OR REPLACE INTO idempotency (scope, key, result, created_at) VALUES (@scope, @key, @result, @created_at)"
  );

  const eventInsertStmt = db.prepare<Omit<ClaimEventRow, "seq_pk">>(
    `INSERT INTO claim_events (op, corpus_id, writer, claim_id, deprecated_id, to_status, reason, recorded, recorded_seq)
     VALUES (@op, @corpus_id, @writer, @claim_id, @deprecated_id, @to_status, @reason, @recorded, @recorded_seq)`
  );

  const maxRecordedSeqStmt = db.prepare<[], { m: number }>(
    "SELECT COALESCE(MAX(recorded_seq), 0) AS m FROM claims"
  );

  function executeQuery(plan: ExecutionPlan, force?: AdapterScope): Claim[] {
    const conditions: string[] = [];
    const params: (string | number | string[])[] = [];

    // Forced scope overrides any caller-supplied corpus (bypass-proof isolation)
    if (force !== undefined) {
      conditions.push("corpus_id = ?");
      params.push(force.corpus);
      if (force.profile !== undefined) {
        conditions.push("profile = ?");
        params.push(force.profile);
      }
    }

    if (plan.subject !== undefined) {
      conditions.push("subject = ?");
      params.push(plan.subject);
    }
    if (plan.key !== undefined) {
      conditions.push("key = ?");
      params.push(plan.key);
    }
    if (plan.scopeHash !== undefined) {
      conditions.push("scope_hash = ?");
      params.push(plan.scopeHash);
    }
    if (plan.recordedAtMost !== undefined) {
      conditions.push("recorded <= ?");
      params.push(plan.recordedAtMost);
    }

    if (plan.status !== undefined && plan.status.length > 0) {
      const placeholders = plan.status.map(() => "?").join(", ");
      conditions.push(`status IN (${placeholders})`);
      params.push(...plan.status);
    }

    if (plan.runIds !== undefined && plan.runIds.length > 0) {
      const placeholders = plan.runIds.map(() => "?").join(", ");
      conditions.push(`run_id IN (${placeholders})`);
      params.push(...plan.runIds);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT * FROM claims ${where}`;

    const flatParams = params.flatMap((p) => (Array.isArray(p) ? p : [p]));
    const stmt = db.prepare<unknown[], ClaimRow>(sql);
    const rows = stmt.all(...flatParams);
    return rows.map(fromRow);
  }

  const base: StorageAdapter = {
    close(): void {
      db.close();
    },

    insertClaim(c: Claim): void {
      insertStmt.run(toRow(c, null));
    },

    getClaim(id: ClaimId): Claim | undefined {
      const row = getStmt.get(id);
      if (!row) return undefined;
      return fromRow(row);
    },

    deleteClaim(id: ClaimId): void {
      deleteStmt.run(id);
    },

    insertBatch(cs: Claim[]): void {
      const tx = db.transaction((rows: Claim[]) => {
        for (const r of rows) {
          insertStmt.run(toRow(r, null));
        }
      });
      tx(cs);
    },

    query(plan: ExecutionPlan): Claim[] {
      return executeQuery(plan, undefined);
    },

    getIdempotencyRecord(scope: string, key: string): IdempotencyRecord | undefined {
      const row = getIdempotencyStmt.get(scope, key);
      if (!row) return undefined;
      return { result: row.result, createdAt: row.created_at };
    },

    putIdempotencyRecord(scope: string, key: string, rec: IdempotencyRecord): void {
      putIdempotencyStmt.run({ scope, key, result: rec.result, created_at: rec.createdAt });
    },

    capabilities: () => ({
      valuePredicateSupport: {
        equality: "fallback_in_memory",
        range: "fallback_in_memory",
        set_membership: "fallback_in_memory",
        regex: "fallback_in_memory",
        structural_pattern: "fallback_in_memory",
        null_check: "fallback_in_memory",
        // JSON1 push-down (→ native_unindexed) is a v0.3 optimization.
      },
    }),

    transaction<T>(fn: () => T): T {
      return db.transaction(fn)();
    },

    maxRecordedSeq(): number {
      return (maxRecordedSeqStmt.get() as { m: number }).m;
    },

    appendEvent(e: ClaimEvent): void {
      eventInsertStmt.run({
        op: e.op,
        corpus_id: e.corpusId,
        writer: e.writer,
        claim_id: e.claimId,
        deprecated_id: e.deprecatedId ?? null,
        to_status: e.toStatus ?? null,
        reason: e.reason ?? null,
        recorded: e.recorded,
        recorded_seq: e.recordedSeq,
      });
    },

    readEvents(filter?: { corpusId?: string; claimId?: string; since?: number }): ClaimEvent[] {
      const conditions: string[] = [];
      const params: (string | number)[] = [];

      if (filter?.corpusId !== undefined) {
        conditions.push("corpus_id = ?");
        params.push(filter.corpusId);
      }
      if (filter?.claimId !== undefined) {
        conditions.push("claim_id = ?");
        params.push(filter.claimId);
      }
      if (filter?.since !== undefined) {
        conditions.push("recorded >= ?");
        params.push(filter.since);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const sql = `SELECT * FROM claim_events ${where} ORDER BY seq_pk ASC`;
      const stmt = db.prepare<unknown[], ClaimEventRow>(sql);
      const rows = stmt.all(...params);

      return rows.map((row) => {
        const event: ClaimEvent = {
          op: row.op as ClaimEvent["op"],
          corpusId: row.corpus_id,
          writer: row.writer,
          claimId: row.claim_id,
          recorded: row.recorded,
          recordedSeq: row.recorded_seq,
        };
        if (row.deprecated_id != null) event.deprecatedId = row.deprecated_id;
        if (row.to_status != null) event.toStatus = row.to_status;
        if (row.reason != null) event.reason = row.reason;
        return event;
      });
    },

    scoped(scope: AdapterScope): StorageAdapter {
      return {
        ...base,
        insertClaim(c: Claim): void {
          insertStmt.run(toRow(c, scope.corpus));
        },
        insertBatch(cs: Claim[]): void {
          const tx = db.transaction((rows: Claim[]) => {
            for (const r of rows) {
              insertStmt.run(toRow(r, scope.corpus));
            }
          });
          tx(cs);
        },
        query(_plan: ExecutionPlan): Claim[] {
          // Ignore caller-supplied corpusId; force our bound scope (bypass-proof)
          return executeQuery(_plan, scope);
        },
        deleteClaim(id: ClaimId): void {
          scopedDeleteStmt.run(id, scope.corpus);
        },
        getClaim(id: ClaimId): Claim | undefined {
          const row = getStmt.get(id);
          if (!row) return undefined;
          // corpus_id is null for base (un-scoped) inserts; null !== any string, so base claims are invisible to scoped handles
          if (row.corpus_id !== scope.corpus) return undefined;
          return fromRow(row);
        },
        readEvents(filter?: { corpusId?: string; claimId?: string; since?: number }): ClaimEvent[] {
          return base.readEvents({ ...filter, corpusId: scope.corpus });
        },
        scoped(s: AdapterScope): StorageAdapter {
          // Re-scoping delegates to base so it uses the new scope, not this scope
          return base.scoped!(s);
        },
      };
    },
  };

  return base;
}
