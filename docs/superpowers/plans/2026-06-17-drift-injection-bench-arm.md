# Drift-Injection Benchmark Arm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quantify the key-matching wedge by injecting controlled key drift into the oracle LongMemEval claims-file and measuring the `updateCorrect` gap between arm A run with vs. without a ground-truth alias map.

**Architecture:** A pure, deterministic injector (`drift-injector.ts`) rewrites a seeded fraction of claim keys to variant keys (morph templates or real judged-pair vocabulary) and returns the drifted claims plus the exact `variant→canonical` oracle map. A sweep driver (`drift-injection-sweep.ts`) loops a fraction×mode×aliased grid — one fresh tmp DB per (fraction, mode) because drift changes the ingested data — gates the zero-drift baseline against the recorded oracle value (0.403), and emits a dose-response table.

**Tech Stack:** TypeScript, `tsx`, `vitest`, `better-sqlite3` (via the existing Mneme session surface). Bench-only; no production code is modified.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-17-drift-injection-bench-arm-design.md` — every task's requirements implicitly include it.
- **No modification** to `bench/longmemeval/run.ts`, `answer.ts`, `score.ts`, `ingest.ts`, `types.ts`, or any `src/` file.
- **Determinism:** the injector uses NO `Math.random`, NO `Date`/clock — selection is a pure hash of `seed + claim identity`.
- **Knobs OFF:** every `answerArmA` call passes `abstainBelowTop: 0`, `relevanceFloor: 0` (defaults, but the driver is explicit).
- **Ranker:** jaccard only (`rankFn` left default).
- **Multi-key exclusion:** keys with `MANUAL_KEY_CARDINALITY[key] === "multi"` (from `bench/longmemeval/run.ts:71`) are never drifted.
- **Recorded baseline:** oracle KU `updateCorrect = 0.403` (3-decimal rounding via `r3 = v => Math.round(v*1000)/1000`).
- **File locations:** all new files under `bench/longmemeval/manual/`.
- **Test runner:** `npx vitest run <path>` (single file), per existing bench tests.

---

### Task 1: Morph-mode injector core

**Files:**
- Create: `bench/longmemeval/manual/drift-injector.ts`
- Test: `bench/longmemeval/manual/drift-injector.test.ts`

**Interfaces:**
- Consumes: `ClaimRecordT` from `bench/longmemeval/types.ts` (`{ subject: string; key: string; value: string; validFrom: number; confidence?: number; tags: string[] }`); `KeyAliasMap` (= `Record<string,string>`) from `src/index.ts`.
- Produces:
  - `type DriftMode = "judged" | "morph"`
  - `interface DriftOpts { mode: DriftMode; fraction: number; seed: string; multiKeys: Record<string, "single" | "multi">; judgedVocab?: CanonicalGroups }`
  - `type CanonicalGroups = Map<string, string[]>` (canonical key → variant keys; defined here, populated in Task 2)
  - `interface DriftResult { claims: ClaimRecordT[]; aliasMap: KeyAliasMap; coverage: { eligibleKeys: number; driftedKeys: number; noVariantKeys: number } }`
  - `function injectDrift(claims: ClaimRecordT[], opts: DriftOpts): DriftResult`
  - `function hashStr(s: string): number` (deterministic 32-bit FNV-1a)
  - `function morphVariants(key: string): string[]`

- [ ] **Step 1: Write the failing test**

Create `bench/longmemeval/manual/drift-injector.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { injectDrift, morphVariants, hashStr, type DriftOpts } from "./drift-injector.js";
import type { ClaimRecordT } from "../types.js";

const SINGLE = { employer: "single", city: "single", hobby: "multi" } as Record<string, "single" | "multi">;

function rec(subject: string, key: string, value: string, validFrom: number): ClaimRecordT {
  return { subject, key, value, validFrom, tags: [`session:s-${validFrom}`, "turn:0"] };
}

// A superseding lineage (same subject+key, two times) plus a multi-key claim.
const CLAIMS: ClaimRecordT[] = [
  rec("alice", "employer", "Initech", 1000),
  rec("alice", "employer", "Globex", 2000),
  rec("alice", "city", "Denver", 1500),
  rec("alice", "hobby", "sushi", 1500),
];

const baseOpts = (over: Partial<DriftOpts> = {}): DriftOpts => ({
  mode: "morph", fraction: 0.5, seed: "t", multiKeys: SINGLE, ...over,
});

describe("hashStr", () => {
  it("is deterministic and order-free", () => {
    expect(hashStr("abc")).toBe(hashStr("abc"));
    expect(hashStr("abc")).not.toBe(hashStr("abd"));
  });
});

describe("morphVariants", () => {
  it("returns >= 2 distinct variants, none equal to the key", () => {
    const vs = morphVariants("employer");
    expect(new Set(vs).size).toBeGreaterThanOrEqual(2);
    expect(vs).not.toContain("employer");
  });
});

