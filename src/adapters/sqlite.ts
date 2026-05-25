import Database from "better-sqlite3";
import type {
  StorageAdapter,
  ExecutionPlan,
  AdapterCapabilities,
  IdempotencyRecord,
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
  tags_json: string;
  schema: string;
}

interface IdempotencyRow {
  scope: string;
  key: string;
  result: string;
  created_at: number;
}

function toRow(c: Claim): ClaimRow {
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
    tags_json: JSON.stringify(c.tags),
    schema: c.schema,
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
      tags_json TEXT,
      schema TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_claims_pks ON claims(profile, key, scope_hash);
    CREATE INDEX IF NOT EXISTS idx_claims_subject ON claims(subject);
    CREATE TABLE IF NOT EXISTS idempotency (
      scope TEXT,
      key TEXT,
      result TEXT,
      created_at REAL,
      PRIMARY KEY(scope, key)
    );
  `);

  const insertStmt = db.prepare<ClaimRow>(`
    INSERT OR REPLACE INTO claims (
      id, profile, workspace, subject, key, scope_hash, scope_json,
      value_json, value_hash, conf_distribution, conf_params, conf_raw,
      conf_effective, valid_from, valid_to, recorded, recorded_seq,
      status, source, provenance_json, evidence_json, tags_json, schema
    ) VALUES (
      @id, @profile, @workspace, @subject, @key, @scope_hash, @scope_json,
      @value_json, @value_hash, @conf_distribution, @conf_params, @conf_raw,
      @conf_effective, @valid_from, @valid_to, @recorded, @recorded_seq,
      @status, @source, @provenance_json, @evidence_json, @tags_json, @schema
    )
  `);

  const getStmt = db.prepare<[string], ClaimRow>(
    "SELECT * FROM claims WHERE id = ?"
  );

  const deleteStmt = db.prepare<[string]>(
    "UPDATE claims SET status = 'deprecated' WHERE id = ?"
  );

  const getIdempotencyStmt = db.prepare<[string, string], IdempotencyRow>(
    "SELECT * FROM idempotency WHERE scope = ? AND key = ?"
  );

  const putIdempotencyStmt = db.prepare<IdempotencyRow>(
    "INSERT OR REPLACE INTO idempotency (scope, key, result, created_at) VALUES (@scope, @key, @result, @created_at)"
  );

  return {
    insertClaim(c: Claim): void {
      insertStmt.run(toRow(c));
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
          insertStmt.run(toRow(r));
        }
      });
      tx(cs);
    },

    query(plan: ExecutionPlan): Claim[] {
      const conditions: string[] = [];
      const params: (string | number | string[])[] = [];

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

      let statusClause = "";
      if (plan.status !== undefined && plan.status.length > 0) {
        const placeholders = plan.status.map(() => "?").join(", ");
        statusClause = `status IN (${placeholders})`;
        conditions.push(statusClause);
        params.push(...plan.status);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const sql = `SELECT * FROM claims ${where}`;

      const flatParams = params.flatMap((p) => (Array.isArray(p) ? p : [p]));
      const stmt = db.prepare<unknown[], ClaimRow>(sql);
      const rows = stmt.all(...flatParams);
      return rows.map(fromRow);
    },

    getIdempotencyRecord(scope: string, key: string): IdempotencyRecord | undefined {
      const row = getIdempotencyStmt.get(scope, key);
      if (!row) return undefined;
      return { result: row.result, createdAt: row.created_at };
    },

    putIdempotencyRecord(scope: string, key: string, rec: IdempotencyRecord): void {
      putIdempotencyStmt.run({ scope, key, result: rec.result, created_at: rec.createdAt });
    },

    capabilities(): AdapterCapabilities {
      const lvl = "native_unindexed" as const;
      return {
        valuePredicateSupport: {
          equality: lvl,
          range: lvl,
          set_membership: lvl,
          regex: lvl,
          structural_pattern: lvl,
          null_check: lvl,
        },
      };
    },
  };
}
