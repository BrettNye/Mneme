import { describe, it, expect } from "vitest";
import { generateTo, type GenOptions } from "./generate.js";

function collect(opts: GenOptions): { lines: string[]; stats: ReturnType<typeof generateTo> } {
  const lines: string[] = [];
  const stats = generateTo((l) => lines.push(l), opts);
  return { lines, stats };
}

describe("generateTo", () => {
  it("emits exactly `count` records and conserves the classification", () => {
    const { lines, stats } = collect({ count: 1000, contradictionRate: 0.3, duplicateRate: 0.1, seed: 7 });
    expect(lines).toHaveLength(1000);
    expect(stats.total).toBe(1000);
    expect(stats.fresh + stats.contradictions + stats.duplicates).toBe(1000);
  });

  it("is deterministic for a fixed seed", () => {
    const a = collect({ count: 500, contradictionRate: 0.2, duplicateRate: 0.1, seed: 42 });
    const b = collect({ count: 500, contradictionRate: 0.2, duplicateRate: 0.1, seed: 42 });
    expect(a.lines).toEqual(b.lines);
    expect(a.stats).toEqual(b.stats);
  });

  it("produces contradictions when asked (existing identity, new value)", () => {
    const { stats } = collect({ count: 2000, subjectPool: 10, keyPool: 2, contradictionRate: 0.5, seed: 3 });
    expect(stats.contradictions).toBeGreaterThan(0);
  });

  it("produces exact duplicates when asked", () => {
    const { stats } = collect({ count: 2000, subjectPool: 10, keyPool: 2, duplicateRate: 0.4, seed: 5 });
    expect(stats.duplicates).toBeGreaterThan(0);
  });

  it("attaches scope.region when scopeValues > 0", () => {
    const { lines } = collect({ count: 50, scopeValues: 4, seed: 1 });
    const rec = JSON.parse(lines[0]) as { scope?: { region?: string } };
    expect(rec.scope?.region).toMatch(/^r\d+$/);
  });

  it("emits no scope field by default", () => {
    const { lines } = collect({ count: 10, seed: 1 });
    expect(JSON.parse(lines[0])).not.toHaveProperty("scope");
  });
});
