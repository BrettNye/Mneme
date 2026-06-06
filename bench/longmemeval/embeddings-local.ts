export { createLocalEmbeddingAdapter } from "../../src/adapters/embedding/transformers-local.js";

import type { EmbeddingAdapter, EmbeddingCache } from "../../src/algebra/embedding.js";
import { warmValues } from "../../src/algebra/embedding.js";

/**
 * Warm embeddings for a set of records and a question.
 * Thin wrapper over warmValues — canonicalization is handled there.
 */
export async function warmForQuestion(
  adapter: EmbeddingAdapter,
  cache: EmbeddingCache,
  records: { value: unknown }[],
  question: string,
): Promise<void> {
  await warmValues(adapter, cache, records.map((r) => r.value), [question]);
}
