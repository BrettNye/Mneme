import { describe, it, expect } from "vitest";
import { autoRatify } from "./key-alias-auto.js";
import { simJaccard } from "../../../src/algebra/similarity.js";

const jac = (a: string, b: string): number => simJaccard.scoreOne(a, b);

const counts = (entries: Array<[string, number]>): Map<string, number> => new Map(entries);

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