describe("injectDrift morph", () => {
  it("is a true no-op at fraction 0", () => {
    const r = injectDrift(CLAIMS, baseOpts({ fraction: 0 }));
    expect(r.claims).toEqual(CLAIMS);
    expect(r.aliasMap).toEqual({});
  });

  it("is deterministic for the same seed/fraction", () => {
    const a = injectDrift(CLAIMS, baseOpts());
    const b = injectDrift(CLAIMS, baseOpts());
    expect(b.claims).toEqual(a.claims);
    expect(b.aliasMap).toEqual(a.aliasMap);
  });

  it("never drifts a multi-value key", () => {
    const r = injectDrift(CLAIMS, baseOpts({ fraction: 1 }));
    const hobby = r.claims.find((c) => c.value === "sushi")!;
    expect(hobby.key).toBe("hobby");
  });

  it("preserves all non-key fields", () => {
    const r = injectDrift(CLAIMS, baseOpts({ fraction: 1 }));
    const initech = r.claims.find((c) => c.value === "Initech")!;
    expect(initech.subject).toBe("alice");
    expect(initech.validFrom).toBe(1000);
    expect(initech.tags).toEqual(["session:s-1000", "turn:0"]);
  });

  it("alias map is exact: every drifted key maps to its canonical, no canonical is a map key", () => {
    const r = injectDrift(CLAIMS, baseOpts({ fraction: 1 }));
    for (const [variant, canonical] of Object.entries(r.aliasMap)) {
      expect(["employer", "city"]).toContain(canonical);
      expect(r.aliasMap[canonical]).toBeUndefined();
    }
    // every claim whose key differs from its canonical must be in the map
    for (const c of r.claims) {
      if (c.value === "Initech" || c.value === "Globex") {
        if (c.key !== "employer") expect(r.aliasMap[c.key]).toBe("employer");
      }
    }
  });

  it("fragments a lineage at fraction 1 (employer lineage spans >= 2 distinct keys)", () => {
    const r = injectDrift(CLAIMS, baseOpts({ fraction: 1 }));
    const empKeys = new Set(
      r.claims.filter((c) => c.value === "Initech" || c.value === "Globex").map((c) => c.key),
    );
    expect(empKeys.size).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run bench/longmemeval/manual/drift-injector.test.ts`
Expected: FAIL — `Cannot find module './drift-injector.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `bench/longmemeval/manual/drift-injector.ts`:

```ts
/**
 * Drift-injection for the key-matching wedge benchmark (bench-only).
 *
 * Pure + deterministic: rewrites a seeded fraction of single-value claim keys
 * to VARIANT keys, fragmenting superseding lineages across keys so that
 * (without an alias map) drifted claims never contest. Returns the drifted
 * claims plus the exact variant→canonical oracle map.
 *
 * Spec: docs/superpowers/specs/2026-06-17-drift-injection-bench-arm-design.md
 */
import type { ClaimRecordT } from "../types.js";
import type { KeyAliasMap } from "../../../src/index.js";

export type DriftMode = "judged" | "morph";

/** canonical key → its variant keys (>= 1). Built in drift-injector judged mode (Task 2). */
export type CanonicalGroups = Map<string, string[]>;

export interface DriftOpts {
  mode: DriftMode;
  fraction: number;
  seed: string;
  multiKeys: Record<string, "single" | "multi">;
  judgedVocab?: CanonicalGroups;
}

export interface DriftResult {
  claims: ClaimRecordT[];
  aliasMap: KeyAliasMap;
  coverage: { eligibleKeys: number; driftedKeys: number; noVariantKeys: number };
}

/** Deterministic 32-bit FNV-1a string hash (no clock, no randomness). */
export function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const MORPH_PREFIXES = ["preferred_", "current_", "primary_"];
const MORPH_SUFFIXES = ["_current", "_now"];

/** >= 2 distinct variants, none equal to the input key. */
export function morphVariants(key: string): string[] {
  const out = new Set<string>();
  for (const p of MORPH_PREFIXES) out.add(p + key);
  for (const s of MORPH_SUFFIXES) out.add(key + s);
  out.delete(key);
  return [...out];
}

const identity = (c: ClaimRecordT): string =>
  `${c.subject}|${c.key}|${c.validFrom}|${c.value}`;

/** Fraction gate: deterministic per claim. */
function drifts(c: ClaimRecordT, seed: string, fraction: number): boolean {
  if (fraction <= 0) return false;
  if (fraction >= 1) return true;
  return (hashStr(seed + "|sel|" + identity(c)) % 1_000_000) / 1_000_000 < fraction;
}

/** Pick a variant deterministically from a non-empty set. */
function pickVariant(c: ClaimRecordT, seed: string, variants: string[]): string {
  return variants[hashStr(seed + "|var|" + identity(c)) % variants.length];
}

export function injectDrift(claims: ClaimRecordT[], opts: DriftOpts): DriftResult {
  const aliasMap: KeyAliasMap = {};
  const eligibleKeys = new Set<string>();
  const driftedKeys = new Set<string>();
  const noVariantKeys = new Set<string>();

  const out = claims.map((c) => {
    if (opts.multiKeys[c.key] === "multi") return c;

    // Determine canonical + variant set for this claim's key.
    let canonical: string;
    let variants: string[];
    if (opts.mode === "morph") {
      canonical = c.key;
      variants = morphVariants(c.key);
    } else {
      // judged: only keys that are a canonical-with-variants in the vocab are eligible.
      const vocab = opts.judgedVocab;
      const vs = vocab?.get(c.key);
      if (!vs || vs.length === 0) {
        if (vocab && vocab.has(c.key)) noVariantKeys.add(c.key);
        return c;
      }
      canonical = c.key;
      variants = vs;
    }

    eligibleKeys.add(canonical);
    if (!drifts(c, opts.seed, opts.fraction)) return c;

    const variant = pickVariant(c, opts.seed, variants);
    aliasMap[variant] = canonical;
    driftedKeys.add(variant);
    return { ...c, key: variant };
  });

  return {
    claims: out,
    aliasMap,
    coverage: {
      eligibleKeys: eligibleKeys.size,
      driftedKeys: driftedKeys.size,
      noVariantKeys: noVariantKeys.size,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run bench/longmemeval/manual/drift-injector.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit** *(held — see "Commit policy" at end of plan; run only when the user releases the hold)*

```bash
git add bench/longmemeval/manual/drift-injector.ts bench/longmemeval/manual/drift-injector.test.ts
git commit -m "feat(bench): morph-mode drift injector for key-matching wedge arm"
```

---

### Task 2: Judged-mode vocabulary + injection

**Files:**
- Modify: `bench/longmemeval/manual/drift-injector.ts` (add `buildJudgedVocab`)
- Test: `bench/longmemeval/manual/drift-injector.test.ts` (add a `buildJudgedVocab` describe block)

**Interfaces:**
- Consumes: `loadRatifiedPairs(path: string): Set<string>` and `pairKey(a: string, b: string): string` and `autoRatify(keyCounts: Map<string, number>, scoreOne: (a: string, b: string) => number, theta: number): { map: KeyAliasMap; stats: {...} }` — all from `bench/longmemeval/manual/key-alias-auto.ts`.
- Produces: `function buildJudgedVocab(claims: ClaimRecordT[], judgmentsPath: string): CanonicalGroups`

- [ ] **Step 1: Write the failing test**

Add to `bench/longmemeval/manual/drift-injector.test.ts`:

```ts
import { buildJudgedVocab } from "./drift-injector.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("buildJudgedVocab", () => {
  // judged-pairs file: header line + symmetric {a,b,same} judgments.
  function writeJudgments(lines: object[]): string {
    const dir = mkdtempSync(join(tmpdir(), "drift-judge-"));
    const path = join(dir, "judgments.jsonl");
    const body = [
      { kind: "key-ratify-header", model: "claude-sonnet-4-6", promptVersion: "ratify-v1" },
      ...lines,
    ]
      .map((o) => JSON.stringify(o))
      .join("\n");
    writeFileSync(path, body, "utf-8");
    return path;
  }

  const claims: ClaimRecordT[] = [
    { subject: "u", key: "employer", value: "A", validFrom: 1, tags: ["session:s1", "turn:0"] },
    { subject: "u", key: "employer", value: "B", validFrom: 2, tags: ["session:s2", "turn:0"] },
    { subject: "u", key: "current_employer", value: "C", validFrom: 3, tags: ["session:s3", "turn:0"] },
    { subject: "u", key: "city", value: "Denver", validFrom: 1, tags: ["session:s1", "turn:0"] },
  ];

  it("groups a same:true pair; canonical = most claims; variant is the other member", () => {
    const path = writeJudgments([
      { a: "employer", b: "current_employer", same: true, score: 0.95 },
    ]);
    const vocab = buildJudgedVocab(claims, path);
    // employer (2 claims) > current_employer (1) → canonical employer, variant current_employer
    expect(vocab.get("employer")).toEqual(["current_employer"]);
    expect(vocab.has("current_employer")).toBe(false);
  });

  it("ignores same:false pairs and keys absent from the claims-file", () => {
    const path = writeJudgments([
      { a: "employer", b: "current_employer", same: false, score: 0.4 },
      { a: "city", b: "hometown", same: true, score: 0.9 }, // hometown not in claims
    ]);
    const vocab = buildJudgedVocab(claims, path);
    expect(vocab.has("employer")).toBe(false); // same:false → not grouped
    // city↔hometown: hometown has 0 claims; canonical=city, variant hometown retained
    // (hometown is a valid variant target even with no own claims)
    expect(vocab.get("city")).toEqual(["hometown"]);
  });

  it("judged injection only drifts canonical-with-variant keys", () => {
    const path = writeJudgments([
      { a: "employer", b: "current_employer", same: true, score: 0.95 },
    ]);
    const vocab = buildJudgedVocab(claims, path);
    const r = injectDrift(claims, {
      mode: "judged", fraction: 1, seed: "t",
      multiKeys: {}, judgedVocab: vocab,
    });
    // city has no judged variant → untouched
    expect(r.claims.find((c) => c.value === "Denver")!.key).toBe("city");
    // employer claims drift to current_employer (the only variant)
    const a = r.claims.find((c) => c.value === "A")!;
    expect(a.key).toBe("current_employer");
    expect(r.aliasMap["current_employer"]).toBe("employer");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run bench/longmemeval/manual/drift-injector.test.ts`
Expected: FAIL — `buildJudgedVocab` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `bench/longmemeval/manual/drift-injector.ts` (imports at top, function at bottom):

```ts
import { loadRatifiedPairs, pairKey, autoRatify } from "./key-alias-auto.js";
```

```ts
/**
 * Build canonical→[variants] from the committed judged-pairs JSONL by reusing
 * key-alias-auto's union-find + canonical selection (most-claims, ties
 * lexicographically smallest). A binary scorer (1 iff the pair was judged
 * same:true) with theta=1 turns the symmetric judgments into components.
 * keyCounts spans both the claims-file keys AND any judged keys, so a variant
 * with no own claims is still a valid drift target.
 */
export function buildJudgedVocab(claims: ClaimRecordT[], judgmentsPath: string): CanonicalGroups {
  const approved = loadRatifiedPairs(judgmentsPath);

  const keyCounts = new Map<string, number>();
  for (const c of claims) keyCounts.set(c.key, (keyCounts.get(c.key) ?? 0) + 1);
  // Ensure both endpoints of every approved pair are present as nodes (0 count
  // if they never appear as a claim key) so judged variants aren't dropped.
  for (const pk of approved) {
    for (const k of pk.split("\x1f")) if (!keyCounts.has(k)) keyCounts.set(k, 0);
  }

  const scoreOne = (a: string, b: string): number => (approved.has(pairKey(a, b)) ? 1 : 0);
  const { map } = autoRatify(keyCounts, scoreOne, 1); // map: variant→canonical

  const groups: CanonicalGroups = new Map();
  for (const [variant, canonical] of Object.entries(map)) {
    const vs = groups.get(canonical) ?? [];
    vs.push(variant);
    groups.set(canonical, vs);
  }
  for (const vs of groups.values()) vs.sort();
  return groups;
}
```

Note: the judged-mode `noVariantKeys` counter in `injectDrift` increments only when a claim's key is itself present in `judgedVocab` as a key with an empty variant list — which `buildJudgedVocab` never produces (it only adds canonicals that have ≥1 variant). So `noVariantKeys` stays 0 here; the honest "keys with no judged variant" figure is reported by the driver (Task 4) as `distinctSingleKeys − eligibleKeys`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run bench/longmemeval/manual/drift-injector.test.ts`
Expected: PASS (Task 1 + Task 2 blocks green).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit** *(held)*

```bash
git add bench/longmemeval/manual/drift-injector.ts bench/longmemeval/manual/drift-injector.test.ts
git commit -m "feat(bench): judged-pair drift vocabulary via key-alias-auto reuse"
```

---

### Task 3: Fixture round-trip integration test

**Files:**
- Test: `bench/longmemeval/manual/drift-injection.integration.test.ts`

**Interfaces:**
- Consumes: `injectDrift` (Task 1); `openSession` from `src/surface/index.ts`; `ingestQuestion`, `claimsFor` from `bench/longmemeval/ingest.ts`; `answerArmA` from `bench/longmemeval/answer.ts`; `LmeQuestion`, `ClaimRecord`, `CacheHeader` parsing as used by existing tests; `MANUAL_KEY_CARDINALITY` from `bench/longmemeval/run.ts`.
- Produces: nothing (verification gate only — proves injector composes with arm A).

This task adds NO production code. It proves that drift injected by `injectDrift` flows through `ingestQuestion → answerArmA` and that the oracle alias map recovers the newest value that drift otherwise leaves un-contested.

- [ ] **Step 1: Write the failing test**

Create `bench/longmemeval/manual/drift-injection.integration.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "../../../src/surface/index.js";
import { injectDrift } from "./drift-injector.js";
import { ingestQuestion, claimsFor } from "../ingest.js";
import { answerArmA } from "../answer.js";
import { MANUAL_KEY_CARDINALITY } from "../run.js";
import type { ClaimRecordT, LmeQuestionT } from "../types.js";

// One synthetic KU question: alice's employer Initech → Globex over two sessions.
const Q: LmeQuestionT = {
  question_id: "drift-rt-1",
  question_type: "knowledge-update",
  question: "Where does alice work now?",
  question_date: "2023/07/01 (Sat) 10:00",
  answer: "Globex",
  sessions: [
    { sessionId: "s-old", date: "2023/05/01 (Mon) 10:00" },
    { sessionId: "s-new", date: "2023/06/01 (Thu) 10:00" },
  ],
  answer_session_ids: ["s-old", "s-new"],
} as unknown as LmeQuestionT;

const CLAIMS: ClaimRecordT[] = [
  { subject: "alice", key: "employer", value: "Initech", validFrom: Date.UTC(2023, 4, 1), tags: ["session:s-old", "turn:0"] },
  { subject: "alice", key: "employer", value: "Globex", validFrom: Date.UTC(2023, 5, 1), tags: ["session:s-new", "turn:0"] },
];

function run(aliased: boolean) {
  const { claims, aliasMap } = injectDrift(CLAIMS, {
    mode: "morph", fraction: 1, seed: "rt", multiKeys: MANUAL_KEY_CARDINALITY,
  });
  const dir = mkdtempSync(join(tmpdir(), "drift-rt-"));
  const session = openSession({ dbPath: join(dir, "lme.db"), writer: "drift-rt", source: "imported" });
  try {
    const records = claimsFor(Q, claims, { oracle: true });
    ingestQuestion(session, Q, records);
    const res = answerArmA(session, `lme-${Q.question_id}`, Q, {
      k: 10, keyCardinality: MANUAL_KEY_CARDINALITY,
      abstainBelowTop: 0, relevanceFloor: 0,
      keyAliases: aliased ? aliasMap : undefined,
    });
    return res.claims.map((c) => c.value);
  } finally {
    session.close?.();
  }
}

describe("drift-injection round-trip (fixture)", () => {
  it("WITHOUT alias map: drifted lineage does not fully contest (stale survives)", () => {
    const values = run(false);
    // employer split across variant keys → Initech and Globex both reachable
    expect(values).toContain("Globex");
    expect(values).toContain("Initech");
  });

  it("WITH oracle alias map: newest wins, stale deprecated", () => {
    const values = run(true);
    expect(values).toContain("Globex");
    expect(values).not.toContain("Initech");
  });
});
```

- [ ] **Step 2: Run test to verify it fails or reveals the real interface**

Run: `npx vitest run bench/longmemeval/manual/drift-injection.integration.test.ts`
Expected: FAIL initially. Likely causes to resolve by inspecting `bench/longmemeval/types.ts` and `bench/longmemeval/run.test.ts`:
- `LmeQuestionT` field names / required fields (align the `Q` literal to the real schema; `run.test.ts` builds fixtures — copy its shape).
- `openSession` option names and whether `session.close` exists (check `src/surface/index.ts`; if the existing sweeps don't close, drop the `finally`).

Fix the test literal to match the real types (this is test-only; no production change).

- [ ] **Step 3: Make it pass**

Adjust the `Q`/`CLAIMS` literals and session teardown to the verified signatures until both assertions pass. If `morph` fraction=1 happens to map both employer claims to the *same* variant (so they still contest without aliases), change `seed` to one that splits them (the Task 1 fragmentation test guarantees a splitting seed exists) — or assert on a third claim. Document the chosen seed inline.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run bench/longmemeval/manual/drift-injection.integration.test.ts`
Expected: PASS (both assertions).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit** *(held)*

```bash
git add bench/longmemeval/manual/drift-injection.integration.test.ts
git commit -m "test(bench): drift injector round-trips through arm A with oracle map"
```

---

### Task 4: The sweep driver

**Files:**
- Create: `bench/longmemeval/manual/drift-injection-sweep.ts`
- Test: `bench/longmemeval/manual/drift-injection-sweep.test.ts`

**Interfaces:**
- Consumes: `injectDrift`, `buildJudgedVocab` (Tasks 1–2); `parseArgs` (`node:util`); `readFileSync`, `mkdtempSync` (`node:fs`), `tmpdir` (`node:os`), `join` (`node:path`); `openSession` (`src/surface/index.ts`); `ingestQuestion`, `claimsFor` (`ingest.ts`); `answerArmA` (`answer.ts`); `scoreQuestion`, `aggregate`, `type ScoreRow`, `type QuestionScore` (`score.ts`); `LmeQuestion`, `ClaimRecord`, `CacheHeader`, `categoryOf`, `TARGET_CATEGORIES`, `normalizeQuestion`, `type LmeQuestionT`, `type ClaimRecordT` (`types.ts`); `EXTRACTION_MODEL`, `PROMPT_VERSION` (`convert/longmemeval.ts`); `MANUAL_KEY_CARDINALITY` (`run.ts`). Mirror the exact import set and load discipline of `key-alias-auto`/`key-matching-sweep`.
- Produces: `export async function main(argv: string[], opts?: { onError?: (m: string) => void }): Promise<number>` and a `Cell` row type `{ fraction: number; mode: string; aliased: boolean; rows: ScoreRow[] }`.

- [ ] **Step 1: Write the failing test**

Create `bench/longmemeval/manual/drift-injection-sweep.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { main } from "./drift-injection-sweep.js";

describe("drift-injection-sweep CLI", () => {
  it("errors without --file/--claims", async () => {
    const errs: string[] = [];
    const code = await main([], { onError: (m) => errs.push(m) });
    expect(code).toBe(1);
    expect(errs.join(" ")).toMatch(/--file and --claims are required/);
  });

  it("rejects an out-of-range fraction", async () => {
    const errs: string[] = [];
    const code = await main(
      ["--file", "x.json", "--claims", "y.jsonl", "--fractions", "2.0"],
      { onError: (m) => errs.push(m) },
    );
    expect(code).toBe(1);
    expect(errs.join(" ")).toMatch(/fractions/);
  });

  it("runs the fixture end-to-end and gates the zero-drift baseline", async () => {
    // The fixture KU question scores arm A updateCorrect = 1.0 (run.test.ts:43).
    const code = await main([
      "--file", "bench/longmemeval/fixtures/dataset.json",
      "--claims", "bench/longmemeval/fixtures/claims.jsonl",
      "--fractions", "0,1.0",
      "--modes", "morph",
      "--expect-update-correct", "1.0",
      "--raw",
    ]);
    expect(code).toBe(0);
  });

  it("aborts when the baseline gate value is wrong", async () => {
    const errs: string[] = [];
    const code = await main(
      [
        "--file", "bench/longmemeval/fixtures/dataset.json",
        "--claims", "bench/longmemeval/fixtures/claims.jsonl",
        "--fractions", "0",
        "--modes", "morph",
        "--expect-update-correct", "0.5",
        "--raw",
      ],
      { onError: (m) => errs.push(m) },
    );
    expect(code).toBe(1);
    expect(errs.join(" ")).toMatch(/SANITY GATE FAILED/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run bench/longmemeval/manual/drift-injection-sweep.test.ts`
Expected: FAIL — `Cannot find module './drift-injection-sweep.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `bench/longmemeval/manual/drift-injection-sweep.ts`:

```ts
/**
 * Drift-injection sweep (bench-only). Quantifies the key-matching wedge:
 * injects controlled key drift into the oracle claims-file, runs arm A WITH vs
 * WITHOUT the ground-truth alias map, reports updateCorrect as a dose-response
 * over drift fraction. The zero-drift no-alias cell is gated against the
 * recorded oracle value (--expect-update-correct, default 0.403).
 *
 * Spec: docs/superpowers/specs/2026-06-17-drift-injection-bench-arm-design.md
 *
 *   tsx bench/longmemeval/manual/drift-injection-sweep.ts \
 *     --file bench/datasets/longmemeval/longmemeval_oracle_target.json \
 *     --claims bench/datasets/longmemeval/longmemeval-oracle-claims.jsonl \
 *     [--fractions 0,0.1,0.25,0.5,0.75,1.0] [--modes judged,morph] \
 *     [--seed drift-v1] [--expect-update-correct 0.403] \
 *     [--judgments bench/longmemeval/manual/data/key-ratify-judgments.jsonl] \
 *     [--append-results bench/RESULTS.md]
 */
import { parseArgs } from "node:util";
import { readFileSync, appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "../../../src/surface/index.js";
import { injectDrift, buildJudgedVocab, type CanonicalGroups } from "./drift-injector.js";
import { ingestQuestion, claimsFor } from "../ingest.js";
import { answerArmA } from "../answer.js";
import { scoreQuestion, aggregate, type ScoreRow, type QuestionScore } from "../score.js";
import {
  LmeQuestion, ClaimRecord, CacheHeader, categoryOf, TARGET_CATEGORIES,
  normalizeQuestion, type LmeQuestionT, type ClaimRecordT,
} from "../types.js";
import { EXTRACTION_MODEL, PROMPT_VERSION } from "../../convert/longmemeval.js";
import { MANUAL_KEY_CARDINALITY } from "../run.js";

const KS = [1, 3, 10];
const MAX_K = 10;
const DEFAULT_JUDGMENTS = "bench/longmemeval/manual/data/key-ratify-judgments.jsonl";
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

interface Cell {
  fraction: number;
  mode: string;
  aliased: boolean;
  rows: ScoreRow[];
  coverage?: { eligibleKeys: number; driftedKeys: number; noVariantKeys: number };
}

const kuUpdate = (rows: ScoreRow[]): number | undefined =>
  rows.find((r) => r.category === "knowledge-update" && r.metric === "updateCorrect")?.value;

export async function main(
  argv: string[],
  opts?: { onError?: (m: string) => void },
): Promise<number> {
  const logError = (m: string): void => { console.error(m); opts?.onError?.(m); };

  const { values } = parseArgs({
    args: argv,
    options: {
      file: { type: "string" },
      claims: { type: "string" },
      fractions: { type: "string", default: "0,0.1,0.25,0.5,0.75,1.0" },
      modes: { type: "string", default: "judged,morph" },
      seed: { type: "string", default: "drift-v1" },
      judgments: { type: "string", default: DEFAULT_JUDGMENTS },
      raw: { type: "boolean", default: false },
      "expect-update-correct": { type: "string" },
      "append-results": { type: "string" },
    },
  });

  if (!values.file || !values.claims) { logError("--file and --claims are required"); return 1; }

  const fractions = String(values.fractions).split(",").map((s) => parseFloat(s.trim()));
  if (fractions.some((f) => Number.isNaN(f) || f < 0 || f > 1) || fractions.length === 0) {
    logError("--fractions must be a comma-separated list in [0, 1]"); return 1;
  }
  const modes = String(values.modes).split(",").map((s) => s.trim());
  if (modes.some((m) => m !== "judged" && m !== "morph")) {
    logError(`--modes must be "judged" and/or "morph", got "${values.modes}"`); return 1;
  }
  const expect = values["expect-update-correct"] !== undefined
    ? parseFloat(String(values["expect-update-correct"])) : undefined;

  // --- load dataset + claims (run.ts discipline) ---
  const datasetRaw = JSON.parse(readFileSync(values.file, "utf-8")) as unknown[];
  const questions: LmeQuestionT[] = datasetRaw
    .map((r) => (values.raw ? normalizeQuestion(r) : LmeQuestion.parse(r)))
    .filter((q) => TARGET_CATEGORIES.has(categoryOf(q)));

  const lines = readFileSync(values.claims, "utf-8").split("\n").filter((l) => l.trim().length > 0);
  const header = CacheHeader.parse(JSON.parse(lines[0]));
  if (header.model !== EXTRACTION_MODEL || header.promptVersion !== PROMPT_VERSION) {
    logError(`Claims cache header mismatch: model=${header.model}, promptVersion=${header.promptVersion}`);
    return 1;
  }
  const allClaims: ClaimRecordT[] = lines.slice(1).map((l) => ClaimRecord.parse(JSON.parse(l)));

  // judged vocab built once over the full claims-file.
  const judgedVocab: CanonicalGroups = modes.includes("judged")
    ? buildJudgedVocab(allClaims, String(values.judgments)) : new Map();

  const distinctSingleKeys = new Set(
    allClaims.filter((c) => MANUAL_KEY_CARDINALITY[c.key] !== "multi").map((c) => c.key),
  ).size;

  const cells: Cell[] = [];

  // One fresh tmp DB per (fraction, mode): drift changes the INGESTED data, so
  // arm A cannot reuse a single ingest the way key-matching-sweep does. aliased
  // off/on share the same ingest (both read-only).
  for (const mode of modes) {
    for (const fraction of fractions) {
      // fraction 0 is mode-independent; run it once under the first mode only.
      if (fraction === 0 && mode !== modes[0]) continue;

      const { claims: drifted, aliasMap, coverage } = injectDrift(allClaims, {
        mode: mode as "judged" | "morph", fraction, seed: String(values.seed),
        multiKeys: MANUAL_KEY_CARDINALITY,
        judgedVocab: mode === "judged" ? judgedVocab : undefined,
      });

      const dir = mkdtempSync(join(tmpdir(), "mneme-drift-"));
      const session = openSession({ dbPath: join(dir, "lme.db"), writer: "drift-sweep", source: "imported" });
      try {
        for (const q of questions) {
          ingestQuestion(session, q, claimsFor(q, drifted, { oracle: true }));
        }
        for (const aliased of [false, true]) {
          const scores: QuestionScore[] = [];
          for (const q of questions) {
            const res = answerArmA(session, `lme-${q.question_id}`, q, {
              k: MAX_K, keyCardinality: MANUAL_KEY_CARDINALITY,
              abstainBelowTop: 0, relevanceFloor: 0,
              keyAliases: aliased ? aliasMap : undefined,
            });
            scores.push(scoreQuestion(q, res, KS));
          }
          cells.push({ fraction, mode, aliased, rows: aggregate(scores, KS), coverage });
        }
      } finally {
        session.close?.();
      }

      // --- sanity gate on the zero-drift, no-alias baseline ---
      if (fraction === 0 && expect !== undefined) {
        const base = cells.find((c) => c.fraction === 0 && !c.aliased);
        const v = base ? kuUpdate(base.rows) : undefined;
        if (v === undefined || r3(v) !== r3(expect)) {
          logError(`SANITY GATE FAILED: baseline KU updateCorrect ${v !== undefined ? r3(v) : "missing"} !== expected ${r3(expect)} — broken rig, aborting`);
          return 1;
        }
        console.log(`sanity gate: baseline KU updateCorrect ${r3(v)} matches recorded value ✓`);
      }
    }
  }

  // --- output ---
  const lines2: string[] = [];
  lines2.push("| fraction | mode | aliased | updateCorrect | recall@1 | recall@3 | n |");
  lines2.push("|---|---|---|---|---|---|---|");
  for (const c of cells) {
    const uc = kuUpdate(c.rows);
    const recall = (k: number): number | undefined =>
      c.rows.find((r) => r.category === "knowledge-update" && r.metric === `recall@${k}`)?.value;
    const nRow = c.rows.find((r) => r.category === "knowledge-update" && r.metric === "updateCorrect");
    lines2.push(
      `| ${c.fraction} | ${c.mode} | ${c.aliased ? "on" : "off"} | ` +
      `${uc !== undefined ? r3(uc) : "—"} | ${recall(1) !== undefined ? r3(recall(1)!) : "—"} | ` +
      `${recall(3) !== undefined ? r3(recall(3)!) : "—"} | ${nRow?.n ?? 0} |`,
    );
  }
  const table = lines2.join("\n");
  console.log(table);

  // dose-response dump (per mode: off vs on over the fraction axis)
  for (const mode of modes) {
    console.log(`\ndose-response [${mode}] updateCorrect (off → on):`);
    for (const f of fractions) {
      const off = cells.find((c) => c.mode === (f === 0 ? modes[0] : mode) && c.fraction === f && !c.aliased);
      const on = cells.find((c) => c.mode === (f === 0 ? modes[0] : mode) && c.fraction === f && c.aliased);
      const offv = off ? kuUpdate(off.rows) : undefined;
      const onv = on ? kuUpdate(on.rows) : undefined;
      console.log(`  f=${f}: ${offv !== undefined ? r3(offv) : "—"} → ${onv !== undefined ? r3(onv) : "—"}`);
    }
  }

  // judged coverage line
  if (modes.includes("judged")) {
    const cov = cells.find((c) => c.mode === "judged")?.coverage;
    if (cov) {
      console.log(`\njudged coverage: drifted ${cov.eligibleKeys} of ${distinctSingleKeys} single-value keys (${distinctSingleKeys - cov.eligibleKeys} had no judged variant)`);
    }
  }

  if (values["append-results"]) {
    appendFileSync(String(values["append-results"]), `\n\n## Drift-injection sweep (${new Date().toISOString()})\n\n${table}\n`, "utf-8");
  }

  return 0;
}

// CLI entry (only when run directly).
if (process.argv[1] && process.argv[1].endsWith("drift-injection-sweep.ts")) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
```

Note: the CLI-entry guard and `new Date().toISOString()` run only in the `--append-results` output path and the direct-CLI block, never inside the deterministic measurement loop — the injector and scoring stay clock-free.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run bench/longmemeval/manual/drift-injection-sweep.test.ts`
Expected: PASS. If the fixture baseline gate fails, read `bench/longmemeval/run.test.ts:43` to confirm the fixture's arm A KU `updateCorrect` value and set `--expect-update-correct` to it.

- [ ] **Step 5: Typecheck + full bench test sweep**

Run: `npx tsc --noEmit`
Run: `npx vitest run bench/longmemeval/manual/drift-injector.test.ts bench/longmemeval/manual/drift-injection.integration.test.ts bench/longmemeval/manual/drift-injection-sweep.test.ts`
Expected: no type errors; all three test files green.

- [ ] **Step 6: Commit** *(held)*

```bash
git add bench/longmemeval/manual/drift-injection-sweep.ts bench/longmemeval/manual/drift-injection-sweep.test.ts
git commit -m "feat(bench): drift-injection sweep driver with zero-drift baseline gate"
```

---

## Post-implementation: run the real sweep (manual, not CI)

After all tasks pass, run the oracle sweep on demand (requires the gitignored oracle dataset):

```bash
npx tsx bench/longmemeval/manual/drift-injection-sweep.ts \
  --file bench/datasets/longmemeval/longmemeval_oracle_target.json \
  --claims bench/datasets/longmemeval/longmemeval-oracle-claims.jsonl \
  --expect-update-correct 0.403
```

Expected shape of the result: the `off` curve declines as fraction rises; the `on` curve stays ~flat near 0.403. Record the table in `bench/RESULTS.md` (use `--append-results bench/RESULTS.md`) and note any aliased-on deviation from flat as the ranking-sensitivity finding (spec §5.3).

## Commit policy (this run)

The user asked to **hold all commits**. Implement and verify each task, leaving the working tree staged but uncommitted, until the user releases the hold. When released, the per-task `git commit` steps above run in order. The spec and this plan are likewise written to disk but **not yet committed**.

---

## Self-Review

**Spec coverage:**
- §3 three files → Tasks 1+2 (`drift-injector.ts`), 3 (integration test), 4 (`drift-injection-sweep.ts`). ✓
- §4.1 signature → Task 1 Interfaces. ✓
- §4.2 deterministic selection → Task 1 `drifts()` + determinism test. ✓
- §4.3 variant-set monotonicity → Task 1 `morphVariants` (≥2) + fragmentation test. ✓
- §4.4 morph templates → Task 1; judged vocab via key-alias-auto reuse → Task 2. ✓
- §4.5 multi-key exclusion + judged eligibility/coverage → Task 1 (multi) + Task 2 (eligibility) + Task 4 (coverage line). ✓
- §4.6 no-op@0 + exact alias map → Task 1 tests. ✓
- §5.1 CLI → Task 4. §5.2 baseline gate → Task 4 (+ gate-abort test). §5.3 reported flatness/dose-response → Task 4 output. §5.4 table + dump + coverage → Task 4. ✓
- §6.1 unit tests → Tasks 1–2. §6.2 fixture round-trip → Task 3. §6.3 on-demand sweep → Post-implementation section. ✓
- §7 gotchas (jaccard-underscore expected, multi excluded, knobs off) → constraints + Task 1. ✓
- §8 out-of-scope (no earned map, jaccard only, no persistent store) → honored (tmp DB per cell; no judged-map earning; no hybrid cells). ✓

**Placeholder scan:** No TBD/TODO. Task 3 intentionally defers exact `LmeQuestionT`/session-teardown literals to verification against the real schema (test-only, with the named files to check) — this is a verify-against-reality step, not an unfilled placeholder; all production code is complete.

**Type consistency:** `injectDrift`, `DriftOpts`, `DriftResult`, `CanonicalGroups`, `buildJudgedVocab`, `morphVariants`, `hashStr` are named identically across Tasks 1, 2, 3, 4. `aliasMap` (variant→canonical) matches `answer.ts:24` `keyAliases?: Record<string,string>` and `KeyAliasMap`. `autoRatify` returns `{ map }` (consumed in Task 2). `scoreQuestion(q, res, KS)` and `aggregate(scores, KS)` match `score.ts`. `MANUAL_KEY_CARDINALITY` shape matches `run.ts:71`.
