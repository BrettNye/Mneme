/**
 * Tests for key-alias.ts
 *
 * Uses the same builder/fixture style as read-pipeline.test.ts.
 */
import { describe, it, expect } from "vitest";
import {
  isKeyAliasShaped,
  aliasMapOf,
  keyFamilyOf,
  KEY_ALIAS_KEY,
  KEY_SUBJECT_PREFIX,
} from "./key-alias.js";
import type { Claim } from "../core/claim.js";

// ── Time constants ────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const T_PAST = NOW - 10 * DAY;
const T_FUTURE = NOW + 10 * DAY;

// ── Minimal claim factory for alias claims ────────────────────────────────────

let _seq = 0;
function aliasClaim(
  variant: string,
  canonical: string,
  opts: {
    from?: number;
    to?: number;
    status?: "candidate" | "provisional" | "validated" | "deprecated";
    id?: string;
  } = {},
): Claim {
  const id = opts.id ?? `alias-${variant}-${canonical}-${_seq++}`;
  return {
    id: id as any,
    profile: "p" as any,
    workspace: "w" as any,
    subject: `${KEY_SUBJECT_PREFIX}${variant}` as any,
    key: KEY_ALIAS_KEY as any,
    scope: {} as any,
    scopeHash: "_",
    value: canonical,
    valueHash: `vh-${variant}-${canonical}`,
    confidence: {
      distribution: "beta",
      parameters: { alpha: 5, beta: 5 },
      raw: 0.5,
    },
    valid: { from: opts.from ?? T_PAST, to: opts.to ?? Infinity },
    recorded: T_PAST,
    recordedSeq: 0,
    status: opts.status ?? "candidate",
    source: "manual",
    provenance: {} as any,
    evidence: [],
    tags: [],
    schema: "v1",
    audience: {},
  } as Claim;
}

// Make a non-alias claim for negative tests
function nonAliasClaim(key: string, subject: string, value: string = "val"): Claim {
  return {
    id: `non-alias-${key}-${subject}` as any,
    profile: "p" as any,
    workspace: "w" as any,
    subject: subject as any,
    key: key as any,
    scope: {} as any,
    scopeHash: "_",
    value,
    valueHash: `vh-${key}`,
    confidence: {
      distribution: "beta",
      parameters: { alpha: 5, beta: 5 },
      raw: 0.5,
    },
    valid: { from: T_PAST, to: Infinity },
    recorded: T_PAST,
    recordedSeq: 0,
    status: "candidate",
    source: "manual",
    provenance: {} as any,
    evidence: [],
    tags: [],
    schema: "v1",
    audience: {},
  } as Claim;
}

// ── isKeyAliasShaped ──────────────────────────────────────────────────────────

describe("isKeyAliasShaped", () => {
  it("returns true for well-shaped alias claim", () => {
    const c = aliasClaim("editor", "preferred_editor");
    expect(isKeyAliasShaped(c)).toBe(true);
  });

  it("returns false for alias-of key with non-key: subject", () => {
    const c = nonAliasClaim(KEY_ALIAS_KEY, "editor");
    expect(isKeyAliasShaped(c)).toBe(false);
  });

  it("returns false for key:-prefixed subject with other key", () => {
    const c = nonAliasClaim("some-other-key", `${KEY_SUBJECT_PREFIX}editor`);
    expect(isKeyAliasShaped(c)).toBe(false);
  });

  it("returns false for completely unrelated claim", () => {
    const c = nonAliasClaim("note", "user");
    expect(isKeyAliasShaped(c)).toBe(false);
  });
});

// ── aliasMapOf — basic happy path ─────────────────────────────────────────────

describe("aliasMapOf — basic mapping", () => {
  it("produces a flat variant → canonical map", () => {
    const claims = [aliasClaim("editor", "preferred_editor")];
    const { map, warnings } = aliasMapOf(claims, { evaluationInstant: NOW });
    expect(map).toEqual({ editor: "preferred_editor" });
    expect(warnings).toHaveLength(0);
  });

  it("ignores non-alias-shaped claims", () => {
    const claims = [
      aliasClaim("editor", "preferred_editor"),
      nonAliasClaim("note", "user"),
    ];
    const { map } = aliasMapOf(claims, { evaluationInstant: NOW });
    expect(map).toEqual({ editor: "preferred_editor" });
  });

  it("returns empty map for empty input", () => {
    const { map, warnings, selfAliases } = aliasMapOf([], { evaluationInstant: NOW });
    expect(map).toEqual({});
    expect(warnings).toHaveLength(0);
    expect(selfAliases).toHaveLength(0);
  });
});

// ── aliasMapOf — tauValid filtering ──────────────────────────────────────────

