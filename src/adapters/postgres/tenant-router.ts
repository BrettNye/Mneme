// The routing seam that resolves a tenantId to a scoped connection. Pure
// routing -- migration is schema.ts's concern, not here.
//
// SCHEMA CAVEAT: the base `MIGRATIONS` in `./schema.js` mirror the SQLite
// schema and DO NOT include a `tenant_id` column. So `rowLevelRouter`'s
// `tenant_id` predicate targets a column a ROW-LEVEL DEPLOYMENT must add via
// an augmented schema; the base public schema (as shipped by `MIGRATIONS`)
// is used by the schema/db-per-tenant providers instead, which isolate by
// routing (a distinct schema or a distinct pool/database), not by an
// injected row predicate.
import type { Pool, PoolClient } from "pg";

export interface ResolvedConnection {
  /** A client from the right pool; caller is responsible for releasing it. */
  connect(): Promise<PoolClient>;
  /** "" | validated "tenant_acme." schema-qualified identifier prefix (NOT via SET search_path). */
  schemaPrefix: string;
  /** Row-level isolation predicate only; absent for routing-based providers. */
  tenantPredicate?: { sql: string; params: unknown[] };
}

export interface TenantRouter {
  /** Throws on unknown/invalid tenant. */
  resolve(tenantId: string): ResolvedConnection;
  closeAll(): Promise<void>;
}

/**
 * Row-level isolation: every tenant shares the same pool/schema; isolation
 * is enforced by an injected `tenant_id = $` predicate that the caller (e.g.
 * sql.ts's `buildQuery`) renumbers into the final query. Requires the
 * consuming schema to actually have a `tenant_id` column -- the base
 * `MIGRATIONS` do not (see the file-header caveat).
 */
export function rowLevelRouter(pool: Pool): TenantRouter {
  return {
    resolve(tenantId: string): ResolvedConnection {
      if (!tenantId || !tenantId.trim()) {
        throw new Error("rowLevelRouter.resolve: tenantId must be non-empty");
      }
      return {
        connect: () => pool.connect(),
        schemaPrefix: "",
        tenantPredicate: { sql: "tenant_id = $", params: [tenantId] },
      };
    },
    closeAll: () => pool.end(),
  };
}

const SCHEMA_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;

/**
 * Schema-per-tenant isolation: `schemaFor(tenantId)` maps a tenant to a
 * schema name, validated against a strict allow-list pattern before being
 * used as a `"<schema>."` identifier prefix. NEVER issues `SET search_path`
 * and NEVER interpolates the raw `tenantId` -- only the validated schema
 * name coming back from `schemaFor`.
 */
export function schemaPerTenantRouter(
  pool: Pool,
  schemaFor: (tenantId: string) => string
): TenantRouter {
  return {
    resolve(tenantId: string): ResolvedConnection {
      const schema = schemaFor(tenantId);
      if (!schema || !SCHEMA_NAME_PATTERN.test(schema)) {
        throw new Error(
          `schemaPerTenantRouter.resolve: invalid/unknown schema for tenant ${JSON.stringify(tenantId)}`
        );
      }
      return {
        connect: () => pool.connect(),
        schemaPrefix: `${schema}.`,
      };
    },
    closeAll: () => pool.end(),
  };
}

/**
 * Database-per-tenant isolation: `poolFor(tenantId)` returns the distinct
 * `Pool` for that tenant (throwing itself is how a caller signals an
 * unknown tenant). No schema prefix, no row predicate -- isolation is
 * entirely a function of which pool/database `connect()` reaches.
 */
export function dbPerTenantRouter(poolFor: (tenantId: string) => Pool): TenantRouter {
  const handedOut = new Set<Pool>();
  return {
    resolve(tenantId: string): ResolvedConnection {
      const pool = poolFor(tenantId);
      handedOut.add(pool);
      return {
        connect: () => pool.connect(),
        schemaPrefix: "",
      };
    },
    closeAll: async () => {
      await Promise.all([...handedOut].map((p) => p.end()));
      handedOut.clear();
    },
  };
}
