// Drift guard: runs the backend-agnostic AsyncStorageAdapter contract against
// a real Postgres (testcontainers). One container for the whole file; every
// `make()` call hands the contract a FRESH corpus so tests never collide in
// the shared DB/schema.
import { beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { startPg } from "./test-support.js";
import { createPostgresAdapter } from "./index.js";
import { dbPerTenantRouter } from "./tenant-router.js";
import { runAsyncAdapterContract } from "../adapter-contract.js";

let pool: Pool;
let stop: () => Promise<void>;
let n = 0;

beforeAll(async () => {
  ({ pool, stop } = await startPg());
}, 60_000);

afterAll(async () => {
  await stop?.();
});

runAsyncAdapterContract("postgres", async () =>
  createPostgresAdapter({ router: dbPerTenantRouter(() => pool), tenantId: "t1" }).scoped!({
    corpus: `c${++n}`,
  })
);