describe("aliasMapOf — temporal filtering", () => {
  it("excludes claims with valid.from in the future", () => {
    const claims = [
      aliasClaim("editor", "preferred_editor", { from: T_FUTURE }),
    ];
    const { map } = aliasMapOf(claims, { evaluationInstant: NOW });
    expect(map).toEqual({});
  });

  it("excludes claims where valid.to has passed", () => {
    const claims = [
      aliasClaim("editor", "preferred_editor", { from: T_PAST, to: NOW - 1 }),
    ];
    const { map } = aliasMapOf(claims, { evaluationInstant: NOW });
    expect(map).toEqual({});
  });

  it("includes claims valid at evaluationInstant", () => {
    const claims = [
      aliasClaim("editor", "preferred_editor", { from: T_PAST, to: NOW + DAY }),
    ];
    const { map } = aliasMapOf(claims, { evaluationInstant: NOW });
    expect(map).toEqual({ editor: "preferred_editor" });
  });
});

// ── aliasMapOf — supersession (newer wins) ────────────────────────────────────

describe("aliasMapOf — supersession", () => {
  it("newer alias-of claim for same variant wins over older one", () => {
    const older = aliasClaim("editor", "old_canonical", { from: T_PAST });
    // newer has later valid.from → should win
    const newer = aliasClaim("editor", "preferred_editor", { from: T_PAST + DAY });
    const { map, warnings } = aliasMapOf([older, newer], { evaluationInstant: NOW });
    expect(map).toEqual({ editor: "preferred_editor" });
    expect(warnings).toHaveLength(0);
  });
});

// ── aliasMapOf — chain resolution ────────────────────────────────────────────

describe("aliasMapOf — chain resolution", () => {
  it("resolves chains to fixpoint (a→b, b→c yields a→c, b→c)", () => {
    const claims = [
      aliasClaim("a", "b"),
      aliasClaim("b", "c"),
    ];
    const { map, warnings } = aliasMapOf(claims, { evaluationInstant: NOW });
    expect(map).toEqual({ a: "c", b: "c" });
    expect(warnings).toHaveLength(0);
  });

  it("resolves chains and drops cycles with a warning", () => {
    const claims = [
      aliasClaim("a", "b"), aliasClaim("b", "c"),   // chain: a→c, b→c
      aliasClaim("x", "y"), aliasClaim("y", "x"),   // cycle: dropped
    ];
    const { map, warnings } = aliasMapOf(claims, { evaluationInstant: NOW });
    expect(map).toEqual({ a: "c", b: "c" });
    expect(warnings.some((w) => w.includes("cycle"))).toBe(true);
  });

  it("passes through diamonds (a→c, b→c both survive)", () => {
    const claims = [
      aliasClaim("a", "c"),
      aliasClaim("b", "c"),
    ];
    const { map, warnings } = aliasMapOf(claims, { evaluationInstant: NOW });
    expect(map).toEqual({ a: "c", b: "c" });
    expect(warnings).toHaveLength(0);
  });

  it("resolves long chains to fixpoint", () => {
    const claims = [
      aliasClaim("a", "b"),
      aliasClaim("b", "c"),
      aliasClaim("c", "d"),
    ];
    const { map } = aliasMapOf(claims, { evaluationInstant: NOW });
    expect(map).toEqual({ a: "d", b: "d", c: "d" });
  });
});

// ── aliasMapOf — cycles ───────────────────────────────────────────────────────

describe("aliasMapOf — cycles", () => {
  it("drops all members of a cycle and emits a warning naming them", () => {
    const claims = [
      aliasClaim("x", "y"),
      aliasClaim("y", "x"),
    ];
    const { map, warnings } = aliasMapOf(claims, { evaluationInstant: NOW });
    expect(map).not.toHaveProperty("x");
    expect(map).not.toHaveProperty("y");
    expect(warnings.some((w) => w.includes("cycle"))).toBe(true);
  });

  it("drops a 3-way cycle and emits a warning", () => {
    const claims = [
      aliasClaim("p", "q"),
      aliasClaim("q", "r"),
      aliasClaim("r", "p"),
    ];
    const { map, warnings } = aliasMapOf(claims, { evaluationInstant: NOW });
    expect(Object.keys(map)).toHaveLength(0);
    expect(warnings.some((w) => w.includes("cycle"))).toBe(true);
  });
});

// ── aliasMapOf — ties ─────────────────────────────────────────────────────────

