/**
 * Entity-coverage recipe for the recall surface (spec:
 * docs/superpowers/specs/2026-06-07-recall-surface-enrichment-design.md).
 *
 * HEURISTIC v1, kept VERBATIM to the bench-validated implementation
 * (bench/longmemeval/manual/abstention-signals.ts; 62.5% flag precision on
 * LME-oracle): capitalized words + number-bearing tokens, minus a question-word
 * stoplist — stoplist-only, NO position logic. English-capitalization dependent;
 * lowercase entities and paraphrases are known misses. `entityTokensOf` is the
 * named swap seam for a future NER — consumers never change.
 *
 * Pure and deterministic: no models, no I/O, no clock. Retrieval-layer placement
 * per the key-alias.ts precedent; imports core types only.
 */
import type { Claim } from "../core/claim.js";

/** The validated question-word stoplist (exported for tests). */
export const ENTITY_STOPWORDS: ReadonlySet<string> = new Set([
  "When", "Which", "Who", "What", "How", "Where", "Why",
  "Did", "Do", "Does", "Is", "Are", "Was", "Were", "The", "I",
]);

const ENTITY_TOKEN = /\b(?:[A-Z][a-zA-Z]+|\d+[a-zA-Z]*)\b/g;

export function entityTokensOf(text: string): string[] {
  return [...new Set(text.match(ENTITY_TOKEN) ?? [])].filter((w) => !ENTITY_STOPWORDS.has(w));
}

export interface CoverageEntity {
  text: string;
  supported: boolean;
}
export interface CoverageReport {
  /** One entry per extracted token, extraction order. */
  entities: CoverageEntity[];
  /** The unsupported subset, extraction order. */
  missing: string[];
}

/**
 * Case-insensitive containment of each entity over the claims'
 * subject + key + String(value) text. Empty entities ⇒ empty report.
 */
export function coverageOf(entities: readonly string[], claims: readonly Claim[]): CoverageReport {
  const haystack = claims
    .map((c) => `${c.subject} ${c.key} ${String(c.value)}`)
    .join(" ")
    .toLowerCase();
  const report: CoverageEntity[] = entities.map((text) => ({
    text,
    supported: haystack.includes(text.toLowerCase()),
  }));
  return { entities: report, missing: report.filter((e) => !e.supported).map((e) => e.text) };
}
