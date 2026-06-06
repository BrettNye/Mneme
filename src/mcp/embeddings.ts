import type { EmbeddingAdapter } from "../algebra/embedding.js";
import type { SimilarityFn } from "../algebra/similarity.js";
import { EmbeddingCache, cosineOver, registerEmbeddingAdapter } from "../algebra/embedding.js";
import { registerSimilarity, hybridMax, simJaccard, similarityFn } from "../algebra/similarity.js";

export interface EmbeddingState {
  rankFn: "hybrid" | "jaccard";
  adapter?: EmbeddingAdapter;
  cache?: EmbeddingCache;
}

// ── Singleton state ──────────────────────────────────────────────────────────

let _state: EmbeddingState | null = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Register a similarity fn under `name` only when the slot is absent.
 * Strategy: "register only when absent" — if the name already resolves to ANY fn,
 * skip registration. This prevents /already registered/ collisions after
 * _resetEmbeddingsForTest because the global similarity registry is not cleared.
 */
function registerIfAbsent(name: string, fn: SimilarityFn): void {
  try {
    similarityFn(name); // resolves → already registered, skip
  } catch {
    // throws /no similarity fn/ → register it
    registerSimilarity(name, fn);
  }
}

// ── Default factory ──────────────────────────────────────────────────────────

async function defaultFactory(): Promise<EmbeddingAdapter> {
  const { createLocalEmbeddingAdapter } = await import("../adapters/embedding/transformers-local.js");
  return createLocalEmbeddingAdapter();
}

// ── initEmbeddings ───────────────────────────────────────────────────────────

/**
 * Lazy singleton. On first call:
 *   - invokes `factory` (defaults to createLocalEmbeddingAdapter)
 *   - success: registers adapter + cosine similarity + hybrid similarity; state.rankFn = "hybrid"
 *   - failure: emits ONE stderr warning, falls back to jaccard; state.rankFn = "jaccard"
 *
 * Idempotent: subsequent calls return the cached state without re-running the factory.
 *
 * KNOWN LIMITATION: failure is cached for the server's lifetime — restart to retry.
 *
 * Collision strategy: "register only when absent" — similarity fn slots are checked
 * before registration so a reset+re-init cycle never throws /already registered/.
 */
export async function initEmbeddings(
  factory: () => Promise<EmbeddingAdapter> = defaultFactory,
): Promise<EmbeddingState> {
  if (_state !== null) return _state;

  try {
    const adapter = await factory();
    const cache = new EmbeddingCache();
    const cosineFn = cosineOver(adapter, cache);
    const hybridFn = hybridMax(simJaccard, cosineFn);

    registerEmbeddingAdapter(adapter);
    registerIfAbsent("cosine", cosineFn);
    registerIfAbsent("hybrid", hybridFn);

    _state = { rankFn: "hybrid", adapter, cache };
  } catch (err) {
    console.error(
      `[mneme] embeddings unavailable — falling back to jaccard (restart to retry): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    _state = { rankFn: "jaccard" };
  }

  return _state;
}

// ── TEST-ONLY ─────────────────────────────────────────────────────────────────

/** TEST-ONLY: clears the cached singleton state so the next initEmbeddings call
 *  runs the factory again. Does NOT clear the global similarity/adapter registries. */
export function _resetEmbeddingsForTest(): void {
  _state = null;
}
