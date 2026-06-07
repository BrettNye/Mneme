/**
 * Auto-ratification for the key-matching oracle experiment (bench-only).
 *
 * Per-question policy: distinct keys → score all pairs → edges where
 * score >= theta → connected components (single-link, mirrors ⊕_dedupe's
 * clustering convention: a~b, b~c merge transitively even if a~c < theta)
 * → canonical per component = key with MOST CLAIMS in this corpus, ties
 * broken by lexicographically smallest. Returns the flat variant→canonical
 * map ⊥ consumes (KeyAliasMap) — no alias claims are written; the map is a
 * direct declarative input (spec: 2026-06-06-key-matching-oracle-experiment).
 *
 * Deterministic: keys iterated in sorted order; no randomness, no clock.
 * This is an EXPERIMENT policy — the product keeps human/agent ratification.
 */
import { readFileSync } from "node:fs";
import type { KeyAliasMap } from "../../../src/index.js";

/** Order-insensitive pair key — unit-separator (0x1F) between the two strings
 *  in lexicographic order. Hoisted from inline copies across manual scripts. */
export const pairKey = (a: string, b: string): string =>
  a < b ? `${a}\x1f${b}` : `${b}\x1f${a}`;

/** Parse a ratify-judge judgments JSONL into the set of APPROVED pair keys.
 *  Judgment lines are distinguished from header lines by `kind === undefined`
 *  and carry {a, b, same}; only same===true pairs are ratified.
 *  (Hoisted from the 4 inline copies — abstention-signals/calibrate/capstone/sweep;
 *  replicates their exact filter semantics.) */
export function loadRatifiedPairs(path: string): Set<string> {
  const approved = new Set<string>();
  for (const line of readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)) {
    const obj = JSON.parse(line) as { kind?: string; a?: string; b?: string; same?: boolean };
    if (obj.kind === undefined && obj.same && obj.a && obj.b) {
      approved.add(pairKey(obj.a, obj.b));
    }
  }
  return approved;
}

export interface AutoRatifyStats {
  /** Number of variant→canonical entries emitted. */
  aliases: number;
  /** Number of multi-key components (size >= 2). */
  components: number;
  /** Size of the largest component (1 when no merges). */
  largestComponent: number;
}

export interface AutoRatifyResult {
  map: KeyAliasMap;
  stats: AutoRatifyStats;
}

export function autoRatify(
  keyCounts: Map<string, number>,
  scoreOne: (a: string, b: string) => number,
  theta: number,
): AutoRatifyResult {
  const keys = [...keyCounts.keys()].sort();

  // Union-find over sorted keys (path-compressed; union by sorted index keeps
  // the structure deterministic regardless of input ordering).
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let root = k;
    while (parent.get(root) !== undefined && parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    // path compression
    let cur = k;
    while (cur !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // attach lexicographically larger root under smaller — deterministic
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };

  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      if (scoreOne(keys[i], keys[j]) >= theta) union(keys[i], keys[j]);
    }
  }

  // Group into components
  const components = new Map<string, string[]>();
  for (const k of keys) {
    const root = find(k);
    const group = components.get(root);
    if (group) group.push(k);
    else components.set(root, [k]);
  }

  const map: KeyAliasMap = {};
  let multiComponents = 0;
  let largest = keys.length > 0 ? 1 : 0;
  for (const group of components.values()) {
    if (group.length < 2) continue;
    multiComponents++;
    if (group.length > largest) largest = group.length;
    // canonical = most claims, tie → lexicographically smallest.
    // group is already sorted (keys iterated in sorted order), so the first
    // max-count member IS the lexicographic tiebreak winner.
    let canonical = group[0];
    for (const k of group) {
      if ((keyCounts.get(k) ?? 0) > (keyCounts.get(canonical) ?? 0)) canonical = k;
    }
    for (const k of group) {
      if (k !== canonical) map[k] = canonical;
    }
  }

  return {
    map,
    stats: {
      aliases: Object.keys(map).length,
      components: multiComponents,
      largestComponent: largest,
    },
  };
}
