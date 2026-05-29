import { describe, it, expect } from "vitest";
import { parseDsl } from "./dsl.js";

describe("parseDsl", () => {
  it("empty DSL returns [leaf(corpusId)] — length 1", () => {
    const stages = parseDsl("c", "");
    expect(stages).toHaveLength(1);
  });

  it("compiles select + rank + compose into leaf + 3 stages (length 4)", () => {
    const stages = parseDsl("c", `where subject = host:web-01 | rank jaccard "status" | as markdown 2000`);
    expect(stages).toHaveLength(4);
  });

  it("throws with a grammar hint on an unknown clause", () => {
    expect(() => parseDsl("c", "frobnicate x")).toThrow(/unknown clause/i);
  });

  it("unknown clause error message includes supported grammar", () => {
    let thrown: Error | undefined;
    try {
      parseDsl("c", "unknown thing");
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toMatch(/unknown clause/i);
    // Grammar hint should mention supported clauses
    expect(thrown!.message).toMatch(/where|rank|decay|as|count/i);
  });

  it("where subject = X produces a stage (sigma with subjectEq)", () => {
    const stages = parseDsl("c", "where subject = host:web-01");
    expect(stages).toHaveLength(2); // leaf + sigma
  });

  it("where key = K produces a stage", () => {
    const stages = parseDsl("c", "where key = my-key");
    expect(stages).toHaveLength(2);
  });

  it("where status = active produces a stage", () => {
    const stages = parseDsl("c", "where status = active");
    expect(stages).toHaveLength(2);
  });

  it("where confidence > 0.8 produces a stage", () => {
    const stages = parseDsl("c", "where confidence > 0.8");
    expect(stages).toHaveLength(2);
  });

  it("rank jaccard produces a stage", () => {
    const stages = parseDsl("c", `rank jaccard "my query"`);
    expect(stages).toHaveLength(2);
  });

  it("rank exact produces a stage", () => {
    const stages = parseDsl("c", `rank exact "my query"`);
    expect(stages).toHaveLength(2);
  });

  it("decay exp 30 produces a stage", () => {
    const stages = parseDsl("c", "decay exp 30");
    expect(stages).toHaveLength(2);
  });

  it("decay none produces a stage", () => {
    const stages = parseDsl("c", "decay none");
    expect(stages).toHaveLength(2);
  });

  it("as markdown N produces a stage", () => {
    const stages = parseDsl("c", "as markdown 2000");
    expect(stages).toHaveLength(2);
  });

  it("as xml N produces a stage", () => {
    const stages = parseDsl("c", "as xml 1000");
    expect(stages).toHaveLength(2);
  });

  it("as json N produces a stage", () => {
    const stages = parseDsl("c", "as json 500");
    expect(stages).toHaveLength(2);
  });

  it("as text N produces a stage", () => {
    const stages = parseDsl("c", "as text 750");
    expect(stages).toHaveLength(2);
  });

  it("count produces a stage", () => {
    const stages = parseDsl("c", "count");
    expect(stages).toHaveLength(2);
  });

  it("3-clause DSL produces 4 stages (leaf + 3 clause stages)", () => {
    const stages = parseDsl(
      "corpus1",
      `where subject = foo | rank jaccard "bar" | count`
    );
    expect(stages).toHaveLength(4);
  });

  it("stages are functions (each stage is callable)", () => {
    const stages = parseDsl("c", "count");
    for (const s of stages) {
      expect(typeof s).toBe("function");
    }
  });

  it("where subject = value with spaces works", () => {
    const stages = parseDsl("c", "where subject = some subject value");
    expect(stages).toHaveLength(2);
  });

  it("pipes with extra whitespace around | are handled", () => {
    const stages = parseDsl("c", "  where subject = x  |  count  ");
    expect(stages).toHaveLength(3);
  });
});
