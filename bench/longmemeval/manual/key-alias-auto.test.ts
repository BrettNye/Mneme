import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoRatify, pairKey, loadRatifiedPairs } from "./key-alias-auto.js";
import { simJaccard } from "../../../src/algebra/similarity.js";

const jac = (a: string, b: string): number => simJaccard.scoreOne(a, b);

// Helper: write a temp JSONL file with the given lines
function writeTempJsonl(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "mneme-test-"));
  const file = join(dir, "test.jsonl");
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"), "utf-8");
  return file;
}

const counts = (entries: Array<[string, number]>): Map<string, number> => new Map(entries);

describe("pairKey", () => {
  it("is order-insensitive: pairKey(a,b) === pairKey(b,a)", () => {
    expect(pairKey("foo", "bar")).toBe(pairKey("bar", "foo"));
    expect(pairKey("x", "y")).toBe(pairKey("y", "x"));
  });

  it("uses lexicographic ordering (smaller first) with unit separator", () => {
    // "bar" < "foo" lexicographically
    expect(pairKey("foo", "bar")).toBe("bar\x1ffoo");
    expect(pairKey("bar", "foo")).toBe("bar\x1ffoo");
  });

  it("identical strings yield a stable key", () => {
    expect(pairKey("same", "same")).toBe("same\x1fsame");
  });
});

describe("loadRatifiedPairs", () => {
  it("returns non-empty set from committed min094 judgments file", () => {
    // Uses the real committed fixture
    const pairs = loadRatifiedPairs(
      new URL("./data/key-ratify-judgments-min094.jsonl", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    );
    expect(pairs.size).toBeGreaterThan(0);
  });

  it("skips header lines (kind !== undefined) and same===false lines", () => {
    const file = writeTempJsonl([
      { kind: "key-ratify-header", model: "test", promptVersion: "v1" }, // header — skip
      { a: "foo", b: "bar", same: true },  // ratified — include
      { a: "baz", b: "qux", same: false }, // rejected — exclude
      { a: "alpha", b: "beta", same: true }, // ratified — include
    ]);
    const pairs = loadRatifiedPairs(file);
    expect(pairs.size).toBe(2);
    expect(pairs.has(pairKey("foo", "bar"))).toBe(true);
    expect(pairs.has(pairKey("baz", "qux"))).toBe(false);
    expect(pairs.has(pairKey("alpha", "beta"))).toBe(true);
  });

  it("pairKey order-insensitive: loadRatifiedPairs of {a:'x',b:'y'} contains pairKey('y','x')", () => {
    const file = writeTempJsonl([
      { a: "x", b: "y", same: true },
    ]);
    const pairs = loadRatifiedPairs(file);
    expect(pairs.has(pairKey("y", "x"))).toBe(true);
    expect(pairs.has(pairKey("x", "y"))).toBe(true);
  });

  it("lines missing a or b are skipped gracefully", () => {
    const file = writeTempJsonl([
      { a: "foo", same: true },       // missing b — skip
      { b: "bar", same: true },       // missing a — skip
      { a: "p", b: "q", same: true }, // valid — include
    ]);
    const pairs = loadRatifiedPairs(file);
    expect(pairs.size).toBe(1);
    expect(pairs.has(pairKey("p", "q"))).toBe(true);
  });

  it("empty file returns empty set", () => {
    const file = writeTempJsonl([]);
    expect(loadRatifiedPairs(file).size).toBe(0);
  });
});

describe("autoRatify", () => {
  it("merges a near-duplicate pair; most-claims key wins canonical", () => {
    const { map, stats } = autoRatify(
      counts([
        ["car service date", 3],
        ["car service appointment date", 1],
        ["gas mileage", 2],
      ]),
      jac,
      0.5,
    );
    expect(map).toEqual({ "car service appointment date": "car service date" });
    expect(stats).toEqual({ aliases: 1, components: 1, largestComponent: 2 });
  });

  it("ties on count break to the lexicographically smallest key", () => {
    const { map } = autoRatify(
      counts([
        ["preferred editor", 1],
        ["editor preferred", 1],
      ]),
      jac,
      0.5,
    );
    expect(map).toEqual({ "preferred editor": "editor preferred" });
  });

  it("chains transitively (single-link): a~b, b~c merge even when a~c < theta", () => {
    // Scores: ab=2/3, bc=2/3, ac=1/3 (each pair shares 2 of 3 tokens except a/c)
    const a = "alpha beta gold";
    const b = "alpha beta silver";
    const c = "beta silver bronze";
    expect(jac(a, c)).toBeLessThan(0.5);
    const { map, stats } = autoRatify(counts([[a, 1], [b, 1], [c, 1]]), jac, 0.5);
    expect(stats.largestComponent).toBe(3);
    // canonical: all count 1 → lexicographic smallest = a
    expect(map).toEqual({ [b]: a, [c]: a });
  });

  it("theta above all scores yields an empty map (baseline identity lever)", () => {
    const { map, stats } = autoRatify(
      counts([
        ["car service date", 3],
        ["car service appointment date", 1],
      ]),
      jac,
      0.99,
    );
    expect(map).toEqual({});
    expect(stats.aliases).toBe(0);
    expect(stats.components).toBe(0);
  });

  it("is deterministic regardless of input insertion order", () => {
    const forward = autoRatify(
      counts([["a b", 1], ["a c", 1], ["b c", 1], ["x y", 5]]),
      jac,
      0.3,
    );
    const reversed = autoRatify(
      counts([["x y", 5], ["b c", 1], ["a c", 1], ["a b", 1]]),
      jac,
      0.3,
    );
    expect(forward.map).toEqual(reversed.map);
    expect(forward.stats).toEqual(reversed.stats);
  });

  it("single key and empty input yield empty maps", () => {
    expect(autoRatify(counts([["only key", 4]]), jac, 0.1).map).toEqual({});
    expect(autoRatify(counts([]), jac, 0.1).map).toEqual({});
    expect(autoRatify(counts([]), jac, 0.1).stats.largestComponent).toBe(0);
  });
});
