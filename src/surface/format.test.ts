import { describe, it, expect } from "vitest";
import { formatQueryResult, formatClaim } from "./format.js";
import type { Claim } from "../core/claim.js";
import type { AggregateResult } from "../algebra/aggregation.js";

// Minimal valid Claim for testing — only the fields formatClaim uses
function makeClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: "c1" as Claim["id"],
    profile: "p1" as Claim["profile"],
    workspace: "w1" as Claim["workspace"],
    subject: "alice",
    key: "age",
    scope: {},
    scopeHash: "hash1",
    value: 30,
    valueHash: "vh1",
    confidence: { distribution: "scalar", parameters: { p: 0.9 }, raw: 0.9 },
    valid: { from: 0, to: Infinity },
    recorded: 0,
    recordedSeq: 1,
    status: "validated",
    source: "manual",
    provenance: { writer: "test", inputHash: "ih1" },
    evidence: [],
    audience: { visibility: "private" },
    tags: [],
    schema: "1",
    ...overrides,
  } as unknown as Claim;
}

describe("formatQueryResult", () => {
  it("unwraps ComposedContext to its content string", () => {
    const out = formatQueryResult({ format: "markdown", content: "# hi", tokenCount: 2 } as never);
    expect(out).toBe("# hi");
  });

  it("renders an empty Corpus as an empty string", () => {
    expect(formatQueryResult({ claims: [] } as never)).toBe("");
  });

  it("renders a Corpus with one claim via formatClaim", () => {
    const claim = makeClaim();
    const out = formatQueryResult({ claims: [claim] } as never);
    expect(out).toContain("alice");
    expect(out).toContain("age");
    expect(out).toContain("30");
    expect(out).toContain("validated");
    expect(out).toContain("p=0.900");
  });

  it("renders a RankedCorpus with one scored claim", () => {
    const claim = makeClaim({ subject: "bob", key: "score", value: 42 });
    const out = formatQueryResult({ scored: [{ claim, score: 0.8 }] } as never);
    expect(out).toContain("bob");
    expect(out).toContain("score");
    expect(out).toContain("42");
  });

  it("renders an AggregateResult count group", () => {
    const aggResult: AggregateResult = {
      groups: new Map([
        ["__none__", { key: { kind: "none" }, value: { kind: "count", n: 5 } }],
      ]),
    };
    const out = formatQueryResult(aggResult as never);
    expect(out).toContain("__none__");
    expect(out).toContain("5");
  });

  it("renders AggregateResult with multiple groups one line each", () => {
    const aggResult: AggregateResult = {
      groups: new Map([
        ["groupA", { key: { kind: "scalar", value: "groupA" }, value: { kind: "sum", value: 10 } }],
        ["groupB", { key: { kind: "scalar", value: "groupB" }, value: { kind: "sum", value: 20 } }],
      ]),
    };
    const out = formatQueryResult(aggResult as never);
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("groupA");
    expect(lines[1]).toContain("groupB");
  });
});

describe("formatClaim", () => {
  it("includes subject, key, value, status, and point-estimate confidence", () => {
    const claim = makeClaim({
      subject: "alice",
      key: "age",
      value: 30,
      status: "validated",
      confidence: { distribution: "scalar", parameters: { p: 0.9 }, raw: 0.9 },
    });
    const out = formatClaim(claim);
    expect(out).toContain("alice");
    expect(out).toContain("age");
    expect(out).toContain("30");
    expect(out).toContain("validated");
    expect(out).toContain("p=0.900");
  });

  it("handles beta distribution confidence with mean", () => {
    const claim = makeClaim({
      subject: "bob",
      key: "trust",
      value: true,
      status: "provisional",
      confidence: { distribution: "beta", parameters: { alpha: 3, beta: 1 }, raw: 0.75 },
    });
    const out = formatClaim(claim);
    // betaMean(3,1) = 3/4 = 0.75
    expect(out).toContain("p=0.750");
    expect(out).toContain("provisional");
  });
});
