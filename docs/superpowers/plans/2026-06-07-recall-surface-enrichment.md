# Recall Surface Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recall reports entity-coverage facts (structured field + auditable warning) and provenance handles (`id`, `tags`) so calling agents can refuse explainably and cite claims — per the audited spec `docs/superpowers/specs/2026-06-07-recall-surface-enrichment-design.md`.

**Architecture:** A pure retrieval-layer module (`src/retrieval/coverage.ts`, the `key-alias.ts` placement precedent) holds the bench-validated heuristic VERBATIM; MCP `recall` consumes it over the PRE-knob `ranked.scored` basis; the server's `outputSchema` + `structuredContent` are both updated (dual-site obligation); the bench study migrates to the shared module and derives its scalar locally.

**Tech Stack:** TypeScript, vitest, zod (server schemas). No new dependencies, no models, no LLM.

---

### Task 1: `src/retrieval/coverage.ts` — pure module + unit tests

**Files:**
- Create: `src/retrieval/coverage.ts`
- Test: `src/retrieval/coverage.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/retrieval/coverage.test.ts`
Expected: FAIL — `Cannot find module './coverage.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/retrieval/coverage.ts
/**
 * Entity-coverage recipe for the recall surface (spec:
 * docs/superpowers/specs/2026-06-07-recall-surface-enrichment-design.md).
 *
 * HEURISTIC v1, kept VERBATIM to the bench-validated implementation
 * (bench/longmemeval/manual/abstention-signals.ts; 62.5% flag precision on
 * LME-oracle): capitalized words + number-bearing tokens, minus a question-word
 * stoplist — stoplist-only, NO position logic. English-capitalization dependent;
 * lowercase entities and paraphrases are known misses. `entityTokensOf` is the
 * named swap seam for a future NER — consumers never change.
 *
 * Pure and deterministic: no models, no I/O, no clock. Retrieval-layer placement
 * per the key-alias.ts precedent; imports core types only.
 */
import type { Claim } from "../core/claim.js";

/** The validated question-word stoplist (exported for tests). */
export const ENTITY_STOPWORDS: ReadonlySet<string> = new Set([
  "When", "Which", "Who", "What", "How", "Where", "Why",
  "Did", "Do", "Does", "Is", "Are", "Was", "Were", "The", "I",
]);

const ENTITY_TOKEN = /\b(?:[A-Z][a-zA-Z]+|\d+[a-zA-Z]*)\b/g;

export function entityTokensOf(text: string): string[] {
  return [...new Set(text.match(ENTITY_TOKEN) ?? [])].filter((w) => !ENTITY_STOPWORDS.has(w));
}

export interface CoverageEntity {
  text: string;
  supported: boolean;
}
export interface CoverageReport {
  /** One entry per extracted token, extraction order. */
  entities: CoverageEntity[];
  /** The unsupported subset, extraction order. */
  missing: string[];
}

/**
 * Case-insensitive containment of each entity over the claims'
 * subject + key + String(value) text. Empty entities ⇒ empty report.
 */
export function coverageOf(entities: readonly string[], claims: readonly Claim[]): CoverageReport {
  const haystack = claims
    .map((c) => `${c.subject} ${c.key} ${String(c.value)}`)
    .join(" ")
    .toLowerCase();
  const report: CoverageEntity[] = entities.map((text) => ({
    text,
    supported: haystack.includes(text.toLowerCase()),
  }));
  return { entities: report, missing: report.filter((e) => !e.supported).map((e) => e.text) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/retrieval/coverage.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/retrieval/coverage.ts src/retrieval/coverage.test.ts
git commit -m "feat(retrieval): entity-coverage recipe — verbatim bench-validated heuristic"
```

---

### Task 2: Recall integration — coverage field, warning, provenance handles

