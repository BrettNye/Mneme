import type { SimilarityFn } from "./similarity.js";
import { canonicalizeValue } from "../core/value.js";
import type { Value } from "../core/value.js";

// ── EmbeddingAdapter ─────────────────────────────────────────────────────────

export interface EmbeddingAdapter {
  /** Batched: returns one vector per text, in order. */
  embed(texts: string[]): Promise<number[][]>;
  /** EmbeddingModelId, e.g. "bge-small-en-v1.5" */
  id: string;
  /** Pinned revision, e.g. "q8@1" */
  version: string;
  /** Vector dimensionality */
  dim: number;
}

// ── EmbeddingCache ───────────────────────────────────────────────────────────

/** Cache keyed `\x1f${id}\x1f${version}\x1f${canonicalText}` (unit-separator delimiters prevent prefix collisions for ids containing "@") */
export class EmbeddingCache {
  private readonly store = new Map<string, Float32Array>();

  private key(adapter: { id: string; version: string }, text: string): string {
    return `\x1f${adapter.id}\x1f${adapter.version}\x1f${text}`;
  }

  get(adapter: { id: string; version: string }, text: string): Float32Array | undefined {
    return this.store.get(this.key(adapter, text));
  }

  set(adapter: { id: string; version: string }, text: string, v: Float32Array): void {
    this.store.set(this.key(adapter, text), v);
  }
}

// ── warmEmbeddings ───────────────────────────────────────────────────────────

/**
 * Batched warm-up: skips cache hits, validates dim + finiteness before storing.
 * Throws on dim mismatch or non-finite values (fail BEFORE queries).
 * Idempotent: re-running with already-warmed texts is a no-op.
 *
 * Note: on validation error, vectors before the failing index are already cached;
 * re-running after fixing the adapter will not re-fetch those earlier texts.
 */
export async function warmEmbeddings(
  adapter: EmbeddingAdapter,
  cache: EmbeddingCache,
  texts: string[]
): Promise<void> {
  // Deduplicate and find misses
  const misses = [...new Set(texts)].filter((t) => cache.get(adapter, t) === undefined);
  if (misses.length === 0) return;

  const vectors = await adapter.embed(misses);

  for (let i = 0; i < misses.length; i++) {
    const vec = vectors[i];
    if (vec.length !== adapter.dim) {
      throw new Error(
        `warmEmbeddings: adapter "${adapter.id}" returned vector of length ${vec.length} but dim=${adapter.dim} for text "${misses[i]}"`
      );
    }
    for (let j = 0; j < vec.length; j++) {
      if (!Number.isFinite(vec[j])) {
        throw new Error(
          `warmEmbeddings: adapter "${adapter.id}" returned non-finite value at index ${j} for text "${misses[i]}"`
        );
      }
    }
    cache.set(adapter, misses[i], new Float32Array(vec));
  }
}

// ── cosineOver ───────────────────────────────────────────────────────────────

/** Normalize a Value to the cache-key string: strings pass through, non-strings → canonicalizeValue */
function toText(v: Value): string {
  return typeof v === "string" ? v : canonicalizeValue(v);
}

/** Cosine similarity mapped to [0,1] via (1+cos)/2 */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const sqA = Math.sqrt(normA);
  const sqB = Math.sqrt(normB);
  if (sqA === 0 && sqB === 0) return 1; // zero vs zero: treat as identical
  const denom = sqA * sqB;
  if (denom === 0) return 0.5; // zero vs non-zero: undefined cosine → neutral midpoint
  const cos = dot / denom;
  return (1 + cos) / 2;
}

/**
 * Returns a SimilarityFn backed by cosine similarity over embeddings.
 * - version: "cosine@1"
 * - embeddingVersions: { [adapter.id]: adapter.version }
 * - isPure: true
 * - scoreOne: sync cache lookup + cosine mapped to [0,1]
 * - cache miss: ALWAYS throws naming the text + "run warmEmbeddings" (no fallback)
 */
export function cosineOver(adapter: EmbeddingAdapter, cache: EmbeddingCache): SimilarityFn {
  return {
    version: "cosine@1",
    isPure: true,
    embeddingVersions: { [adapter.id]: adapter.version },
    scoreOne(value: Value, query: Value): number {
      const vText = toText(value);
      const qText = toText(query);

      const vVec = cache.get(adapter, vText);
      if (!vVec) {
        throw new Error(
          `cosineOver: no embedding cached for "${vText}" — run warmEmbeddings first`
        );
      }
      const qVec = cache.get(adapter, qText);
      if (!qVec) {
        throw new Error(
          `cosineOver: no embedding cached for "${qText}" — run warmEmbeddings first`
        );
      }

      return cosine(vVec, qVec);
    },
  };
}

// ── Adapter Registry ─────────────────────────────────────────────────────────

const adapterRegistry = new Map<string, EmbeddingAdapter>();

/**
 * Register an EmbeddingAdapter by its id.
 * - Same-object re-register: no-op.
 * - Different-object collision: throws a descriptive plain Error.
 */
export function registerEmbeddingAdapter(adapter: EmbeddingAdapter): void {
  const existing = adapterRegistry.get(adapter.id);
  if (existing !== undefined) {
    if (existing === adapter) return; // same-object no-op
    throw new Error(
      `embedding adapter "${adapter.id}" already registered with a different implementation`
    );
  }
  adapterRegistry.set(adapter.id, adapter);
}

/**
 * Retrieve a registered EmbeddingAdapter by id.
 * Throws `no embedding adapter "${id}"` if not found.
 */
export function embeddingAdapter(id: string): EmbeddingAdapter {
  const adapter = adapterRegistry.get(id);
  if (!adapter) throw new Error(`no embedding adapter "${id}"`);
  return adapter;
}
