import { describe, it, expect } from "vitest";
import { parseDsl } from "./dsl.js";
import type { Corpus, RankedCorpus } from "../algebra/types.js";
import type { Claim } from "../core/claim.js";
import type { EvalContext } from "../algebra/expression.js";

// ── test helpers ────────────────────────────────────────────────────────────

/** Minimal EvalContext stub — enough for sigma/delta/rho/kappa/alpha stages. */
function makeCtx(opts: { now?: number } = {}): EvalContext {
  // sigma is capability-aware: it calls ctx.adapter.capabilities() to route value
  // predicates. The stub declares everything fallback_in_memory (matching the SQLite
  // adapter), so routing is a no-op and the stage filters in memory as these tests expect.
  const capabilities = () => ({
    valuePredicateSupport: {
      equality: "fallback_in_memory",
      range: "fallback_in_memory",
      set_membership: "fallback_in_memory",
      regex: "fallback_in_memory",
      structural_pattern: "fallback_in_memory",
      null_check: "fallback_in_memory",
    },
  });
  return {
    adapter: { capabilities } as any,
    catalog: null as any,
    evaluationClock: opts.now ?? 1_000_000,
    usedSimilarityVersions: {},
    usedEmbeddingModelVersions: {},
  };
}

let _counter = 0;
function makeClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: `id-${++_counter}` as any,
    profile: "p" as any,
    workspace: "ws" as any,
    subject: "alice",
    key: "email" as any,
    scope: {},
    scopeHash: "_",
    value: { type: "string", v: "alice@example.com" } as any,
    valueHash: "vh",
    confidence: { distribution: "beta", parameters: { alpha: 9, beta: 1 }, raw: 0.9 },
    valid: { from: 0, to: 9_999_999 },
    recorded: 100_000,
    recordedSeq: 1,
    status: "validated",
    source: "manual",
    provenance: {} as any,
    evidence: [],
    audience: {},
    tags: [],
    schema: "default",
    ...overrides,
  };
}

function corpusOf(claims: Claim[]): Corpus {
  return { claims: Object.freeze([...claims]) };
}

/**
 * Extract clause-stage[1] from a DSL string (stage[0] is always the leaf).
 * Runs the stage directly against the provided corpus using a stub EvalContext.
 */
function runClause<O>(dsl: string, input: unknown, now?: number): O {
  const stages = parseDsl("c", dsl);
  // stages[0] = leaf, stages[1] = the compiled clause stage
  const clauseStage = stages[1];
  return clauseStage(input as any, makeCtx({ now })) as O;
}