**Files:**
- Modify: `src/mcp/tools.ts` (RecallMatch ~174-180, RecallResult ~181-198, recall body ~304-342)
- Test: `src/mcp/tools.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

```typescript
// append to src/mcp/tools.test.ts
describe("recall — coverage annotation + provenance handles", () => {
  it("reports missing entities with the auditable warning wording", async () => {
    const s = freshSession();
    remember(s, { subject: "user", key: "accommodation", value: "Airbnb", corpus: "cov" });
    const r = await recall(s, { about: "When did I book the Airbnb in Sacramento?", corpus: "cov" }, jaccardDeps);
    expect(r.coverage.missing).toEqual(["Sacramento"]);
    expect(r.coverage.entities).toEqual([
      { text: "Airbnb", supported: true },
      { text: "Sacramento", supported: false },
    ]);
    expect(r.warnings?.some((w) => w.includes("no claim available to this recall") && w.includes("'Sacramento'"))).toBe(true);
    s.close();
  });

  it("fully covered question: coverage present, no coverage warning", async () => {
    const s = freshSession();
    remember(s, { subject: "user", key: "city", value: "Sacramento trip", corpus: "cov2" });
    const r = await recall(s, { about: "What about Sacramento?", corpus: "cov2" }, jaccardDeps);
    expect(r.coverage.missing).toEqual([]);
    expect(r.warnings?.some((w) => w.includes("no claim available"))).toBeFalsy();
    s.close();
  });

  it("basis is PRE-knob: a floor-dropped claim still counts as available", async () => {
    const s = freshSession();
    remember(s, { subject: "user", key: "note", value: "Sacramento mention", corpus: "cov3" });
    // relevanceFloor 0.99 drops everything from matches, but the claim was AVAILABLE
    const r = await recall(s, { about: "Anything about Sacramento?", corpus: "cov3", relevanceFloor: 0.99 }, jaccardDeps);
    expect(r.matches).toEqual([]);
    expect(r.coverage.missing).toEqual([]); // Sacramento was available pre-knob
    s.close();
  });

  it("empty corpus: every entity missing and the warning fires", async () => {
    const s = freshSession();
    ensureCorpus(s, "cov-empty");
    const r = await recall(s, { about: "Anything about Sacramento?", corpus: "cov-empty" }, jaccardDeps);
    expect(r.coverage.missing).toEqual(["Anything", "Sacramento"]);
    expect(r.warnings?.some((w) => w.includes("no claim available to this recall"))).toBe(true);
    s.close();
  });

  it("UNKNOWN corpus early-return still carries all-missing coverage + warning (audit M1)", async () => {
    const s = freshSession();
    const r = await recall(s, { about: "Anything about Sacramento?", corpus: "never-created" }, jaccardDeps);
    expect(r.matches).toEqual([]);
    expect(r.coverage.missing).toEqual(["Anything", "Sacramento"]);
    expect(r.warnings?.some((w) => w.includes("no claim available to this recall"))).toBe(true);
    s.close();
  });

  it("matches carry id and tags from the underlying claim", async () => {
    const s = freshSession();
    remember(s, { subject: "user", key: "editor", value: "vim", corpus: "prov", tags: ["session:s1"] });
    const r = await recall(s, { about: "editor", corpus: "prov" }, jaccardDeps);
    expect(r.matches[0].id).toEqual(expect.any(String));
    expect(r.matches[0].id.length).toBeGreaterThan(0);
    expect(r.matches[0].tags).toContain("session:s1");
    s.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/mcp/tools.test.ts`
Expected: FAIL — `coverage` / `id` / `tags` do not exist on the result types

- [ ] **Step 3: Implement in `src/mcp/tools.ts`**

3a. Add the import (with the other retrieval imports near the top):

```typescript
import { entityTokensOf, coverageOf } from "../retrieval/coverage.js";
import type { CoverageReport } from "../retrieval/coverage.js";
```

3b. Extend `RecallMatch` (provenance handles — `id` is a plain `string` on the
public surface; the branded `ClaimId` must not leak):

```typescript
export interface RecallMatch {
  subject: string;
  key: string;
  value: unknown;
  confidence: number;
  score: number;
  /** Claim id — provenance handle so agents can cite the exact claim. */
  id: string;
  /** Claim tags (e.g. session:...) — attribution handle. */
  tags: string[];
}
```

3c. Extend `RecallResult` (after `warnings`):

```typescript
  /** Entity-coverage facts over the PRE-knob ranked survivors ("available to
   *  this recall"). Always present; agent-in-the-loop refusal input. */
  coverage: CoverageReport;
```

3d-i. **Unknown-corpus early return (MUST also carry coverage — audit M1):** `recall()`
returns an `emptyResult` for unknown corpora (tools.ts:210-222) BEFORE the pipeline
runs; with `coverage` non-optional that literal no longer compiles, and the spec
§5 row (unknown corpus ⇒ all-missing + warning) requires it. Compute entities
once, up where `emptyResult` is built, and rework the early return:

```typescript
  // Entity tokens computed once — used by the unknown-corpus early return AND
  // the post-pipeline coverage computation.
  const entities = entityTokensOf(args.about);
  const coverageWarning = (missing: string[]): string =>
    `question entities with no claim available to this recall: ${missing.map((m) => `'${m}'`).join(", ")}`;

  if (!session.listCorpora().some((c) => c.id === args.corpus)) {
    const coverage = coverageOf(entities, []); // unknown corpus: nothing available
    return {
      ...emptyResult,
      coverage,
      warnings: coverage.missing.length > 0 ? [coverageWarning(coverage.missing)] : undefined,
    };
  }
```

(Keep `emptyResult` itself coverage-free and spread it — or inline the fields;
either way the RETURNED object satisfies the non-optional contract.)

3d-ii. In the main path, immediately after `const topScore = ranked.scored[0]?.score;`
(the pre-knob point — this IS the basis):

```typescript
  // Entity coverage over the PRE-knob survivor set (the bench-validated basis;
  // knobs affect what is returned, not what was available).
  const coverage = coverageOf(entities, ranked.scored.map((s) => s.claim));
  if (coverage.missing.length > 0) {
    allWarnings.push(coverageWarning(coverage.missing));
  }
```

3e. Extend the `matches` mapping with the handles:

```typescript
  const matches: RecallMatch[] = knobbed.scored.slice(0, limit).map((s) => ({
    subject: s.claim.subject,
    key: s.claim.key,
    value: s.claim.value,
    confidence: pointEstimate(s.claim.confidence),
    score: s.score,
    id: s.claim.id,
    tags: [...s.claim.tags],
  }));
```

3f. Add `coverage` to the return object (after `rankFn`):

```typescript
    rankFn: embeddings.rankFn,
    coverage,
    warnings: allWarnings.length > 0 ? allWarnings : undefined,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/mcp/tools.test.ts`
Expected: PASS (all existing + 4 new)

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.ts src/mcp/tools.test.ts
git commit -m "feat(mcp): recall coverage annotation (pre-knob basis) + provenance handles"
```

---

### Task 3: Server dual-site update + barrel export + integration tests

**Files:**
- Modify: `src/mcp/server.ts` (recall outputSchema ~120-136, structuredContent ~179-187)
- Modify: `src/index.ts` (retrieval barrel block)
- Test: `src/mcp/server.integration.test.ts` (append)

Note (audit S2): the integration test omits `corpus` args deliberately — `connected("covsrv")` wires `defaultCorpus: "covsrv"`, and the server resolves omitted corpus to it.

- [ ] **Step 1: Write the failing integration test**

```typescript
// append to src/mcp/server.integration.test.ts
it("recall structuredContent carries coverage and match provenance handles", async () => {
  const { client } = await connected("covsrv");
  await client.callTool({
    name: "remember",
    arguments: { subject: "user", key: "accommodation", value: "Airbnb", tags: ["session:s1"] },
  });
  const res = (await client.callTool({
    name: "recall",
    arguments: { about: "When did I book the Airbnb in Sacramento?" },
  })) as {
    structuredContent?: {
      coverage: { entities: { text: string; supported: boolean }[]; missing: string[] };
      matches: { id: string; tags: string[] }[];
      warnings?: string[];
    };
  };
  expect(res.structuredContent?.coverage.missing).toEqual(["Sacramento"]);
  expect(res.structuredContent?.matches[0]?.id).toEqual(expect.any(String));
  expect(res.structuredContent?.matches[0]?.tags).toContain("session:s1");
  expect(res.structuredContent?.warnings?.some((w) => w.includes("no claim available to this recall"))).toBe(true);
  await client.close();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/mcp/server.integration.test.ts`
Expected: FAIL — `coverage` undefined in structuredContent (schema drops it)

- [ ] **Step 3: Update BOTH server sites (the dual-site obligation)**

3a. `outputSchema`: extend the per-match object and add `coverage`:

```typescript
        matches: z.array(
          z.object({
            subject: z.string(),
            key: z.string(),
            value: z.any().describe("the claim value (any JSON)"),
            confidence: z.number().describe("point estimate of the claim's confidence, 0..1"),
            score: z.number().describe("similarity score against the query"),
            id: z.string().describe("claim id — provenance handle for citing the exact claim"),
            tags: z.array(z.string()).describe("claim tags (e.g. session attribution)"),
          }),
        ),
        coverage: z.object({
          entities: z.array(z.object({ text: z.string(), supported: z.boolean() })),
          missing: z.array(z.string()),
        }).describe("entity-coverage facts over the pre-knob survivors; agents decide refusal"),
```

3b. `structuredContent`: add the field (after `rankFn`):

```typescript
          rankFn: r.rankFn,
          coverage: r.coverage,
          warnings: r.warnings,
```

3c. `src/index.ts` — add to the retrieval barrel block (next to the key-alias exports):

```typescript
export { entityTokensOf, coverageOf, ENTITY_STOPWORDS } from "./retrieval/coverage.js";
export type { CoverageReport, CoverageEntity } from "./retrieval/coverage.js";
```

- [ ] **Step 4: Run integration tests to verify they pass**

Run: `npx vitest run src/mcp/server.integration.test.ts`
Expected: PASS (all existing + 1 new)

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts src/index.ts src/mcp/server.integration.test.ts
git commit -m "feat(mcp): coverage + provenance through outputSchema and structuredContent; barrel exports"
```

---

### Task 4: Bench migration to the shared module + full regression

**Files:**
- Modify: `bench/longmemeval/manual/abstention-signals.ts` (inline block ~131-151)

- [ ] **Step 1: Migrate the inline heuristic to the shared module**

Add the import:

```typescript
import { entityTokensOf, coverageOf } from "../../../src/retrieval/coverage.js";
```

Replace the inline block (the `QUESTION_WORDS` set, `entityTokens`, `corpusText`,
`covered` lines) with (preserving a one-line pointer to the original rationale —
audit S1):

```typescript
      // entityCoverage via the SHARED retrieval module (single implementation;
      // this study remains the standing verification instrument for the signal —
      // rationale: abstention questions are missing-entity questions on covered topics).
      // The scalar is derived locally — coverageOf returns the structured report;
      // the bench's empty-list ⇒ 1 convention is preserved here.
      const entityTokens = entityTokensOf(q.question);
      const { missing } = coverageOf(entityTokens, scored.map((s) => s.claim));
```

And in the `signals` object replace the `entityCoverage` line with:

```typescript
        entityCoverage: entityTokens.length
          ? (entityTokens.length - missing.length) / entityTokens.length
          : 1,
```

- [ ] **Step 2: Typecheck + targeted tests**

Run: `npx tsc --noEmit && npx vitest run bench/longmemeval/manual/ src/retrieval/ src/mcp/`
Expected: typecheck clean; all PASS

- [ ] **Step 3: Full regression**

Run: `npm test`
Expected: ALL PASS (baseline 1,644 + new; zero pre-existing expectation edits)

- [ ] **Step 4: Commit**

```bash
git add bench/longmemeval/manual/abstention-signals.ts
git commit -m "bench(lme): abstention study consumes the shared coverage module"
```

---

## Spec-coverage check (self-review)

- Spec §1 (module, verbatim heuristic, seam doc) → Task 1
- Spec §2 (coverage field, pre-knob basis, combined warning, insertion point, purity) → Task 2
- Spec §3 (provenance handles, plain-string id) → Task 2
- Spec §4 (dual-site schema, census non-extension [no task — deliberate], barrel) → Task 3
- Spec §5 (error paths) → Task 1 step 1 (never-throws/empty cases) + Task 2 tests (abstained covered by basis test wording; floor test)
- Spec §6/§7 (tests incl. wording substring, basis pinning, AC5 regression) → Tasks 1-4
- Out-of-scope items: none implemented — conforms
