import type { EmbeddingAdapter, EmbeddingCache } from "../../src/algebra/embedding.js";
import { warmEmbeddings } from "../../src/algebra/embedding.js";
import type { Value } from "../../src/core/value.js";
import { canonicalizeValue } from "../../src/core/value.js";

/**
 * Lazy-loads the local feature-extraction pipeline (quantized bge-small-en-v1.5).
 * Package: @huggingface/transformers ^4.2.0
 * Model:   Xenova/bge-small-en-v1.5 (quantized q8 ONNX export)
 * Dim:     384
 */
export async function createLocalEmbeddingAdapter(): Promise<EmbeddingAdapter> {
  const { pipeline } = await import("@huggingface/transformers");
  let extractor;
  try {
    extractor = await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", {
      dtype: "q8",
    });
  } catch (err) {
    throw new Error(
      `createLocalEmbeddingAdapter: model load/download failed — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    id: "bge-small-en-v1.5",
    // IMPORTANT — manual version-bump obligation:
    // The EmbeddingCache is per-process, so there is no cross-version collision risk
    // there. BUT this version string IS recorded in replay provenance
    // (`embeddingModelVersions`), and replay availability checks compare against it.
    // Whenever `@huggingface/transformers` or the model export is upgraded (i.e. the
    // produced weights/vectors can change), this MUST be bumped (q8@2, q8@3, …) —
    // otherwise replay availability checks will falsely pass across weight changes.
    version: "q8@1",
    dim: 384,

    async embed(texts: string[]): Promise<number[][]> {
      const output = await extractor(texts, { pooling: "mean", normalize: true });
      // output is a Tensor; tolist() returns number[][] for a 2-D tensor
      return (output as { tolist(): number[][] }).tolist();
    },
  };
}

/**
 * Caller-side warm-up (audit B4): canonicalizes record values
 * (string pass-through, non-string → canonicalizeValue — matches cosineOver's rule)
 * plus the question, then delegates to warmEmbeddings.
 */
export async function warmForQuestion(
  adapter: EmbeddingAdapter,
  cache: EmbeddingCache,
  records: { value: unknown }[],
  question: string,
): Promise<void> {
  const texts: string[] = records.map((r) =>
    typeof r.value === "string" ? r.value : canonicalizeValue(r.value as Value),
  );
  texts.push(question);
  await warmEmbeddings(adapter, cache, texts);
}