// ── structural / smoke tests (keep existing coverage) ───────────────────────

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

  // ── behavioral: where-filter family ────────────────────────────────────────
  // These tests execute the compiled stage against a real corpus to verify
  // the correct sigma predicate was routed, not just that a stage was produced.

  it("where subject = X routes to subjectEq: only subject-matching claims survive", () => {
    const alice = makeClaim({ subject: "alice" });
    const bob = makeClaim({ subject: "bob" });
    const corpus = corpusOf([alice, bob]);

    const result = runClause<Corpus>("where subject = alice", corpus);

    expect(result.claims).toHaveLength(1);
    expect(result.claims[0].subject).toBe("alice");
  });

  it("where key = K routes to keyEq: only key-matching claims survive (not subject-matching)", () => {
    // Claim with matching key but non-matching subject
    const emailClaim = makeClaim({ subject: "alice", key: "email" as any });
    // Claim with matching subject but non-matching key
    const phoneClaim = makeClaim({ subject: "email", key: "phone" as any });
    const corpus = corpusOf([emailClaim, phoneClaim]);

    const result = runClause<Corpus>("where key = email", corpus);

    // keyEq must filter on key field, not subject — only emailClaim survives
    expect(result.claims).toHaveLength(1);
    expect((result.claims[0] as Claim).key).toBe("email");
  });

  it("where subject = X and where key = X produce reference-distinct stages (routing differs)", () => {
    // Different clause text → different closure → not reference-equal
    const subjectStage = parseDsl("c", "where subject = x")[1];
    const keyStage = parseDsl("c", "where key = x")[1];
    expect(subjectStage).not.toBe(keyStage);
  });

  it("where status = validated routes to statusEq: deprecated claim is excluded", () => {
    const validated = makeClaim({ status: "validated" });
    const deprecated = makeClaim({ status: "deprecated" });
    const corpus = corpusOf([validated, deprecated]);

    const result = runClause<Corpus>("where status = validated", corpus);

    expect(result.claims).toHaveLength(1);
    expect(result.claims[0].status).toBe("validated");
  });

  it("where confidence > 0.5 routes to confidenceGt: low-confidence claim is excluded", () => {
    // high confidence: alpha=9, beta=1 → raw ≈ 0.9
    const highConf = makeClaim({
      confidence: { distribution: "beta", parameters: { alpha: 9, beta: 1 }, raw: 0.9 },
    });
    // low confidence: alpha=1, beta=9 → raw ≈ 0.1
    const lowConf = makeClaim({
      confidence: { distribution: "beta", parameters: { alpha: 1, beta: 9 }, raw: 0.1 },
    });
    const corpus = corpusOf([highConf, lowConf]);

    const result = runClause<Corpus>("where confidence > 0.5", corpus);

    expect(result.claims).toHaveLength(1);
    // The surviving claim should be the high-confidence one
    expect(result.claims[0]).toBe(highConf);
  });

  // ── behavioral: rank family ─────────────────────────────────────────────────
  // Rank stages transform Corpus → RankedCorpus. We verify the output type and
  // that jaccard vs exact produce observably different scoring behavior.

  it("rank jaccard produces a RankedCorpus with scored entries", () => {
    const claim = makeClaim({ value: { type: "string", v: "hello world" } as any });
    const corpus = corpusOf([claim]);

    const result = runClause<RankedCorpus>(`rank jaccard "hello"`, corpus);

    expect(result).toHaveProperty("scored");
    expect(Array.isArray(result.scored)).toBe(true);
    expect(result.scored).toHaveLength(1);
    expect(typeof result.scored[0].score).toBe("number");
  });

  it("rank exact produces a RankedCorpus with scored entries", () => {
    const claim = makeClaim({ value: { type: "string", v: "exact match" } as any });
    const corpus = corpusOf([claim]);

    const result = runClause<RankedCorpus>(`rank exact "exact match"`, corpus);

    expect(result).toHaveProperty("scored");
    expect(result.scored).toHaveLength(1);
    expect(typeof result.scored[0].score).toBe("number");
  });

  it("rank jaccard and rank exact produce reference-distinct stages", () => {
    const jaccardStage = parseDsl("c", `rank jaccard "q"`)[1];
    const exactStage = parseDsl("c", `rank exact "q"`)[1];
    expect(jaccardStage).not.toBe(exactStage);
  });

  it("rank jaccard scores partial overlap higher than zero; rank exact scores partial overlap as zero", () => {
    // "hello world" vs query "hello" → jaccard: partial match > 0; exact: no match = 0
    const claim = makeClaim({ value: { type: "string", v: "hello world" } as any });
    const corpus = corpusOf([claim]);

    const jaccardResult = runClause<RankedCorpus>(`rank jaccard "hello"`, corpus);
    const exactResult = runClause<RankedCorpus>(`rank exact "hello"`, corpus);

    // jaccard partial overlap → score > 0
    expect(jaccardResult.scored[0].score).toBeGreaterThan(0);
    // exact: "hello world" !== "hello" → score = 0
    expect(exactResult.scored[0].score).toBe(0);
  });

  // ── behavioral: decay family ────────────────────────────────────────────────
  // decay sets confidence.effective on each claim. decay none → effective = raw;
  // decay exp → effective < raw for aged claims.

  it("decay none sets effective equal to raw confidence", () => {
    const claim = makeClaim({
      confidence: { distribution: "beta", parameters: { alpha: 9, beta: 1 }, raw: 0.9 },
      recorded: 1_000,
    });
    const corpus = corpusOf([claim]);

    // evaluationClock >> recorded → old claim; but 'decay none' should not decay
    const result = runClause<Corpus>("decay none", corpus, 1_000_000_000);

    expect(result.claims[0].confidence.effective).toBeCloseTo(0.9, 2);
  });

  it("decay exp reduces effective confidence for aged claims", () => {
    const claim = makeClaim({
      confidence: { distribution: "beta", parameters: { alpha: 9, beta: 1 }, raw: 0.9 },
      recorded: 0,
    });
    const corpus = corpusOf([claim]);

    // Use a halfLife of 30 days; age the claim by 60 days (2 half-lives → effective ≈ raw/4)
    const sixtyDaysMs = 60 * 86_400_000;
    const result = runClause<Corpus>("decay exp 30", corpus, sixtyDaysMs);

    // After 2 half-lives, effective should be roughly raw * 0.25
    const effective = result.claims[0].confidence.effective!;
    expect(effective).toBeGreaterThan(0);
    expect(effective).toBeLessThan(0.9 * 0.5); // definitely decayed
  });

  it("decay none and decay exp 30 produce reference-distinct stages", () => {
    const noneStage = parseDsl("c", "decay none")[1];
    const expStage = parseDsl("c", "decay exp 30")[1];
    expect(noneStage).not.toBe(expStage);
  });

  // ── behavioral: compose (as) family ────────────────────────────────────────
  // kappa stages transform RankedCorpus → ComposedContext. Assert format field.

  it("as markdown produces ComposedContext with format='markdown'", () => {
    const rc: RankedCorpus = {
      scored: [{ claim: makeClaim({ value: { type: "string", v: "hello" } as any }), score: 0.9 }],
    };
    const result = runClause<{ format: string; content: string; tokenCount: number }>("as markdown 2000", rc);
    expect(result.format).toBe("markdown");
    expect(typeof result.content).toBe("string");
  });

  it("as xml produces ComposedContext with format='xml'", () => {
    const rc: RankedCorpus = {
      scored: [{ claim: makeClaim({ value: { type: "string", v: "hello" } as any }), score: 0.9 }],
    };
    const result = runClause<{ format: string; content: string; tokenCount: number }>("as xml 1000", rc);
    expect(result.format).toBe("xml");
  });

  it("as json produces ComposedContext with format='json'", () => {
    const rc: RankedCorpus = {
      scored: [{ claim: makeClaim({ value: { type: "string", v: "hello" } as any }), score: 0.9 }],
    };
    const result = runClause<{ format: string; content: string; tokenCount: number }>("as json 500", rc);
    expect(result.format).toBe("json");
  });

  it("as text produces ComposedContext with format='text'", () => {
    const rc: RankedCorpus = {
      scored: [{ claim: makeClaim({ value: { type: "string", v: "hello" } as any }), score: 0.9 }],
    };
    const result = runClause<{ format: string; content: string; tokenCount: number }>("as text 750", rc);
    expect(result.format).toBe("text");
  });

  it("as markdown and as xml produce reference-distinct stages", () => {
    const markdownStage = parseDsl("c", "as markdown 1000")[1];
    const xmlStage = parseDsl("c", "as xml 1000")[1];
    expect(markdownStage).not.toBe(xmlStage);
  });

  it("as markdown and as json produce reference-distinct stages", () => {
    const markdownStage = parseDsl("c", "as markdown 1000")[1];
    const jsonStage = parseDsl("c", "as json 1000")[1];
    expect(markdownStage).not.toBe(jsonStage);
  });

  // ── behavioral: count ───────────────────────────────────────────────────────
  // alpha.count transforms Corpus → AggregateResult with a count group.

  it("count returns AggregateResult with count equal to corpus size", () => {
    const corpus = corpusOf([makeClaim(), makeClaim(), makeClaim()]);

    const result = runClause<{ groups: Map<string, { key: unknown; value: { kind: string; n: number } }> }>(
      "count",
      corpus
    );

    expect(result).toHaveProperty("groups");
    expect(result.groups instanceof Map).toBe(true);
    // alphaCount wraps result under "__none__" key
    const entry = result.groups.get("__none__")!;
    expect(entry).toBeDefined();
    expect(entry.value.kind).toBe("count");
    expect(entry.value.n).toBe(3);
  });

  it("count returns 0 for empty corpus", () => {
    const corpus = corpusOf([]);

    const result = runClause<{ groups: Map<string, { key: unknown; value: { kind: string; n: number } }> }>(
      "count",
      corpus
    );

    const entry = result.groups.get("__none__")!;
    expect(entry).toBeDefined();
    expect(entry.value.n).toBe(0);
  });
});
