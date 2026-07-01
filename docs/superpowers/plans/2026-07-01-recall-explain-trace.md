# Recall Explain Trace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in, best-effort `explainRecall` that re-derives `recall`'s read pipeline stage-by-stage and returns a per-claim `RecallTrace` (why each candidate was served / merged / deprecated / dropped) plus per-stage counts, exposed via library + MCP + CLI.

**Architecture:** `explainRecall` lives in `src/surface/explain.ts` next to the migrated `recall`. It re-runs the SAME stages `recall` composes (`σ → canonicalReadStages(τ_valid → ⊕_dedupe → ⊥/resolve → drop) → ranker → knobs → limit`), but stage-by-stage, capturing the corpus between stages and diffing claim-id sets to attribute dispositions. `recall()` itself is untouched (zero hot-path cost). Attribution details come from two algebra helpers: a new `dedupeGroups` (exposes `oplusDedupe`'s `mergedInto` map) and the already-exported `pairsOf` (contradiction pairs). Drift between the explainer and the real pipeline is caught by a load-bearing consistency-invariant test (served set === `recall().matches`).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, better-sqlite3. Node ≥ 20.

## Global Constraints

- **Layering (enforced by `src/surface/layering.test.ts`):** no file under `src/surface` or `src/retrieval` may import from `src/mcp`. Surface MAY import from `src/retrieval` and `src/algebra`. Algebra imports NOTHING from retrieval/surface; operators stay pure `Corpus → Corpus`.
- **Import specifiers use `.js`** even for `.ts` sources (ESM/tsx convention). Match existing files.
- **`recall()` behavior is frozen** — Task 2 is a pure refactor; the existing recall/back-compat/consistency tests must stay green with no assertion changes.
- **Reason vocabulary is a fixed contract** (spec §"The reason vocabulary"). Do not add/rename `DispositionReason` variants; Clusters B/C and Fix #5 consume it verbatim.
- **`explainRecall` is best-effort observability:** it never throws for a re-derive failure — it accumulates `warnings: string[]` and returns a partial/empty trace.
- **Verify after each task:** `npx vitest run` (full suite, currently 1855 passing) and `npx tsc --noEmit` both clean before committing.
- Spec: `docs/superpowers/specs/2026-07-01-recall-explain-trace-design.md`.

---

### Task 1: `dedupeGroups` — expose `oplusDedupe`'s merge attributions

**Files:**
- Modify: `src/algebra/combination.ts` (add `dedupeGroups`; re-express `oplusDedupe` in terms of it)
- Test: `src/algebra/combination.test.ts` (add a `dedupeGroups` describe block)

**Interfaces:**
- Consumes: existing `partitionBy`, `claimTripleKey`, `corpusOf` (from `./types.js`), `subPartitions`, `combineGroup`, `assertNotDeprecatedRule`, `similarityFn` (already in this file).
- Produces:
  ```ts
  export interface DedupeGroupsResult { survivors: Corpus; mergedInto: Map<string, string> }
  export const dedupeGroups: (ruleId: string, params?: unknown, opts?: DedupeOptions)
    => (c: Corpus) => DedupeGroupsResult;
  ```
  `mergedInto` maps each merged-away claim id → the surviving representative's id. For a singleton cluster the map gets no entry. `oplusDedupe(...)(c)` returns exactly `dedupeGroups(...)(c).survivors` (byte-identical behavior).

- [ ] **Step 1: Write the failing test**

Add to `src/algebra/combination.test.ts`. (Reuse whatever claim-builder/helper the existing tests in this file use — mirror an existing dedupe test's setup for `makeClaim`/`corpusOf`.)

```ts
import { dedupeGroups } from "./combination.js";

describe("dedupeGroups", () => {
  it("maps merged-away claims to their surviving representative and matches oplusDedupe survivors", () => {
    // Two token-similar values on the same (subject,key) → single cluster; latest valid.from wins.
    const older = makeClaim({ id: "c-old", subject: "s", key: "k", value: "deploy the web api", validFrom: 1 });
    const newer = makeClaim({ id: "c-new", subject: "s", key: "k", value: "deploy the web api now", validFrom: 2 });
    const other = makeClaim({ id: "c-other", subject: "s", key: "k2", value: "unrelated", validFrom: 1 });
    const c = corpusOf([older, newer, other]);

    const { survivors, mergedInto } = dedupeGroups(
      "rule_weighted_avg", undefined, { similarity: { fn: "jaccard", cutoff: 0.5 } },
    )(c);

    // c-old merged into the newer representative (valid.from DESC → c-new is representative)
    expect(mergedInto.get("c-old")).toBe("c-new");
    expect(mergedInto.has("c-new")).toBe(false);
    expect(mergedInto.has("c-other")).toBe(false);

    // survivors === what oplusDedupe returns
    const viaOplus = oplusDedupe("rule_weighted_avg", undefined, { similarity: { fn: "jaccard", cutoff: 0.5 } })(c);
    expect(new Set(survivors.claims.map((x) => x.id))).toEqual(new Set(viaOplus.claims.map((x) => x.id)));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/algebra/combination.test.ts -t dedupeGroups`
Expected: FAIL — `dedupeGroups is not a function` (not yet exported).

- [ ] **Step 3: Add `dedupeGroups` and re-express `oplusDedupe`**

In `src/algebra/combination.ts`, ADD above the current `oplusDedupe` const:

```ts
export interface DedupeGroupsResult {
  survivors: Corpus;
  /** merged-away claim id → surviving representative id (no entry for singleton clusters). */
  mergedInto: Map<string, string>;
}

/**
 * The grouping+merge core of ⊕_dedupe, exposing which claims were absorbed and into which
 * survivor. `oplusDedupe` is exactly `(c) => dedupeGroups(...)(c).survivors`.
 *
 * Survivor id: combineGroup returns one of the cluster's own claims (spread of sorted[0]
 * for arithmetic rules; the winning claim for max rules; the sole claim for singletons),
 * so `survivor.id` is always a member id — every non-survivor member maps to it.
 */
export const dedupeGroups =
  (ruleId: string, params?: unknown, opts?: DedupeOptions) =>
  (c: Corpus): DedupeGroupsResult => {
    assertNotDeprecatedRule(ruleId);

    if (opts?.similarity) {
      const { fn, cutoff } = opts.similarity;
      similarityFn(fn);
      if (cutoff < 0 || cutoff > 1) {
        throw new Error(`similarity cutoff ${cutoff} is outside [0, 1]`);
      }
    }

    const groups = partitionBy(c.claims as Claim[], (cl) =>
      claimTripleKey(cl.subject, cl.key, cl.scopeHash),
    );

    const out: Claim[] = [];
    const mergedInto = new Map<string, string>();
    for (const group of groups.values()) {
      for (const part of subPartitions(group, opts)) {
        const survivor = combineGroup(ruleId, part, params);
        out.push(survivor);
        for (const member of part) {
          if (member.id !== survivor.id) mergedInto.set(member.id, survivor.id);
        }
      }
    }
    return { survivors: corpusOf(out), mergedInto };
  };
```

Then REPLACE the body of `oplusDedupe` (keep its exported signature identical) with a delegation:

```ts
export const oplusDedupe =
  (ruleId: string, params?: unknown, opts?: DedupeOptions) =>
  (c: Corpus): Corpus =>
    dedupeGroups(ruleId, params, opts)(c).survivors;
```

- [ ] **Step 4: Run the new test and the full combination suite**

Run: `npx vitest run src/algebra/combination.test.ts`
Expected: PASS (new `dedupeGroups` test + all existing `oplusDedupe` tests — behavior unchanged).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` → clean.

```bash
git add src/algebra/combination.ts src/algebra/combination.test.ts
git commit -m "feat(algebra): dedupeGroups exposes oplusDedupe merge attributions"
```

---

### Task 2: Extract recall's shared stage-builders (drift-proof reuse) + `DEDUPE_DEFAULTS`

Pure refactor. `explainRecall` (Task 3) must build the SAME σ stages, ranker, warm-up, alias context, ⊥ pooling rule, and dedupe defaults as `recall`. Extracting them into exported helpers guarantees the two paths cannot drift. `recall()`'s observable behavior does not change.

**Files:**
- Modify: `src/surface/recall.ts` (export `loadAliasContext`, `MCP_EVIDENCE_POOLING_RULE`; add + export `buildFilterSigmas`, `buildRecallRanker`, `warmRecallValues`; rewire `recall()` to call them)
- Modify: `src/retrieval/read-pipeline.ts` (add + export `DEDUPE_DEFAULTS`; use it inside `canonicalReadStages`)

**Interfaces:**
- Produces (from `src/surface/recall.ts`):
  ```ts
  export const MCP_EVIDENCE_POOLING_RULE: string;                         // === RULE.MAX_MEAN
  export function loadAliasContext(session: Session, corpus: string, now: number,
    keyCardinality?: Record<string, "single" | "multi">): AliasLoadContext; // { aliasMap, selfAliases, warnings }
  export function buildFilterSigmas(args: RecallArgs, family?: string[]): Stage<Corpus, Corpus>[];
  export function buildRecallRanker(args: RecallArgs, rankFn: string): Stage<Corpus, RankedCorpus>;
  export async function warmRecallValues(session: Session, args: RecallArgs,
    embeddings: EmbeddingState, family?: string[]): Promise<void>;
  ```
- Produces (from `src/retrieval/read-pipeline.ts`):
  ```ts
  export const DEDUPE_DEFAULTS: { readonly rule: "rule_weighted_avg"; readonly fn: "jaccard"; readonly cutoff: 0.5 };
  ```
- Consumes: existing internals of `recall.ts` (`sigma`, `rho`, `warmValues`, `keyFamilyOf`, etc.).

- [ ] **Step 1: Add `DEDUPE_DEFAULTS` to read-pipeline and use it**

In `src/retrieval/read-pipeline.ts`, ADD near the top (after imports):

```ts
/** Default ⊕_dedupe config used by the canonical read core. Exported so re-derivers
 *  (explainRecall) run the identical dedupe rather than re-hardcoding constants. */
export const DEDUPE_DEFAULTS = { rule: "rule_weighted_avg", fn: "jaccard", cutoff: 0.5 } as const;
```

Then in `canonicalReadStages`, REPLACE the three literal defaults:

```ts
  const dedupeFn = opts.dedupe?.fn ?? DEDUPE_DEFAULTS.fn;
  const dedupeCutoff = opts.dedupe?.cutoff ?? DEDUPE_DEFAULTS.cutoff;
  const dedupeRule = opts.dedupe?.rule ?? DEDUPE_DEFAULTS.rule;
```

- [ ] **Step 2: Verify read-pipeline tests still pass (behavior unchanged)**

Run: `npx vitest run src/retrieval`
Expected: PASS (defaults are byte-identical; only their source moved to a const).

- [ ] **Step 3: Export `MCP_EVIDENCE_POOLING_RULE` and `loadAliasContext`**

In `src/surface/recall.ts`:
- Change `const MCP_EVIDENCE_POOLING_RULE = RULE.MAX_MEAN;` → `export const MCP_EVIDENCE_POOLING_RULE = RULE.MAX_MEAN;`
- Change `function loadAliasContext(` → `export function loadAliasContext(` (leave its body and the `AliasLoadContext` interface unchanged; export the interface too: `export interface AliasLoadContext`).

- [ ] **Step 4: Extract `buildFilterSigmas`, `buildRecallRanker`, `warmRecallValues`**

In `src/surface/recall.ts`, ADD these exported helpers (import `Stage` and `Corpus`/`RankedCorpus` types as needed — `RankedCorpus` is already imported from `../index.js`; add `import type { Stage } from "../algebra/expression.js";` and `import type { Corpus } from "../algebra/types.js";`):

```ts
/** σ filter stages for recall: subject eq + key family (keyIn) / single key eq.
 *  Mirrors the family-vs-single logic used by both recall() and explainRecall(). */
export function buildFilterSigmas(args: RecallArgs, family?: string[]): Stage<Corpus, Corpus>[] {
  const filters: Predicate[] = [];
  if (args.subject) filters.push({ op: "subjectEq", value: args.subject });
  if (family && family.length > 1) filters.push({ op: "keyIn", values: family });
  else if (args.key) filters.push({ op: "keyEq", value: args.key });
  return filters.map((p) => sigma(p));
}

/** The recall ranker: pure rho.by when recencyAlpha===1, else rho.blend (default alpha .5 / 90d). */
export function buildRecallRanker(args: RecallArgs, rankFn: string): Stage<Corpus, RankedCorpus> {
  return args.recencyAlpha === 1
    ? rho.by(rankFn, args.about)
    : rho.blend(rankFn, args.about, {
        alpha: args.recencyAlpha ?? 0.5,
        halfLifeDays: args.recencyHalfLifeDays ?? 90,
      });
}

/** Warm embedding values for the σ-scoped claims (family-expanded), so hybrid scoring
 *  uses cosine not jaccard-fallback. No-op unless hybrid + adapter + cache present. */
export async function warmRecallValues(
  session: Session, args: RecallArgs, embeddings: EmbeddingState, family?: string[],
): Promise<void> {
  if (embeddings.rankFn === "jaccard" || !embeddings.adapter || !embeddings.cache) return;
  const seenIds = new Set<string>();
  const rawClaims: import("../core/claim.js").Claim[] = [];
  if (family && family.length > 1) {
    for (const k of family) {
      for (const c of session.mneme.read(args.corpus, { corpusId: args.corpus, subject: args.subject, key: k })) {
        if (!seenIds.has(c.id)) { seenIds.add(c.id); rawClaims.push(c); }
      }
    }
  } else {
    rawClaims.push(...session.mneme.read(args.corpus, { corpusId: args.corpus, subject: args.subject, key: args.key }));
  }
  await warmValues(embeddings.adapter, embeddings.cache, rawClaims.map((c) => c.value), [args.about]);
}
```

- [ ] **Step 5: Rewire `recall()` to call the extracted helpers**

In `recall()`, REPLACE the inline warm-up block (the `if (embeddings.rankFn !== "jaccard" ...) { ... await warmValues(...) }` section) with:

```ts
  await warmRecallValues(session, args, embeddings, family);
```

REPLACE the inline σ-filter block (building `filters`/`sigmas`) with:

```ts
  const sigmas = buildFilterSigmas(args, family);
```

REPLACE the inline `ranker` assignment with:

```ts
  const ranker = buildRecallRanker(args, embeddings.rankFn);
```

Leave everything else (alias load call site, `canonicalReadStages`, knobs, κ compose) exactly as is.

- [ ] **Step 6: Run the full suite — recall behavior must be unchanged**

Run: `npx vitest run` and `npx tsc --noEmit`
Expected: PASS — all 1855 tests green, no assertion edits. If any recall test changed output, the refactor was not behavior-preserving; fix until identical.

- [ ] **Step 7: Commit**

```bash
git add src/surface/recall.ts src/retrieval/read-pipeline.ts
git commit -m "refactor(surface): extract recall stage-builders + DEDUPE_DEFAULTS for reuse by explain"
```

---

### Task 3: `explainRecall` + trace types (the core)

**Files:**
- Create: `src/surface/explain.ts`
- Test: `src/surface/explain.test.ts`

**Interfaces:**
- Consumes: `dedupeGroups`, `DedupeGroupsResult` (Task 1); `DEDUPE_DEFAULTS`, `MCP_EVIDENCE_POOLING_RULE`, `loadAliasContext`, `buildFilterSigmas`, `buildRecallRanker`, `warmRecallValues`, `parseAsOf`, `RecallArgs`, `RecallDeps`, `EmbeddingState` (Task 2 / existing recall.ts); `canonicalReadStages` (read-pipeline); `pairsOf` (contradiction); `CONTRADICTION_FLAG_KEY` (resolution); `isKeyAliasShaped`, `keyFamilyOf` (key-alias); `abstainBelowTop`, `relevanceFloor` (similarity); `pipe`, `leaf` (mneme).
- Produces:
  ```ts
  export type DispositionReason = /* the 8-variant union, verbatim from the spec */;
  export interface ClaimDisposition { id: string; subject: string; key: string;
    disposition: "served" | "merged" | "deprecated" | "dropped"; reason: DispositionReason; score?: number }
  export interface RecallTrace { corpus: string; candidateCount: number;
    stageCounts: { afterTau: number; afterDedupe: number; afterContradiction: number;
      ranked: number; afterKnobs: number; served: number };
    claims: ClaimDisposition[]; warnings?: string[] }
  export function explainRecall(session: Session, args: RecallArgs, deps: RecallDeps): Promise<RecallTrace>;
  ```

- [ ] **Step 1: Write the consistency-invariant test FIRST (the load-bearing guardrail)**

Create `src/surface/explain.test.ts`. Reuse the exact same in-memory session + `initEmbeddings`(jaccard) setup the existing `src/surface/recall.test.ts` uses — open it and mirror its `beforeEach`/helpers (session factory, `remember`/write helper, `deps`). Then:

```ts
import { describe, it, expect } from "vitest";
import { recall } from "./recall.js";
import { explainRecall } from "./explain.js";
// ...mirror recall.test.ts imports/session setup (jaccard deps: { embeddings: { rankFn: "jaccard" } })...

describe("explainRecall — consistency invariant", () => {
  it("served dispositions === recall().matches (same query, same deps)", async () => {
    // Arrange a corpus with a mix: a merge pair, a single-cardinality supersession, a plain served claim.
    // (Use the same write helper recall.test.ts uses; corpus id e.g. "c".)
    // ... writes ...
    const args = { about: "deploy", corpus: "c", limit: 5 } as const;
    const r = await recall(session, args, deps);
    const t = await explainRecall(session, args, deps);
    const served = t.claims.filter((d) => d.disposition === "served").map((d) => d.id);
    expect(new Set(served)).toEqual(new Set(r.matches.map((m) => m.id)));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/surface/explain.test.ts`
Expected: FAIL — `Cannot find module './explain.js'` (or `explainRecall is not a function`).

- [ ] **Step 3: Implement `src/surface/explain.ts`**

```ts
/**
 * explainRecall — read-provenance for `recall`. Re-derives the SAME pipeline recall
 * composes, stage-by-stage, and attributes each candidate claim's disposition. Best-effort:
 * never throws for a re-derive failure — accumulates `warnings` and returns a partial trace.
 * recall() is untouched → zero hot-path cost. Consistency with the real pipeline is guarded
 * by the served-set invariant test in explain.test.ts.
 */
import type { RankedCorpus } from "../index.js";
import { pipe, leaf } from "../mneme.js";
import type { Session } from "./types.js";
import {
  parseAsOf,
  loadAliasContext,
  buildFilterSigmas,
  buildRecallRanker,
  warmRecallValues,
  MCP_EVIDENCE_POOLING_RULE,
  type RecallArgs,
  type RecallDeps,
} from "./recall.js";
import { keyFamilyOf, isKeyAliasShaped } from "../retrieval/key-alias.js";
import { canonicalReadStages, DEDUPE_DEFAULTS } from "../retrieval/read-pipeline.js";
import { dedupeGroups } from "../algebra/combination.js";
import { pairsOf } from "../algebra/contradiction.js";
import { CONTRADICTION_FLAG_KEY } from "../algebra/resolution.js";
import { abstainBelowTop, relevanceFloor } from "../algebra/similarity.js";
import type { Corpus as AlgebraCorpus } from "../algebra/types.js";
import type { Claim } from "../core/claim.js";

export type DispositionReason =
  | { kind: "served" }
  | { kind: "merged-into"; targetId: string }
  | { kind: "deprecated-by"; byId: string; via: "single-cardinality" }
  | { kind: "tau-invalid" }
  | { kind: "below-floor"; score: number; floor: number }
  | { kind: "abstained"; topScore: number; threshold: number }
  | { kind: "over-limit"; rank: number; limit: number }
  | { kind: "alias-or-flag" };

export interface ClaimDisposition {
  id: string;
  subject: string;
  key: string;
  disposition: "served" | "merged" | "deprecated" | "dropped";
  reason: DispositionReason;
  score?: number;
}

export interface RecallTrace {
  corpus: string;
  candidateCount: number;
  stageCounts: {
    afterTau: number;
    afterDedupe: number;
    afterContradiction: number;
    ranked: number;
    afterKnobs: number;
    served: number;
  };
  claims: ClaimDisposition[];
  warnings?: string[];
}

export async function explainRecall(
  session: Session,
  args: RecallArgs,
  deps: RecallDeps,
): Promise<RecallTrace> {
  const warnings: string[] = [];
  const embeddings = deps.embeddings;
  const keyCardinality = deps.keyCardinality;
  const limit = args.limit ?? 5;

  const empty: RecallTrace = {
    corpus: args.corpus,
    candidateCount: 0,
    stageCounts: { afterTau: 0, afterDedupe: 0, afterContradiction: 0, ranked: 0, afterKnobs: 0, served: 0 },
    claims: [],
  };

  // Read-only: unknown corpus → empty trace (mirror recall's early return; never create it).
  if (!session.listCorpora().some((c) => c.id === args.corpus)) return empty;

  const now = parseAsOf(args.asOf) ?? Date.now();
  const { aliasMap, warnings: aliasWarnings } = loadAliasContext(session, args.corpus, now, keyCardinality);
  warnings.push(...aliasWarnings);
  const family = args.key ? keyFamilyOf(args.key, aliasMap) : undefined;

  try {
    await warmRecallValues(session, args, embeddings, family);
  } catch (err) {
    warnings.push(`warm-up failed — scores may differ from recall: ${err instanceof Error ? err.message : String(err)}`);
  }

  const sigmas = buildFilterSigmas(args, family);
  const canon = canonicalReadStages({
    evaluationInstant: now,
    keyCardinality,
    keyAliases: aliasMap,
    evidencePoolingRule: MCP_EVIDENCE_POOLING_RULE,
  });
  const ranker = buildRecallRanker(args, embeddings.rankFn);
  const clock = { evaluationClock: now };

  // Re-derive stage-by-stage (recall() untouched). canon = [τ_valid, ⊕_dedupe, ⊥/resolve, drop].
  const afterSigma = session.mneme.query<AlgebraCorpus>(args.corpus, pipe(leaf(args.corpus), ...sigmas), clock);
  const afterTau = session.mneme.query<AlgebraCorpus>(args.corpus, pipe(leaf(args.corpus), ...sigmas, canon[0]), clock);
  const afterDedupe = session.mneme.query<AlgebraCorpus>(args.corpus, pipe(leaf(args.corpus), ...sigmas, canon[0], canon[1]), clock);
  const afterDrop = session.mneme.query<AlgebraCorpus>(args.corpus, pipe(leaf(args.corpus), ...sigmas, canon[0], canon[1], canon[2], canon[3]), clock);
  const ranked = session.mneme.query<RankedCorpus>(args.corpus, pipe(leaf(args.corpus), ...sigmas, ...canon, ranker), clock);

  const idSet = (c: { claims: readonly Claim[] }) => new Set(c.claims.map((cl) => cl.id));
  const tauIds = idSet(afterTau);
  const dedupeIds = idSet(afterDedupe);
  const dropIds = idSet(afterDrop);

  // merged-into: run the identical dedupe to recover which survivor absorbed each merged claim.
  let mergedInto = new Map<string, string>();
  try {
    mergedInto = dedupeGroups(DEDUPE_DEFAULTS.rule, undefined, {
      similarity: { fn: DEDUPE_DEFAULTS.fn, cutoff: DEDUPE_DEFAULTS.cutoff },
    })(afterTau).mergedInto;
  } catch (err) {
    warnings.push(`merge attribution failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // deprecated-by: same ⊥ opts as canon[2]. resolveDeprecateOlder deprecates the OLDER
  // (smaller valid.from) member of each value-difference pair; ties survive (flagged), not deprecated.
  // A claim can lose several pairs → attribute to the NEWEST winner (max valid.from; id-asc tie-break).
  const deprecatedBy = new Map<string, string>();
  try {
    const byId = new Map<string, Claim>();
    for (const cl of afterDedupe.claims) byId.set(cl.id, cl);
    const pairs = pairsOf(afterDedupe, 0, {
      keyCardinality,
      keyAliases: aliasMap,
      evidencePoolingRule: MCP_EVIDENCE_POOLING_RULE,
    });
    for (const p of pairs) {
      if (p.left.valid.from === p.right.valid.from) continue; // tie → not deprecated
      const older = p.left.valid.from < p.right.valid.from ? p.left : p.right;
      const newer = p.left.valid.from < p.right.valid.from ? p.right : p.left;
      const cur = deprecatedBy.get(older.id);
      if (cur === undefined) { deprecatedBy.set(older.id, newer.id); continue; }
      const curClaim = byId.get(cur);
      const curFrom = curClaim ? curClaim.valid.from : -Infinity;
      if (newer.valid.from > curFrom || (newer.valid.from === curFrom && newer.id < cur)) {
        deprecatedBy.set(older.id, newer.id);
      }
    }
  } catch (err) {
    warnings.push(`deprecation attribution failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Ranking + knobs (identical to recall).
  const scoreById = new Map<string, number>();
  for (const s of ranked.scored) scoreById.set(s.claim.id, s.score);
  const topScore = ranked.scored[0]?.score;

  const abstainThreshold = args.abstainBelowTop ?? 0;
  const floorThreshold = args.relevanceFloor ?? 0;
  const afterAbstain = abstainBelowTop(abstainThreshold)(ranked);
  const abstained = ranked.scored.length > 0 && afterAbstain.scored.length === 0 && abstainThreshold > 0;
  const knobbed = relevanceFloor(floorThreshold)(afterAbstain);

  const knobbedIds = new Set(knobbed.scored.map((s) => s.claim.id));
  const rankIndex = new Map<string, number>();
  knobbed.scored.forEach((s, i) => rankIndex.set(s.claim.id, i));
  const servedIds = new Set(knobbed.scored.slice(0, limit).map((s) => s.claim.id));

  // Attribute each candidate to the FIRST stage it exited at (sequential pipeline → one disposition each).
  const claims: ClaimDisposition[] = afterSigma.claims.map((cl) => {
    const base = { id: cl.id, subject: cl.subject, key: cl.key };
    if (!tauIds.has(cl.id)) return { ...base, disposition: "dropped", reason: { kind: "tau-invalid" } };
    if (!dedupeIds.has(cl.id)) {
      return { ...base, disposition: "merged", reason: { kind: "merged-into", targetId: mergedInto.get(cl.id) ?? "" } };
    }
    if (!dropIds.has(cl.id)) {
      if (isKeyAliasShaped(cl) || cl.key === CONTRADICTION_FLAG_KEY) {
        return { ...base, disposition: "dropped", reason: { kind: "alias-or-flag" } };
      }
      return { ...base, disposition: "deprecated", reason: { kind: "deprecated-by", byId: deprecatedBy.get(cl.id) ?? "", via: "single-cardinality" } };
    }
    // reached ranking
    const score = scoreById.get(cl.id);
    if (abstained) return { ...base, disposition: "dropped", reason: { kind: "abstained", topScore: topScore ?? 0, threshold: abstainThreshold }, score };
    if (!knobbedIds.has(cl.id)) return { ...base, disposition: "dropped", reason: { kind: "below-floor", score: score ?? 0, floor: floorThreshold }, score };
    if (!servedIds.has(cl.id)) return { ...base, disposition: "dropped", reason: { kind: "over-limit", rank: rankIndex.get(cl.id) ?? -1, limit }, score };
    return { ...base, disposition: "served", reason: { kind: "served" }, score };
  });

  return {
    corpus: args.corpus,
    candidateCount: afterSigma.claims.length,
    stageCounts: {
      afterTau: afterTau.claims.length,
      afterDedupe: afterDedupe.claims.length,
      afterContradiction: afterDrop.claims.length,
      ranked: ranked.scored.length,
      afterKnobs: knobbed.scored.length,
      served: Math.min(knobbed.scored.length, limit),
    },
    claims,
    warnings: warnings.length ? warnings : undefined,
  };
}
```

- [ ] **Step 4: Run the consistency test to verify it passes**

Run: `npx vitest run src/surface/explain.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the reproduction tests (the cases we hit live)**

Append to `src/surface/explain.test.ts`. Use the same write helper; set `valid.from` explicitly per claim (the write/remember helper accepts a validFrom/asOf — match how recall.test.ts sets claim timing).

```ts
describe("explainRecall — dispositions", () => {
  it("single-cardinality (subject,key) with 3 increasing-validFrom distinct values → 2 deprecated-by + 1 served", async () => {
    // key defaults to single cardinality; 3 DISTINCT, non-token-similar values so ⊕_dedupe does NOT merge them.
    // write v1@t=1, v2@t=2, v3@t=3 on (s, status); deps with no keyCardinality override.
    const t = await explainRecall(session, { about: "status", corpus: "c", subject: "s", key: "status", limit: 5 }, deps);
    const deprecated = t.claims.filter((d) => d.disposition === "deprecated");
    const served = t.claims.filter((d) => d.disposition === "served");
    expect(deprecated).toHaveLength(2);
    expect(served).toHaveLength(1);
    for (const d of deprecated) {
      expect(d.reason).toMatchObject({ kind: "deprecated-by", via: "single-cardinality" });
      expect((d.reason as { byId: string }).byId).toBeTruthy();
    }
  });

  it("same three values but key declared multi → all 3 served, zero deprecations", async () => {
    const multiDeps = { ...deps, keyCardinality: { status: "multi" as const } };
    const t = await explainRecall(session, { about: "status", corpus: "c", subject: "s", key: "status", limit: 5 }, multiDeps);
    expect(t.claims.filter((d) => d.disposition === "deprecated")).toHaveLength(0);
    expect(t.claims.filter((d) => d.disposition === "served")).toHaveLength(3);
  });

  it("two token-similar values (jaccard ≥ 0.5) → one merged-into the other", async () => {
    // write "deploy the web api" and "deploy the web api now" on (s2, note)
    const t = await explainRecall(session, { about: "deploy", corpus: "c", subject: "s2", key: "note", limit: 5 }, deps);
    const merged = t.claims.filter((d) => d.disposition === "merged");
    expect(merged).toHaveLength(1);
    expect((merged[0].reason as { kind: string; targetId: string }).kind).toBe("merged-into");
    expect((merged[0].reason as { targetId: string }).targetId).toBeTruthy();
  });

  it("a future-dated claim → tau-invalid", async () => {
    // write a claim with valid.from far in the future on (s3, k); asOf = now.
    const t = await explainRecall(session, { about: "future", corpus: "c", subject: "s3", key: "k", limit: 5 }, deps);
    expect(t.claims.some((d) => d.reason.kind === "tau-invalid")).toBe(true);
  });

  it("candidates past limit → over-limit", async () => {
    // write 3 distinct MULTI-cardinality claims on (s4, tag) so all survive to ranking; limit 1.
    const multiDeps = { ...deps, keyCardinality: { tag: "multi" as const } };
    const t = await explainRecall(session, { about: "tag", corpus: "c", subject: "s4", key: "tag", limit: 1 }, multiDeps);
    expect(t.claims.filter((d) => d.disposition === "served")).toHaveLength(1);
    expect(t.claims.some((d) => d.reason.kind === "over-limit")).toBe(true);
  });

  it("unknown corpus → empty trace, no throw", async () => {
    const t = await explainRecall(session, { about: "x", corpus: "does-not-exist", limit: 5 }, deps);
    expect(t.candidateCount).toBe(0);
    expect(t.claims).toEqual([]);
  });
});
```

- [ ] **Step 6: Run explain tests + full suite + typecheck**

Run: `npx vitest run src/surface/explain.test.ts` → PASS.
Run: `npx vitest run && npx tsc --noEmit` → all green (1855 + new tests).

Note: if a reproduction assertion is off because the shared write helper sets `valid.from` differently than assumed, adjust the *test's* claim setup (not the production code) until the disposition matches the real pipeline — the consistency test in Step 1 is the source of truth for correctness.

- [ ] **Step 7: Commit**

```bash
git add src/surface/explain.ts src/surface/explain.test.ts
git commit -m "feat(surface): explainRecall — re-derived per-claim recall trace"
```

---

### Task 4: Export `explainRecall` + trace types

**Files:**
- Modify: `src/surface/index.ts` (the `mneme/surface` entry)
- Modify: `src/index.ts` (the root `mneme` entry)

**Interfaces:**
- Consumes: `explainRecall`, `RecallTrace`, `ClaimDisposition`, `DispositionReason` (Task 3).
- Produces: both entries re-export the value + the three types.

- [ ] **Step 1: Add exports to `src/surface/index.ts`**

Append after the existing `recall`/`keyCensus` export block:

```ts
export { explainRecall } from "./explain.js";
export type { RecallTrace, ClaimDisposition, DispositionReason } from "./explain.js";
```

- [ ] **Step 2: Add exports to the root barrel `src/index.ts`**

Add next to the existing `export { recall, keyCensus } from "./surface/recall.js";` line (import from `./surface/explain.js` DIRECTLY — the root barrel imports surface modules directly, not via `./surface/index.js`, to avoid the index↔surface cycle):

```ts
export { explainRecall } from "./surface/explain.js";
export type { RecallTrace, ClaimDisposition, DispositionReason } from "./surface/explain.js";
```

- [ ] **Step 3: Write a back-compat/export smoke test**

Add to `src/surface/index.test.ts` (or wherever surface barrel exports are asserted — mirror the existing pattern that checks `recall` is exported):

```ts
it("exports explainRecall from the surface barrel", async () => {
  const mod = await import("./index.js");
  expect(typeof mod.explainRecall).toBe("function");
});
```

- [ ] **Step 4: Run + typecheck + layering test**

Run: `npx vitest run src/surface/index.test.ts src/surface/layering.test.ts && npx tsc --noEmit`
Expected: PASS (explain.ts imports no `src/mcp`; layering clean).

- [ ] **Step 5: Commit**

```bash
git add src/surface/index.ts src/index.ts src/surface/index.test.ts
git commit -m "feat(surface): export explainRecall + trace types from surface and root barrels"
```

---

### Task 5: MCP `recall` tool — opt-in `explain` flag

**Files:**
- Modify: `src/mcp/server.ts` (recall tool: input `explain?`, output `trace?`, handler branch)
- Test: `src/mcp/server.integration.test.ts` (add explain-path cases; mirror existing recall integration setup)

**Interfaces:**
- Consumes: `explainRecall` (value) + `RecallTrace` (type) from `../surface/index.js`. Change the existing import line to:
  ```ts
  import { remember, recall, listCorpora, keyCensus, explainRecall, type RecallTrace } from "../surface/index.js";
  ```
  `embeddings` and `keyCardinality` are ALREADY in scope in the recall handler (`const embeddings = await initEmbeddings();` at server.ts:168; `keyCardinality` from `openMnemeEngine`) — reuse them, do not re-fetch.
- Produces: the `recall` tool returns `structuredContent.trace` iff `explain === true`; absent/false → byte-identical to today.

- [ ] **Step 1: Write the failing integration test**

In `src/mcp/server.integration.test.ts`, add (mirror how existing tests call the recall tool handler and read `structuredContent`):

```ts
it("recall with explain:true returns a trace; without it, no trace", async () => {
  // ...write a couple of claims to the default corpus via the remember tool...
  const withoutExplain = await callTool("recall", { about: "deploy" });
  expect(withoutExplain.structuredContent.trace).toBeUndefined();

  const withExplain = await callTool("recall", { about: "deploy", explain: true });
  expect(withExplain.structuredContent.trace).toBeDefined();
  expect(withExplain.structuredContent.trace.stageCounts).toBeDefined();
  // explain never changes the served result:
  expect(withExplain.structuredContent.matches.map((m: { id: string }) => m.id))
    .toEqual(withoutExplain.structuredContent.matches.map((m: { id: string }) => m.id));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/mcp/server.integration.test.ts -t explain`
Expected: FAIL — `trace` is undefined when `explain:true`.

- [ ] **Step 3: Add `explain` to the recall tool input schema**

In `src/mcp/server.ts`, inside the recall tool `inputSchema` object, add:

```ts
        explain: z
          .boolean()
          .optional()
          .describe("when true, also return a RecallTrace explaining why each candidate claim was served/merged/deprecated/dropped; best-effort, never changes the served result (default false)"),
```

- [ ] **Step 4: Add `trace` to the output schema**

In the recall tool `outputSchema`, add (kept permissive — the trace is an observability payload, not a stable machine contract):

```ts
        trace: z
          .any()
          .optional()
          .describe("RecallTrace: per-stage counts + per-claim dispositions; present only when explain=true and re-derivation succeeded"),
```

- [ ] **Step 5: Branch the handler**

In the recall tool handler, AFTER the existing `const r = await recall(...)` call and BEFORE building `structuredContent`, add:

```ts
      let trace: RecallTrace | undefined;
      if (a.explain) {
        try {
          trace = await explainRecall(session, {
            about: a.about, subject: a.subject, key: a.key, maxTokens: a.maxTokens,
            limit: a.limit, corpus: resolvedCorpus, abstainBelowTop: a.abstainBelowTop,
            relevanceFloor: a.relevanceFloor, recencyAlpha: a.recencyAlpha,
            recencyHalfLifeDays: a.recencyHalfLifeDays, asOf: a.asOf,
          }, { embeddings, keyCardinality });
        } catch (err) {
          // Best-effort: an explain failure never fails the recall.
          console.error(`[mneme/recall] explain failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
```

Then add `trace,` to the `structuredContent` object literal (it is `undefined` when not requested/failed, so the shape is unchanged for the fast path).

- [ ] **Step 6: Run the integration test + full suite + typecheck**

Run: `npx vitest run src/mcp && npx tsc --noEmit`
Expected: PASS, including `src/mcp/backcompat.test.ts` (no-explain shape unchanged).

- [ ] **Step 7: Commit**

```bash
git add src/mcp/server.ts src/mcp/server.integration.test.ts
git commit -m "feat(mcp): opt-in explain flag on recall tool (best-effort trace)"
```

---

### Task 6: CLI `mneme explain` command

**Files:**
- Modify: `src/cli/main.ts` (register `explain` command; wire `initEmbeddings` + `explainRecall`; pretty-print)
- Test: `src/cli/main.test.ts` (add an `explain` case; mirror existing CLI test harness)

**Interfaces:**
- Consumes: `openSession`, `importFile`, `formatQueryResult` (already imported from `../surface/index.js`); `explainRecall` from `../surface/index.js`; `initEmbeddings` from `../surface/embeddings.js` (its actual home — it is NOT re-exported by the surface barrel).
- Produces: `mneme explain <about> [--subject --key --corpus]` prints per-stage counts and a disposition table; exit 0 on success, 1 on missing `<about>`.

- [ ] **Step 1: Write the failing CLI test**

In `src/cli/main.test.ts`, add (mirror how existing tests invoke `run([...])` and capture stdout — reuse the file's console-capture helper; seed a claim first via `run(["commit", corpus, "--subject", ...])` or the file's existing seed helper):

```ts
it("explain prints stage counts and dispositions", async () => {
  // ...seed one claim into corpus "c" using the file's existing write path...
  const { stdout, code } = await captureRun(["explain", "deploy", "--corpus", "c"]);
  expect(code).toBe(0);
  expect(stdout).toMatch(/served|candidates|afterTau/i);
});

it("explain without <about> exits 1", async () => {
  const { code } = await captureRun(["explain"]);
  expect(code).toBe(1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/cli/main.test.ts -t explain`
Expected: FAIL — `unknown command: explain`.

- [ ] **Step 3: Register the command**

In `src/cli/main.ts`:
- Add `"explain"` to the `knownCommands` array.
- Add `corpus: { type: "string" }` to the `parseArgs` options (subject/key already present).
- Add an early positional check before opening the session:

```ts
  if (cmd === "explain" && !sub) {
    console.error("explain requires <about> (free-text query)");
    return 1;
  }
```

- Update the imports (initEmbeddings comes from `embeddings.js`, NOT the barrel):
  ```ts
  import { openSession, importFile, formatQueryResult, explainRecall } from "../surface/index.js";
  import { initEmbeddings } from "../surface/embeddings.js";
  ```

- [ ] **Step 4: Implement the handler**

Add a `case "explain":` in the `switch (cmd)` block:

```ts
      case "explain": {
        // sub = about; rest joins any trailing tokens into the free-text query.
        const about = [sub, ...rest].join(" ");
        const embeddings = await initEmbeddings();
        const corpus = typeof values.corpus === "string" ? values.corpus : session.listCorpora()[0]?.id;
        if (!corpus) { console.error("no corpus available; pass --corpus <id>"); return 1; }
        const trace = await explainRecall(
          session,
          { about, corpus, subject: values.subject as string | undefined, key: values.key as string | undefined },
          { embeddings },
        );
        if (values.json) { console.log(JSON.stringify(trace)); return 0; }
        const sc = trace.stageCounts;
        console.log(`corpus ${trace.corpus} — ${trace.candidateCount} candidates`);
        console.log(`stages: τ=${sc.afterTau} dedupe=${sc.afterDedupe} ⊥=${sc.afterContradiction} ranked=${sc.ranked} knobs=${sc.afterKnobs} served=${sc.served}`);
        for (const d of trace.claims) {
          const why = d.reason.kind + ("targetId" in d.reason ? `→${d.reason.targetId}` : "byId" in d.reason ? `←${d.reason.byId}` : "");
          console.log(`  [${d.disposition}] ${d.subject} ${d.key} — ${why}${d.score !== undefined ? ` (score ${d.score.toFixed(2)})` : ""}`);
        }
        if (trace.warnings) for (const w of trace.warnings) console.error(`warning: ${w}`);
        return 0;
      }
```

- Update `USAGE` to list `explain <about> [--subject --key --corpus]`.

- [ ] **Step 5: Run CLI tests + full suite + typecheck**

Run: `npx vitest run src/cli && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/main.ts src/cli/main.test.ts
git commit -m "feat(cli): mneme explain — pretty-print a recall trace"
```

---

## Final verification

- [ ] `npx vitest run` — full suite green (1855 prior + new explain/dedupeGroups/mcp/cli tests).
- [ ] `npx tsc --noEmit` — clean.
- [ ] `src/surface/layering.test.ts` + `src/mcp/backcompat.test.ts` — green (layering + no-explain shape preserved).
- [ ] Manual smoke: `npm run mneme -- explain "deploy" --corpus <a-real-corpus>` prints a trace.
```
