import type { EmbeddingAdapter } from "../../algebra/embedding.js";

/**
 * Lazy-loads the local feature-extraction pipeline (quantized bge-base-en-v1.5).
 * Package: @huggingface/transformers ^4.2.0
 * Model:   Xenova/bge-base-en-v1.5 (quantized q8 ONNX export)
 * Dim:     768
 */
export async function createLocalEmbeddingAdapter(): Promise<EmbeddingAdapter> {
  const { pipeline } = await import("@huggingface/transformers");
  let extractor;
  try {
    extractor = await pipeline("feature-extraction", "Xenova/bge-base-en-v1.5", {
      dtype: "q8",
    });
  } catch (err) {
    throw new Error(
      `createLocalEmbeddingAdapter: model load/download failed — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    id: "bge-base-en-v1.5",
    // IMPORTANT — manual version-bump obligation:
    // The EmbeddingCache is per-process, so there is no cross-version collision risk
    // there. BUT this version string IS recorded in replay provenance
    // (`embeddingModelVersions`), and replay availability checks compare against it.
    // Whenever `@huggingface/transformers` or the model export is upgraded (i.e. the
    // produced weights/vectors can change), this MUST be bumped (q8@2, q8@3, …) —
    // otherwise replay availability checks will falsely pass across weight changes.
    version: "q8@1",
    dim: 768,

    async embed(texts: string[]): Promise<number[][]> {
      const output = await extractor(texts, { pooling: "mean", normalize: true });
      // output is a Tensor; tolist() returns number[][] for a 2-D tensor
      return (output as { tolist(): number[][] }).tolist();
    },
  };
}
