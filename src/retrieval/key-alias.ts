/**
 * Key alias map loader.
 *
 * LAYERING: this module imports algebra/core ONLY — never ../mneme.js
 * (importing mneme.js would close a real cycle once write/derive.ts imports this module).
 *
 * Documented divergences from canonicalReadStages (spec A7):
 *   1. No serving filter (would drop alias claims filtered by key shape)
 *   2. No ⊕_dedupe (jaccard@0.5 could merge same-variant claims pointing at
 *      token-similar but different canonicals, corrupting the map)
 *   3. Cardinality forced all-single ignoring project config (alias-of semantics
 *      require supersession within variant, not multi-value tolerance)
 */
import type { Claim } from "../core/claim.js";
import type { KeyAliasMap } from "../algebra/contradiction.js";
import { corpusOf, filterCorpus } from "../algebra/types.js";
import { tauValid } from "../algebra/temporal.js";
import { pairsOf } from "../algebra/contradiction.js";
import { resolveDeprecateOlder, CONTRADICTION_FLAG_KEY } from "../algebra/resolution.js";

export type { KeyAliasMap } from "../algebra/contradiction.js";

export const KEY_ALIAS_KEY = "alias-of";
export const KEY_SUBJECT_PREFIX = "key:";

/**
 * Returns true iff the claim is an alias-of claim with a key:-prefixed subject.
 * Rejects near-misses: alias-of key with non-key: subject; key: subject with other key.
 */
export function isKeyAliasShaped(c: Claim): boolean {
  return c.key === KEY_ALIAS_KEY && c.subject.startsWith(KEY_SUBJECT_PREFIX);
}

export interface AliasLoadResult {
  map: KeyAliasMap;      // flat variant → canonical
  selfAliases: string[]; // active identity mappings (un-ratified keys), for census observability
  warnings: string[];    // cycles / ties / meta-aliases / malformed values, human-readable
}

/**
 * Pass 1: filter isKeyAliasShaped → τ_valid(evaluationInstant) → ⊥ +
 * resolveDeprecateOlder (all-single, NO dedupe) → drop deprecated + flag artifacts.
 *
 * Pass 2: variant = subject minus KEY_SUBJECT_PREFIX, canonical = String(value);
 * fixpoint chain resolution; case-sensitive exact strings throughout (A12).
 *
 * Takes Claim[] (what every call site has — session.mneme.read / adapter.query
 * return Claim[]); wraps with corpusOf internally for the algebra stages.
 * Deliberate deviation from spec §2's Corpus-typed sketch.
 */
