import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type {
  StorageAdapter,
  ExecutionPlan,
  AdapterCapabilities,
  IdempotencyRecord,
  ClaimEvent,
  AdapterScope,
  AnchoredRootRow,
} from "./adapter.js";
import type { Claim, Status, Source } from "../core/claim.js";
import { asCorpusId } from "../core/ids.js";
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
  entry_hash: string | null;
  prev_hash: string | null;
}

interface AnchorRow {
  corpus_id: string;
  epoch_id: string;
  root: string;
  signature: string | null;
  guarantee: string;
  at: number;
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
    // Null corpus_id (base-adapter rows) => field absent. NO workspace fallback.
    ...(row.corpus_id != null ? { corpusId: asCorpusId(row.corpus_id) } : {}),
  };
}

export function createSqliteAdapter(path = ":memory:"): StorageAdapter {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  // Wait for the write lock instead of immediately failing with SQLITE_BUSY when another
  // process/connection is writing (multi-process: MCP server + CLI, concurrent agents).
  db.pragma("busy_timeout = 5000");
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
      valid_to REAL,
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
      recorded_seq INTEGER,
      entry_hash TEXT,
      prev_hash TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_claim ON claim_events(claim_id);
    CREATE INDEX IF NOT EXISTS idx_events_corpus_seq ON claim_events(corpus_id, seq_pk);
    CREATE TABLE IF NOT EXISTS audit_anchors (
      corpus_id TEXT,
      epoch_id TEXT,
      root TEXT,
      signature TEXT,
      guarantee TEXT,
      at REAL,
      PRIMARY KEY(corpus_id, epoch_id)
    );
  `);

  // Idempotent migration: add corpus_id column to claims if it does not exist yet
  const claimColumns = (db.pragma("table_info(claims)") as Array<{ name: string }>).map(
    (col) => col.name
  );
  if (!claimColumns.includes("corpus_id")) {
    db.exec("ALTER TABLE claims ADD COLUMN corpus_id TEXT");
    // Backfill legacy rows: pre-corpus_id claims carry their corpus in `workspace`
    // (every Mneme write set workspace = corpusId), so the now-scoped facade still
    // sees them after the upgrade instead of silently filtering them out. New rows
    // are stamped with corpus_id at insert. Runs once, when the column is first added.
    db.exec("UPDATE claims SET corpus_id = workspace WHERE corpus_id IS NULL");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_claims_corpus ON claims(corpus_id)");
  // Covers the corpus-scoped contradiction-detection lookup (corpus_id + subject + key + scope_hash).
  // Without it the scoped query falls back to the corpus_id-only index and scans the whole (growing)
  // corpus per insert -> O(n^2) writes. This makes contradiction detection an O(log n) index seek.
  db.exec("CREATE INDEX IF NOT EXISTS idx_claims_corpus_identity ON claims(corpus_id, subject, key, scope_hash)");

  // Idempotent migration: add entry_hash / prev_hash to claim_events if not yet present
  const eventColumns = (db.pragma("table_info(claim_events)") as Array<{ name: string }>).map(
    (col) => col.name
  );
  if (!eventColumns.includes("entry_hash")) {
    db.exec("ALTER TABLE claim_events ADD COLUMN entry_hash TEXT");
  }
  if (!eventColumns.includes("prev_hash")) {
    db.exec("ALTER TABLE claim_events ADD COLUMN prev_hash TEXT");
  }

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
    `INSERT INTO claim_events (op, corpus_id, writer, claim_id, deprecated_id, to_status, reason, recorded, recorded_seq, entry_hash, prev_hash)
     VALUES (@op, @corpus_id, @writer, @claim_id, @deprecated_id, @to_status, @reason, @recorded, @recorded_seq, @entry_hash, @prev_hash)`
  );

  const headHashStmt = db.prepare<[string], { entry_hash: string | null }>(
    `SELECT entry_hash FROM claim_events WHERE corpus_id = ? ORDER BY seq_pk DESC LIMIT 1`
  );

  const putAnchorStmt = db.prepare<AnchorRow>(
    `INSERT OR REPLACE INTO audit_anchors (corpus_id, epoch_id, root, signature, guarantee, at)
     VALUES (@corpus_id, @epoch_id, @root, @signature, @guarantee, @at)`
  );

  const maxRecordedSeqStmt = db.prepare<[], { m: number }>(
    "SELECT COALESCE(MAX(recorded_seq), 0) AS m FROM claims"
  );

  /** Canonical serialization for hash-chain computation. */
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
      // IMMEDIATE: take the write lock at BEGIN so a concurrent writer can't interleave
      // mid-batch — matches the single-claim commit path's locking discipline.
      tx.immediate(cs);
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
        // JSON1 push-down (native_unindexed) is a v0.3 optimization.
      },
    }),

    transaction<T>(fn: () => T): T {
      // IMMEDIATE acquires the write lock at BEGIN, before the body reads maxRecordedSeq /
      // the chain head — so under concurrent writers the read is consistent with the write
      // and the per-corpus hash chain cannot fork from a stale-head read.
      return db.transaction(fn).immediate();
    },

    maxRecordedSeq(): number {
      return (maxRecordedSeqStmt.get() as { m: number }).m;
    },

    appendEvent(e: ClaimEvent): void {
      const headRow = headHashStmt.get(e.corpusId);
      const prevHash = headRow?.entry_hash ?? "";
      const entryHash = createHash("sha256")
        .update(canonicalEvent(e) + prevHash)
        .digest("hex");
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
        entry_hash: entryHash,
        prev_hash: prevHash,
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
        // entry_hash/prev_hash are NULL only for rows that predate the chain migration.
        // Empty string means genesis (no prior event in this corpus).
        if (row.entry_hash != null) event.entryHash = row.entry_hash;
        if (row.prev_hash != null) event.prevHash = row.prev_hash;
        return event;
      });
    },

    putAnchoredRoot(row: AnchoredRootRow): void {
      putAnchorStmt.run({
        corpus_id: row.corpusId,
        epoch_id: row.epochId,
        root: row.root,
        signature: row.signature,
        guarantee: row.guarantee,
        at: row.at,
      });
    },

    getAnchoredRoots(corpusId: string, range?: { epochId?: string; since?: number }): AnchoredRootRow[] {
      const conditions: string[] = ["corpus_id = ?"];
      const params: (string | number)[] = [corpusId];

      if (range?.epochId !== undefined) {
        conditions.push("epoch_id = ?");
        params.push(range.epochId);
      }
      if (range?.since !== undefined) {
        conditions.push("at >= ?");
        params.push(range.since);
      }

      const where = `WHERE ${conditions.join(" AND ")}`;
      const sql = `SELECT * FROM audit_anchors ${where} ORDER BY at ASC`;
      const stmt = db.prepare<unknown[], AnchorRow>(sql);
      const rows = stmt.all(...params);

      return rows.map((r) => ({
        corpusId: r.corpus_id,
        epochId: r.epoch_id,
        root: r.root,
        signature: r.signature,
        guarantee: r.guarantee,
        at: r.at,
      }));
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
          // IMMEDIATE: take the write lock at BEGIN so a concurrent writer can't interleave
          // mid-batch — matches the single-claim commit path's locking discipline.
          tx.immediate(cs);
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
