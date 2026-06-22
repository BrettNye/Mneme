/**
 * Drift-injection for the key-matching wedge benchmark (bench-only).
 *
 * Pure + deterministic: rewrites a seeded fraction of single-value claim keys
 * to VARIANT keys, fragmenting superseding lineages across keys so that
 * (without an alias map) drifted claims never contest. Returns the drifted
 * claims plus the exact variant→canonical oracle map.
 *
 * Spec: docs/superpowers/specs/2026-06-17-drift-injection-bench-arm-design.md
 */
import type { ClaimRecordT } from "../types.js";
import type { KeyAliasMap } from "../../../src/index.js";
import { loadRatifiedPairs, pairKey, autoRatify } from "./key-alias-auto.js";

export type DriftMode = "judged" | "morph";

/** canonical key → its variant keys (>= 1). Built in drift-injector judged mode (Task 2). */
export type CanonicalGroups = Map<string, string[]>;

export interface DriftOpts {
  mode: DriftMode;
  fraction: number;
  seed: string;
  multiKeys: Record<string, "single" | "multi">;
  judgedVocab?: CanonicalGroups;
}

export interface DriftResult {
  claims: ClaimRecordT[];
  aliasMap: KeyAliasMap;
  coverage: { eligibleKeys: number; driftedKeys: number; noVariantKeys: number };
}

/** Deterministic 32-bit FNV-1a string hash (no clock, no randomness). */
export function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const MORPH_PREFIXES = ["preferred_", "current_", "primary_"];
const MORPH_SUFFIXES = ["_current", "_now"];

/** >= 2 distinct variants, none equal to the input key. */
export function morphVariants(key: string): string[] {
  const out = new Set<string>();
  for (const p of MORPH_PREFIXES) out.add(p + key);
  for (const s of MORPH_SUFFIXES) out.add(key + s);
  out.delete(key);
  return [...out];
}

const identity = (c: ClaimRecordT): string =>
  `${c.subject}|${c.key}|${c.validFrom}|${c.value}`;

/** Fraction gate: deterministic per claim. */
function drifts(c: ClaimRecordT, seed: string, fraction: number): boolean {
  if (fraction <= 0) return false;
  if (fraction >= 1) return true;
  return (hashStr(seed + "|sel|" + identity(c)) % 1_000_000) / 1_000_000 < fraction;
}

/** Pick a variant deterministically from a non-empty set. */
function pickVariant(c: ClaimRecordT, seed: string, variants: string[]): string {
  return variants[hashStr(seed + "|var|" + identity(c)) % variants.length];
}

export function injectDrift(claims: ClaimRecordT[], opts: DriftOpts): DriftResult {
  const aliasMap: KeyAliasMap = {};
  const eligibleKeys = new Set<string>();
  const driftedKeys = new Set<string>();
  const noVariantKeys = new Set<string>();

  const out = claims.map((c) => {
    if (opts.multiKeys[c.key] === "multi") return c;

    // Determine canonical + variant set for this claim's key.
    let canonical: string;
    let variants: string[];
    if (opts.mode === "morph") {
      canonical = c.key;
      variants = morphVariants(c.key);
    } else {
      // judged: only keys that are a canonical-with-variants in the vocab are eligible.
      const vocab = opts.judgedVocab;
      const vs = vocab?.get(c.key);
      if (!vs || vs.length === 0) {
        if (vocab && vocab.has(c.key)) noVariantKeys.add(c.key);
        return c;
      }
      canonical = c.key;
      variants = vs;
    }

    eligibleKeys.add(canonical);
    if (!drifts(c, opts.seed, opts.fraction)) return c;

    const variant = pickVariant(c, opts.seed, variants);
    aliasMap[variant] = canonical;
    driftedKeys.add(variant);
    return { ...c, key: variant };
  });

  return {
    claims: out,
    aliasMap,
    coverage: {
      eligibleKeys: eligibleKeys.size,
      driftedKeys: driftedKeys.size,
      noVariantKeys: noVariantKeys.size,
    },
  };
}

/**
 * Build canonical→[variants] from the committed judged-pairs JSONL by reusing
 * key-alias-auto's union-find + canonical selection (most-claims, ties
 * lexicographically smallest). A binary scorer (1 iff the pair was judged
 * same:true) with theta=1 turns the symmetric judgments into components.
 * keyCounts spans both the claims-file keys AND any judged keys, so a variant
 * with no own claims is still a valid drift target.
 */
export function buildJudgedVocab(claims: ClaimRecordT[], judgmentsPath: string): CanonicalGroups {
  const approved = loadRatifiedPairs(judgmentsPath);

  const keyCounts = new Map<string, number>();
  for (const c of claims) keyCounts.set(c.key, (keyCounts.get(c.key) ?? 0) + 1);
  // Ensure both endpoints of every approved pair are present as nodes (0 count
  // if they never appear as a claim key) so judged variants aren't dropped.
  for (const pk of approved) {
    for (const k of pk.split("\x1f")) if (!keyCounts.has(k)) keyCounts.set(k, 0); // \x1f is pairKey's separator (key-alias-auto.ts)
  }

  const scoreOne = (a: string, b: string): number => (approved.has(pairKey(a, b)) ? 1 : 0);
  const { map } = autoRatify(keyCounts, scoreOne, 1); // map: variant→canonical

  const groups: CanonicalGroups = new Map();
  for (const [variant, canonical] of Object.entries(map)) {
    const vs = groups.get(canonical) ?? [];
    vs.push(variant);
    groups.set(canonical, vs);
  }
  for (const vs of groups.values()) vs.sort();
  return groups;
}