export function aliasMapOf(
  claims: readonly Claim[],
  opts: { evaluationInstant: number },
): AliasLoadResult {
  const warnings: string[] = [];
  const selfAliases: string[] = [];

  // ── Pass 1: algebra pipeline ──────────────────────────────────────────────

  // Filter to alias-shaped claims only
  const aliasClaims = (claims as Claim[]).filter(isKeyAliasShaped);

  // Build corpus for algebra operations
  let corpus = corpusOf(aliasClaims);

  // τ_valid: exclude claims whose valid interval does not cover evaluationInstant
  corpus = tauValid(opts.evaluationInstant)(corpus);

  // ⊥ / resolveDeprecateOlder with all-single cardinality (forced, no project config)
  // threshold=0 means all claims eligible for contradiction detection
  const pairs = pairsOf(corpus, 0, { keyCardinality: undefined });
  corpus = resolveDeprecateOlder(pairs)(corpus);

  // Drop deprecated claims and contradiction flag artifacts
  corpus = filterCorpus(
    corpus,
    (cl) => cl.status !== "deprecated" && cl.key !== CONTRADICTION_FLAG_KEY,
  );

  // Detect ties: claims for the same variant that survived (were NOT resolved by deprecation)
  // A tie occurs when two claims for the same variant have the same valid.from.
  // After resolveDeprecateOlder, tied pairs both survive with flag artifacts already dropped.
  // We detect survivors that are still ambiguous (same variant key, multiple entries).
  const variantGroups = new Map<string, Claim[]>();
  for (const cl of corpus.claims) {
    const variant = cl.subject.slice(KEY_SUBJECT_PREFIX.length);
    const bucket = variantGroups.get(variant);
    if (bucket) bucket.push(cl);
    else variantGroups.set(variant, [cl]);
  }

  // ── Pass 2: extract pairs, check malformed, detect self-aliases/meta-aliases ──

  const rawMap: Record<string, string> = {};

  for (const [variant, claimList] of variantGroups) {
    if (claimList.length > 1) {
      // Tie: multiple claims survived for this variant → drop and warn
      warnings.push(
        `ambiguous alias: variant "${variant}" has multiple unresolved alias claims (tie) — dropped`,
      );
      continue;
    }

    const cl = claimList[0];

    // Malformed value: must be a non-empty string
    if (typeof cl.value !== "string" || cl.value === "") {
      const display = cl.value === "" ? "empty string" : typeof cl.value;
      warnings.push(
        `malformed alias value for variant "${variant}": expected non-empty string, got ${display} — ignored`,
      );
      continue;
    }

    const canonical = cl.value;

    // Self-alias: variant maps to itself
    if (variant === canonical) {
      selfAliases.push(variant);
      continue;
    }

    // Meta-alias: variant is the alias key name itself
    if (variant === KEY_ALIAS_KEY) {
      warnings.push(
        `meta-alias detected: variant is "${KEY_ALIAS_KEY}" (the alias key name itself) — dropped`,
      );
      continue;
    }

    // Meta-alias: canonical starts with key: prefix
    if (canonical.startsWith(KEY_SUBJECT_PREFIX)) {
      warnings.push(
        `meta-alias detected: canonical "${canonical}" for variant "${variant}" starts with "${KEY_SUBJECT_PREFIX}" — dropped`,
      );
      continue;
    }

    rawMap[variant] = canonical;
  }

  // ── Pass 2 continued: fixpoint chain resolution ────────────────────────────

  // Resolve chains to fixpoint: repeatedly follow chains until stable.
  // Also detect cycles (any variant that would map to itself after chasing).
  const resolvedMap: KeyAliasMap = {};
  const cycleMembers = new Set<string>();

  for (const variant of Object.keys(rawMap)) {
    // Follow the chain for this variant
    const visited: string[] = [variant];
    const visitedSet = new Set<string>([variant]);
    let current = variant;

    while (rawMap[current] !== undefined) {
      const next = rawMap[current];
      if (visitedSet.has(next)) {
        // Cycle detected: mark all members of this cycle
        const cycleStart = visited.indexOf(next);
        const cycle = visited.slice(cycleStart);
        // The canonical that triggered the cycle is also part of it if it's in rawMap
        if (rawMap[next] !== undefined) {
          cycle.push(next);
        }
        for (const m of cycle) {
          cycleMembers.add(m);
        }
        // Also mark 'next' since it's the cycle entry point
        cycleMembers.add(next);
        break;
      }
      visited.push(next);
      visitedSet.add(next);
      current = next;
    }
  }

  // Emit one cycle warning if any cycles found
  if (cycleMembers.size > 0) {
    warnings.push(
      `cycle detected among alias keys: [${[...cycleMembers].sort().join(", ")}] — all members dropped`,
    );
  }

  // Build resolved map, skipping cycle members
  for (const variant of Object.keys(rawMap)) {
    if (cycleMembers.has(variant)) continue;

    // Follow chain to fixpoint
    let current = variant;
    while (rawMap[current] !== undefined && !cycleMembers.has(rawMap[current])) {
      current = rawMap[current];
    }

    // If chain ended in a cycle member's target, skip
    if (cycleMembers.has(current)) continue;

    resolvedMap[variant] = current;
  }

  return { map: resolvedMap, selfAliases, warnings };
}

/**
 * Returns the family of keys sharing a canonical: the canonical itself plus all variants
 * that map to it. Works from variant or canonical input. Returns [key] when unmapped.
 * Order-stable.
 */
export function keyFamilyOf(key: string, map: KeyAliasMap): string[] {
  // Resolve key to canonical (follow if it's a variant)
  const canonical = map[key] ?? key;

  // Check if the resolved canonical actually exists in the map's values
  // (i.e., it's really a canonical and not just an unmapped key)
  const variants = Object.entries(map)
    .filter(([, v]) => v === canonical)
    .map(([k]) => k);

  if (variants.length === 0) {
    // key is not a variant in the map; check if it's a canonical
    const asCanonical = Object.entries(map).filter(([, v]) => v === key).map(([k]) => k);
    if (asCanonical.length === 0) {
      // Completely unmapped
      return [key];
    }
    // key is a canonical: return canonical + all variants
    return [key, ...asCanonical];
  }

  // key is a variant: return canonical + all variants for that canonical
  return [canonical, ...variants];
}
