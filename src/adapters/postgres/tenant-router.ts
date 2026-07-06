// The routing seam that resolves a tenantId to a scoped connection. Pure
// routing -- migration is schema.ts's concern, not here.
//
// Row-level isolation works against the BASE schema: Migration v2 adds a
// `tenant_id text NOT NULL DEFAULT ''` column to every table. `rowLevelRouter`
// exposes the resolved tenant VALUE (`tenantId`); the adapter uniformly stamps
// and filters `tenant_id` on every write/read. The schema/db-per-tenant
// providers leave `tenantId` undefined -> the adapter uses "" -> behavior is
// identical to a single-tenant deployment, while they isolate by routing (a
// distinct schema or a distinct pool/database).
import type { Pool, PoolClient } from "pg";

export interface ResolvedConnection {
  /** A client from the right pool; caller is responsible for releasing it. */
  connect(): Promise<PoolClient>;
  /** "" | validated "tenant_acme." schema-qualified identifier prefix (NOT via SET search_path). */
  schemaPrefix: string;
  /**
   * The row-level tenant VALUE the adapter stamps/filters as `tenant_id`;
   * absent for routing-based providers (adapter then uses "").
   */
  tenantId?: string;
}

export interface TenantRouter {
  /** Throws on unknown/invalid tenant. */
  resolve(tenantId: string): ResolvedConnection;
  closeAll(): Promise<void>;
}

/**
 * Row-level isolation: every tenant shares the same pool/schema; isolation
 * is enforced by the adapter uniformly stamping/filtering the resolved
 * `tenantId` as the `tenant_id` column (added by Migration v2 to the base
 * schema).
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
        tenantId,
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
