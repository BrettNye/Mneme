import { corpusOf, filterCorpus, mapCorpus } from "./types.js";
import type { RankedCorpus, ScoredClaim, ComposedContext } from "./types.js";
import type { Claim } from "../core/claim.js";

it("corpus is immutable and filterable", () => {
  const c = corpusOf([{ subject: "a" } as any, { subject: "b" } as any]);
  expect(Object.isFrozen(c.claims)).toBe(true);
  expect(filterCorpus(c, (x) => x.subject === "a").claims).toHaveLength(1);
});

it("mapCorpus returns a new corpus without mutating the original", () => {
  const original = corpusOf([{ subject: "a" } as any]);
  const mapped = mapCorpus(original, (cl) => ({ ...cl, subject: "b" } as any));
  expect(mapped.claims[0].subject).toBe("b");
  expect(original.claims[0].subject).toBe("a");
  expect(Object.isFrozen(mapped.claims)).toBe(true);
  expect(mapped).not.toBe(original);
});

it("ScoredClaim holds a claim and a numeric score", () => {
  const scored: ScoredClaim = {
    claim: { subject: "x" } as any as Claim,
    score: 0.95,
  };
  expect(scored.score).toBe(0.95);
  expect(scored.claim.subject).toBe("x");
});

it("RankedCorpus holds an array of ScoredClaims", () => {
  const ranked: RankedCorpus = {
    scored: [{ claim: { subject: "x" } as any as Claim, score: 0.9 }],
  };
  expect(ranked.scored).toHaveLength(1);
  expect(ranked.scored[0].score).toBe(0.9);
});

it("ComposedContext holds format, content, and tokenCount", () => {
  const ctx: ComposedContext = {
    format: "xml",
    content: "<root/>",
    tokenCount: 3,
  };
  expect(ctx.format).toBe("xml");
  expect(ctx.content).toBe("<root/>");
  expect(ctx.tokenCount).toBe(3);
});
