import type { Session } from "./types.js";
import type { Corpus } from "../algebra/types.js";
import type { KeyAliasMap } from "../retrieval/key-alias.js";
import { clustersOf } from "../algebra/contradiction.js";

/** Effective per-key cardinality: the corpus's stored schema.keyCardinality merged OVER the
 *  deps/global map (per-key, corpus declaration wins). undefined when the merged map is empty. */
export function resolveKeyCardinality(
  session: Session, corpus: string, depsCardinality?: Record<string, "single" | "multi">,
): Record<string, "single" | "multi"> | undefined {
  const def = session.mneme.listCorpora((c) => c.id === corpus)[0] as
    | { schema?: { keyCardinality?: Record<string, "single" | "multi"> } } | undefined;
  const merged = { ...(depsCardinality ?? {}), ...(def?.schema?.keyCardinality ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** Advisory warnings for single-cardinality (subject, canonical key) groups holding ≥2 distinct
 *  values. Reuses clustersOf (excludes multi keys; returns only >=2-distinct clusters) — the
 *  cluster former behind pairsOf. `corpus` MUST be the pre-⊥ corpus (τ_valid + ⊕_dedupe applied). */
export function cardinalitySafetyWarnings(
  corpus: Corpus, effectiveCardinality: Record<string, "single" | "multi"> | undefined,
  aliasMap: KeyAliasMap,
): string[] {
  const clusters = clustersOf(corpus, 0, { keyCardinality: effectiveCardinality, keyAliases: aliasMap });
  return clusters
    .filter((c) => c.distinctValues >= 2) // clustersOf already guarantees this; explicit + safe
    .map((c) =>
      `single-cardinality (subject:${c.triple.subject}, key:${c.triple.key}) holds ${c.distinctValues}` +
      ` distinct values — recall serves only the latest; declare keyCardinality:"multi" if they should coexist.`,
    );
}