describe("aliasMapOf — ties", () => {
  it("drops a variant with tied alias claims and emits a warning", () => {
    // Two alias claims for same variant with same valid.from (tie)
    const c1 = aliasClaim("editor", "canonical-a", { from: T_PAST });
    const c2 = aliasClaim("editor", "canonical-b", { from: T_PAST });
    // They must have different valueHash to form a contradiction pair
    c1.valueHash = "vh-canonical-a";
    c2.valueHash = "vh-canonical-b";
    const { map, warnings } = aliasMapOf([c1, c2], { evaluationInstant: NOW });
    expect(map).not.toHaveProperty("editor");
    expect(warnings.some((w) => w.includes("tie") || w.includes("conflict") || w.includes("ambiguous") || w.includes("multiple"))).toBe(true);
  });
});

// ── aliasMapOf — meta-aliases ─────────────────────────────────────────────────

describe("aliasMapOf — meta-aliases", () => {
  it("drops variant that is the alias-of key name itself", () => {
    // variant = "alias-of" → meta-alias
    const c: Claim = {
      ...aliasClaim("placeholder", "some-canonical"),
      subject: `${KEY_SUBJECT_PREFIX}${KEY_ALIAS_KEY}` as any,
    };
    const { map, warnings } = aliasMapOf([c], { evaluationInstant: NOW });
    expect(map).not.toHaveProperty(KEY_ALIAS_KEY);
    expect(warnings.some((w) => w.includes("meta"))).toBe(true);
  });

  it("drops canonical that starts with key: prefix", () => {
    // canonical = "key:something" → meta-alias
    const c = aliasClaim("editor", `${KEY_SUBJECT_PREFIX}preferred_editor`);
    const { map, warnings } = aliasMapOf([c], { evaluationInstant: NOW });
    expect(map).not.toHaveProperty("editor");
    expect(warnings.some((w) => w.includes("meta"))).toBe(true);
  });
});

// ── aliasMapOf — malformed values ─────────────────────────────────────────────

describe("aliasMapOf — malformed values", () => {
  it("ignores claims with non-string value and emits a warning", () => {
    const c: Claim = {
      ...aliasClaim("editor", "ignored"),
      value: 42 as any,
    };
    const { map, warnings } = aliasMapOf([c], { evaluationInstant: NOW });
    expect(map).not.toHaveProperty("editor");
    expect(warnings.some((w) => w.includes("malformed") || w.includes("string"))).toBe(true);
  });

  it("ignores claims with empty string value and emits a warning", () => {
    const c: Claim = {
      ...aliasClaim("editor", "ignored"),
      value: "" as any,
    };
    const { map, warnings } = aliasMapOf([c], { evaluationInstant: NOW });
    expect(map).not.toHaveProperty("editor");
    expect(warnings.some((w) => w.includes("malformed") || w.includes("empty"))).toBe(true);
  });

  it("never throws on bad data", () => {
    const c: Claim = {
      ...aliasClaim("editor", "ignored"),
      value: null as any,
    };
    expect(() => aliasMapOf([c], { evaluationInstant: NOW })).not.toThrow();
  });
});

// ── aliasMapOf — selfAliases ──────────────────────────────────────────────────

describe("aliasMapOf — selfAliases", () => {
  it("excludes self-aliases from map and lists them in selfAliases", () => {
    const c = aliasClaim("editor", "editor");
    const { map, selfAliases, warnings } = aliasMapOf([c], { evaluationInstant: NOW });
    expect(map).not.toHaveProperty("editor");
    expect(selfAliases).toContain("editor");
    // selfAliases are un-ratified, not warnings
    expect(warnings).toHaveLength(0);
  });
});

// ── keyFamilyOf ───────────────────────────────────────────────────────────────

describe("keyFamilyOf", () => {
  const map = { preferred_editor: "editor" };

  it("returns canonical + all variants when given a variant", () => {
    const family = keyFamilyOf("preferred_editor", map);
    expect(family).toContain("editor");
    expect(family).toContain("preferred_editor");
    expect(family).toHaveLength(2);
  });

  it("returns canonical + all variants when given the canonical", () => {
    const family = keyFamilyOf("editor", map);
    expect(family).toContain("editor");
    expect(family).toContain("preferred_editor");
    expect(family).toHaveLength(2);
  });

  it("matches the spec example: editor and preferred_editor return same family", () => {
    const mapForSpec = { preferred_editor: "editor" };
    const fromVariant = keyFamilyOf("preferred_editor", mapForSpec);
    const fromCanonical = keyFamilyOf("editor", mapForSpec);
    expect(fromVariant.sort()).toEqual(fromCanonical.sort());
    expect(fromVariant).toContain("editor");
    expect(fromVariant).toContain("preferred_editor");
  });

  it("returns [key] when key is unmapped", () => {
    const family = keyFamilyOf("unknown_key", map);
    expect(family).toEqual(["unknown_key"]);
  });

  it("is order-stable (same order for same map)", () => {
    const family1 = keyFamilyOf("editor", map);
    const family2 = keyFamilyOf("editor", map);
    expect(family1).toEqual(family2);
  });
});
