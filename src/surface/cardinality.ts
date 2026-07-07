import type { Session } from "./types.js";
import type { Corpus } from "../algebra/types.js";
import type { KeyAliasMap } from "../retrieval/key-alias.js";
import { clustersOf } from "../algebra/contradiction.js";
import type { RecallSource } from "./recall.js";

/** Effective per-key cardinality: the source's stored schema.keyCardinality merged OVER the
 *  deps/global map (per-key, corpus declaration wins). undefined when the merged map is empty.
 *  Pure over the `RecallSource` read seam (task-pure-helpers); `resolveKeyCardinality` delegates
 *  with `session.mneme`. */
export function effectiveKeyCardinality(
  source: RecallSource, corpus: string, override?: Record<string, "single" | "multi">,
): Record<string, "single" | "multi"> | undefined {
  const def = source.listCorpora((c) => c.id === corpus)[0];
  const merged = { ...(override ?? {}), ...(def?.schema?.keyCardinality ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** Sync wrapper — exact signature preserved; delegates with `session.mneme`. */
export function resolveKeyCardinality(
  session: Session, corpus: string, depsCardinality?: Record<string, "single" | "multi">,
): Record<string, "single" | "multi"> | undefined {
  return effectiveKeyCardinality(session.mneme, corpus, depsCardinality);
}

export interface CardinalityCollision {
  subject: string;
  key: string;
  distinctValues: number;
  totalClaims: number;
}

/** Single-cardinality (subject, canonical key) groups holding ≥2 distinct values — structured.
 *  Reuses clustersOf (excludes multi keys; returns only >=2-distinct clusters) — the cluster
 *  former behind pairsOf. `corpus` MUST be the pre-⊥ corpus (τ_valid + ⊕_dedupe applied). */
export function cardinalityCollisions(
  corpus: Corpus, effectiveCardinality: Record<string, "single" | "multi"> | undefined,
  aliasMap: KeyAliasMap,
): CardinalityCollision[] {
  return clustersOf(corpus, 0, { keyCardinality: effectiveCardinality, keyAliases: aliasMap })
    .filter((c) => c.distinctValues >= 2) // clustersOf already guarantees this; explicit + safe
    .map((c) => ({
      subject: c.triple.subject,
      key: c.triple.key,
      distinctValues: c.distinctValues,
      totalClaims: c.totalClaims,
    }));
}

/** The advisory warning string for one collision. */
export function formatCardinalityCollision(c: CardinalityCollision): string {
  return (
    `single-cardinality (subject:${c.subject}, key:${c.key}) holds ${c.distinctValues}` +
    ` distinct values — recall serves only the latest; declare keyCardinality:"multi" if they should coexist.`
  );
}

/** Advisory warnings for single-cardinality (subject, canonical key) groups holding ≥2 distinct
 *  values. `corpus` MUST be the pre-⊥ corpus (τ_valid + ⊕_dedupe applied). */
export function cardinalitySafetyWarnings(
  corpus: Corpus, effectiveCardinality: Record<string, "single" | "multi"> | undefined,
  aliasMap: KeyAliasMap,
): string[] {
  return cardinalityCollisions(corpus, effectiveCardinality, aliasMap).map(formatCardinalityCollision);
}
