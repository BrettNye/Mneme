/**
 * Shared test fixtures for src/mcp/ tests.
 *
 * freshSession():      opens a throw-away SQLite session in a tmp dir.
 * jaccardDeps:         EmbeddingState with rankFn="jaccard" (no adapter, no cache).
 * makeFakeHybridDeps(): builds a fake EmbeddingState with rankFn="hybrid" by
 *                       running initEmbeddings with a deterministic fake adapter
 *                       factory. Each call uses a unique adapter id so the global
 *                       embedding-adapter registry does not collide across invocations.
 *
 * Strategy for makeFakeHybridDeps: delegate to initEmbeddings so that the
 * similarity registry ("cosine", "hybrid") is populated exactly the same way the
 * production server does it. The returned state.adapter / state.cache are the
 * objects whose closure cosineOver holds, so warmValues(adapter, cache, ...) will
 * correctly populate the cache that the registered fn reads.
 *
 * Stale-closure note (documented-intentional): after the first successful
 * initEmbeddings call the "cosine" / "hybrid" slots are locked to that first
 * adapter's cache. Tests that need independent warm-up should call
 * _resetEmbeddingsForTest() between invocations (as the embeddings.test.ts does).
 * For the recall tests the stale closure is harmless — every test that exercises
 * the hybrid path calls makeFakeHybridDeps() once per test, and the warm-up
 * populates the correct cache.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "../surface/index.js";
import type { Session } from "../surface/index.js";
import type { EmbeddingState } from "./embeddings.js";
import { initEmbeddings } from "./embeddings.js";
import type { EmbeddingAdapter } from "../algebra/embedding.js";

export function freshSession(): Session {
  const db = join(mkdtempSync(join(tmpdir(), "mneme-mcp-")), "store.db");
  return openSession({ dbPath: db, writer: "test" });
}

/** Jaccard-only deps — no warm-up needed, no adapter/cache. */
export const jaccardDeps: EmbeddingState = { rankFn: "jaccard" };

let _fakeAdapterSeq = 0;

/**
 * Build a deterministic fake EmbeddingState with rankFn="hybrid".
 *
 * Uses initEmbeddings with a fake factory that returns a constant [0.5, 0.5]
 * vector for every text. Each call generates a new unique adapter id to avoid
 * the global adapter-registry collision (same-id, different-object → throws).
 *
 * Returns the EmbeddingState produced by initEmbeddings (rankFn="hybrid",
 * adapter, cache all set). The adapter+cache in the returned state are the
 * SAME objects closed over by the registered "cosine"/"hybrid" similarity fns
 * (on the first call; subsequent calls may reuse the same fns due to
 * registerIfAbsent — see stale-closure note above).
 */
export async function makeFakeHybridDeps(): Promise<EmbeddingState> {
  const id = `fake-hybrid-adapter-${++_fakeAdapterSeq}`;
  const adapter: EmbeddingAdapter = {
    id,
    version: "v1",
    dim: 2,
    embed: async (texts) => texts.map(() => [0.5, 0.5]),
  };
  return initEmbeddings(async () => adapter);
}
