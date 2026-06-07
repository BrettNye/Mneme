// src/retrieval/coverage.test.ts
import { describe, it, expect } from "vitest";
import { entityTokensOf, coverageOf, ENTITY_STOPWORDS } from "./coverage.js";

const claim = (subject: string, key: string, value: unknown) =>
  ({ subject, key, value } as any);

describe("entityTokensOf (verbatim bench heuristic — stoplist-only, no position logic)", () => {
  it("extracts capitalized and number-bearing tokens, dropping stopwords", () => {
    expect(entityTokensOf("When did I book the Airbnb in Sacramento?")).toEqual([
      "Airbnb",
      "Sacramento",
    ]);
  });
  it("keeps number-bearing tokens like model numbers", () => {
    expect(entityTokensOf("Which came first, the Ferrari or the Porsche 991?")).toEqual([
      "Ferrari",
      "Porsche",
      "991",
    ]);
  });
  it("deduplicates while preserving first-occurrence order", () => {
    expect(entityTokensOf("Tom met Alex before Tom moved")).toEqual(["Tom", "Alex"]);
  });
  it("returns [] for empty/whitespace/stopword-only input and never throws", () => {
    expect(entityTokensOf("")).toEqual([]);
    expect(entityTokensOf("   ")).toEqual([]);
    expect(entityTokensOf("When did I?")).toEqual([]);
  });
  it("exports the stoplist (the validated QUESTION_WORDS set)", () => {
    expect(ENTITY_STOPWORDS.has("When")).toBe(true);
    expect(ENTITY_STOPWORDS.has("Sacramento")).toBe(false);
  });
});

describe("coverageOf", () => {
  const claims = [
    claim("user", "past accommodation preference", "Airbnb"),
    claim("user", "planned airport transportation", "BART then taxi"),
  ];
  it("marks entities supported via case-insensitive containment over subject+key+value", () => {
    const r = coverageOf(["Airbnb", "Sacramento", "BART"], claims);
    expect(r.entities).toEqual([
      { text: "Airbnb", supported: true },
      { text: "Sacramento", supported: false },
      { text: "BART", supported: true },
    ]);
    expect(r.missing).toEqual(["Sacramento"]);
  });
  it("empty entity list yields empty report", () => {
    expect(coverageOf([], claims)).toEqual({ entities: [], missing: [] });
  });
  it("empty claims means everything is missing", () => {
    expect(coverageOf(["Tom"], []).missing).toEqual(["Tom"]);
  });
  it("scans non-string values via String()", () => {
    const r = coverageOf(["991"], [claim("user", "model", 991)]);
    expect(r.missing).toEqual([]);
  });
});
