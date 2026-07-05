// Pure SQL-string builders for the Postgres adapter (NO DB handle, NO `pg` import).
// Mirrors src/adapters/sqlite.ts's executeQuery/insert/event/anchor/idempotency
// statements, but in Postgres syntax with `$n` parameter placeholders. Row
// mapping (fromRow/toRow) is owned by the pg adapter itself, not here.
import type { ExecutionPlan, AdapterScope } from "../adapter-types.js";

export interface SqlText {
  text: string;
  params: unknown[];
}

/**
 * Build a parameterized SELECT against `${prefix}claims` matching
 * sqlite.ts's executeQuery ordering: forced scope (corpus_id, then profile)
 * FIRST, then plan predicates (subject, key, scopeHash, recordedAtMost,
 * status IN (...), runIds IN (...)), then the optional tenantPredicate LAST.
 * ORDER BY recorded_seq ASC, id COLLATE "C" ASC to match SQLite's binary
 * (byte-order) `id ASC` collation.
 */
export function buildQuery(
  prefix: string,
  plan: ExecutionPlan,
  force?: AdapterScope,
  tenantPredicate?: { sql: string; params: unknown[] }
): SqlText {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let n = 0;
  const next = () => ++n;

  if (force !== undefined) {
    conditions.push(`corpus_id = $${next()}`);
    params.push(force.corpus);
    if (force.profile !== undefined) {
      conditions.push(`profile = $${next()}`);
      params.push(force.profile);
    }
  }

  if (plan.subject !== undefined) {
    conditions.push(`subject = $${next()}`);
    params.push(plan.subject);
  }
  if (plan.key !== undefined) {
    conditions.push(`key = $${next()}`);
    params.push(plan.key);
  }
  if (plan.scopeHash !== undefined) {
    conditions.push(`scope_hash = $${next()}`);
    params.push(plan.scopeHash);
  }
  if (plan.recordedAtMost !== undefined) {
    conditions.push(`recorded <= $${next()}`);
    params.push(plan.recordedAtMost);
  }
  if (plan.status !== undefined && plan.status.length > 0) {
    const placeholders = plan.status.map(() => `$${next()}`).join(", ");
    conditions.push(`status IN (${placeholders})`);
    params.push(...plan.status);
  }
  if (plan.runIds !== undefined && plan.runIds.length > 0) {
    const placeholders = plan.runIds.map(() => `$${next()}`).join(", ");
    conditions.push(`run_id IN (${placeholders})`);
    params.push(...plan.runIds);
  }

  if (tenantPredicate !== undefined) {
    // Renumber the caller-supplied placeholder(s) so they follow the
    // preceding conditions' numbering (the caller writes `$N` as a
    // placeholder marker since it doesn't know the final offset).
    let sql = tenantPredicate.sql;
    for (const _ of tenantPredicate.params) {
      sql = sql.replace("$N", `$${next()}`);
    }
    conditions.push(sql);
    params.push(...tenantPredicate.params);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const text = `SELECT * FROM ${prefix}claims ${where} ORDER BY recorded_seq ASC, id COLLATE "C" ASC`.trim();

  return { text, params };
}

/** Claim upsert: on primary-key conflict, overwrite the row (mirrors SQLite's INSERT OR REPLACE). */
export function insertClaimSql(prefix: string): string {
  return `
    INSERT INTO ${prefix}claims (
      id, profile, workspace, subject, key, scope_hash, scope_json,
      value_json, value_hash, conf_distribution, conf_params, conf_raw,
      conf_effective, valid_from, valid_to, recorded, recorded_seq,
      status, source, provenance_json, evidence_json, audience_json, tags_json, schema,
      run_id, corpus_id
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12,
      $13, $14, $15, $16, $17,
      $18, $19, $20, $21, $22, $23, $24,
      $25, $26
    )
    ON CONFLICT (id) DO UPDATE SET
      profile = EXCLUDED.profile,
      workspace = EXCLUDED.workspace,
      subject = EXCLUDED.subject,
      key = EXCLUDED.key,
      scope_hash = EXCLUDED.scope_hash,
      scope_json = EXCLUDED.scope_json,
      value_json = EXCLUDED.value_json,
      value_hash = EXCLUDED.value_hash,
      conf_distribution = EXCLUDED.conf_distribution,
      conf_params = EXCLUDED.conf_params,
      conf_raw = EXCLUDED.conf_raw,
      conf_effective = EXCLUDED.conf_effective,
      valid_from = EXCLUDED.valid_from,
      valid_to = EXCLUDED.valid_to,
      recorded = EXCLUDED.recorded,
      recorded_seq = EXCLUDED.recorded_seq,
      status = EXCLUDED.status,
      source = EXCLUDED.source,
      provenance_json = EXCLUDED.provenance_json,
      evidence_json = EXCLUDED.evidence_json,
      audience_json = EXCLUDED.audience_json,
      tags_json = EXCLUDED.tags_json,
      schema = EXCLUDED.schema,
      run_id = EXCLUDED.run_id,
      corpus_id = EXCLUDED.corpus_id
  `.trim();
}

/** Head-of-chain lookup for hash-chain computation: most recent event's entry_hash for a corpus. */
export function headHashSql(prefix: string): string {
  return `SELECT entry_hash FROM ${prefix}claim_events WHERE corpus_id = $1 ORDER BY seq_pk DESC LIMIT 1`;
}

/** Append a claim event (hash-chain link) to the append-only event log. */
export function appendEventSql(prefix: string): string {
  return `
    INSERT INTO ${prefix}claim_events (
      op, corpus_id, writer, claim_id, deprecated_id, to_status, reason,
      recorded, recorded_seq, entry_hash, prev_hash
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11
    )
  `.trim();
}

/** Idempotency-record insert: first writer for (scope, key) wins; later writes are no-ops. */
export function putIdempotencySql(prefix: string): string {
  return `
    INSERT INTO ${prefix}idempotency (scope, key, result, created_at)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (scope, key) DO NOTHING
  `.trim();
}

/** Anchored-Merkle-root upsert: re-anchoring the same (corpus_id, epoch_id) overwrites. */
export function putAnchorSql(prefix: string): string {
  return `
    INSERT INTO ${prefix}audit_anchors (corpus_id, epoch_id, root, signature, guarantee, at)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (corpus_id, epoch_id) DO UPDATE SET
      root = EXCLUDED.root,
      signature = EXCLUDED.signature,
      guarantee = EXCLUDED.guarantee,
      at = EXCLUDED.at
  `.trim();
}
