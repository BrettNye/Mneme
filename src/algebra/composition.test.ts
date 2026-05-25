import { kappa, dedupContent, format, budget, defaultCounter, type TokenCounter } from "./composition.js";

// kappa xml - basic smoke test from spec
it("kappa emits well-formed xml under the token budget", () => {
  const rc = { scored: [{ claim: { value: "alpha design note" } as any, score: 0.9 }, { claim: { value: "beta note" } as any, score: 0.5 }] };
  const cc = kappa("xml", 12000)(rc);
  expect(cc.format).toBe("xml");
  expect(cc.content.startsWith("<context>")).toBe(true);
  expect(cc.tokenCount).toBeLessThanOrEqual(12000);
});

// format xml: wraps in <context> with per-claim score attribute
it("format xml wraps claims in <context> with score attributes", () => {
  const rc = { scored: [{ claim: { value: "hello world" } as any, score: 0.8 }] };
  const cc = format("xml")(rc);
  expect(cc.format).toBe("xml");
  expect(cc.content).toContain("<context>");
  expect(cc.content).toContain('</context>');
  expect(cc.content).toContain('<claim score="0.8">hello world</claim>');
});

// format markdown: produces bullet list
it("format markdown produces markdown bullet list", () => {
  const rc = { scored: [{ claim: { value: "first item" } as any, score: 0.9 }, { claim: { value: "second item" } as any, score: 0.5 }] };
  const cc = format("markdown")(rc);
  expect(cc.format).toBe("markdown");
  expect(cc.content).toContain("- first item");
  expect(cc.content).toContain("- second item");
});

// format json: produces JSON array of {value, score}
it("format json produces JSON array with value and score", () => {
  const rc = { scored: [{ claim: { value: "claim text" } as any, score: 0.7 }] };
  const cc = format("json")(rc);
  expect(cc.format).toBe("json");
  const parsed = JSON.parse(cc.content);
  expect(Array.isArray(parsed)).toBe(true);
  expect(parsed[0].value).toBe("claim text");
  expect(parsed[0].score).toBe(0.7);
});

// format xml: escapes special XML characters in claim values
it("format xml escapes < > & in claim values", () => {
  const rc = { scored: [{ claim: { value: "a < b & b > c" } as any, score: 0.5 }] };
  const cc = format("xml")(rc);
  // escaped entities must appear in output
  expect(cc.content).toContain("&lt;");
  expect(cc.content).toContain("&gt;");
  expect(cc.content).toContain("&amp;");
  // extract body between opening claim tag and closing claim tag
  const afterOpenTag = cc.content.split('<claim score="0.5">')[1];
  const body = afterOpenTag.split("</claim>")[0];
  // no raw < or > in body
  expect(body).not.toContain("<");
  expect(body).not.toContain(">");
  // no raw & (& not followed by entity keyword) — remove known entities and check no & remains
  const stripped = body.replace(/&amp;|&lt;|&gt;/g, "");
  expect(stripped).not.toContain("&");
});

// format text: plain text, no markup
it("format text produces plain text with no markup", () => {
  const rc = { scored: [{ claim: { value: "plain claim" } as any, score: 0.9 }] };
  const cc = format("text")(rc);
  expect(cc.format).toBe("text");
  expect(cc.content).toContain("plain claim");
  expect(cc.content).not.toContain("<");
  expect(cc.content).not.toContain("{");
});

// budget: keeps document within token budget
it("budget truncates content when over token budget", () => {
  // create a ComposedContext that is way over budget
  const longContent = "a".repeat(400); // 400 chars => defaultCounter gives 100 tokens
  const cc = { format: "text" as const, content: longContent, tokenCount: defaultCounter(longContent) };
  const result = budget(10)(cc); // max 10 tokens
  expect(result.tokenCount).toBeLessThanOrEqual(10);
  expect(result.content.length).toBeLessThanOrEqual(10 * 4); // 10 tokens * 4 chars/token
});

// budget: custom token counter — result must honor the counter's token model
it("budget with custom counter returns tokenCount <= max for any counter", () => {
  // custom counter: 1 token per char (so max=5 means at most 5 chars)
  const charCounter: TokenCounter = (s) => s.length;
  const max = 5;
  const longContent = "a".repeat(100); // 100 chars => charCounter gives 100 tokens
  const cc = { format: "text" as const, content: longContent, tokenCount: charCounter(longContent) };
  const result = budget(max, charCounter)(cc);
  // with max*4 slice and charCounter, naive slice gives 20 chars which is still > 5
  expect(result.tokenCount).toBeLessThanOrEqual(max);
  expect(charCounter(result.content)).toBeLessThanOrEqual(max);
});

// budget: returns unchanged when under budget
it("budget returns unchanged content when under budget", () => {
  const shortContent = "hello";
  const cc = { format: "text" as const, content: shortContent, tokenCount: defaultCounter(shortContent) };
  const result = budget(1000)(cc);
  expect(result.content).toBe(shortContent);
});

// dedupContent: removes near-duplicates above Jaccard threshold
it("dedupContent removes near-duplicate claims above threshold", () => {
  // "alpha beta gamma delta" and "alpha beta gamma delta extra" should be nearly identical
  const rc = {
    scored: [
      { claim: { value: "alpha beta gamma delta" } as any, score: 0.9 },
      { claim: { value: "alpha beta gamma delta" } as any, score: 0.5 }, // exact duplicate
    ],
  };
  const result = dedupContent(0.9)(rc);
  expect(result.scored.length).toBe(1);
});

// dedupContent: keeps distinct claims
it("dedupContent keeps distinct claims below threshold", () => {
  const rc = {
    scored: [
      { claim: { value: "alpha beta gamma" } as any, score: 0.9 },
      { claim: { value: "completely different xyz" } as any, score: 0.5 },
    ],
  };
  const result = dedupContent(0.9)(rc);
  expect(result.scored.length).toBe(2);
});

// dedupContent: removes near-duplicates (high overlap but not identical)
it("dedupContent removes near-duplicates with high Jaccard similarity", () => {
  // These two strings share most tokens (similarity should be >= 0.85)
  const rc = {
    scored: [
      { claim: { value: "the quick brown fox jumps" } as any, score: 0.9 },
      { claim: { value: "the quick brown fox jumps over" } as any, score: 0.8 },
    ],
  };
  // threshold 0.5 means anything >= 0.5 similarity gets removed
  const result = dedupContent(0.5)(rc);
  // second one has high overlap with first, should be removed
  expect(result.scored.length).toBe(1);
  expect(result.scored[0].claim.value).toBe("the quick brown fox jumps");
});

// kappa: chains dedup -> format -> budget
it("kappa chains dedup, format, and budget correctly", () => {
  const rc = {
    scored: [
      { claim: { value: "alpha beta gamma" } as any, score: 0.9 },
      { claim: { value: "alpha beta gamma" } as any, score: 0.5 }, // duplicate
    ],
  };
  const cc = kappa("text", 500)(rc);
  // after dedup, only 1 claim; text format; within budget
  expect(cc.format).toBe("text");
  expect(cc.tokenCount).toBeLessThanOrEqual(500);
  // duplicate removed -> content appears only once
  const occurrences = (cc.content.match(/alpha beta gamma/g) || []).length;
  expect(occurrences).toBe(1);
});

// ComposedContext is terminal: tokenCount matches defaultCounter(content)
it("defaultCounter returns ceil(length/4)", () => {
  expect(defaultCounter("abcd")).toBe(1);   // 4/4 = 1
  expect(defaultCounter("abcde")).toBe(2);  // ceil(5/4) = 2
  expect(defaultCounter("")).toBe(0);       // ceil(0/4) = 0
});
