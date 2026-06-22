# Drift-injection benchmark arm — design

**Date:** 2026-06-17
**Status:** Design (pre-plan)
**Lever:** Open-deficiency board #4 — quantify the key-matching wedge under controlled key drift.

---

## 1. Purpose and falsification

The key-matching slice (PR #23) is a **no-op on clean keys**: the post-#23 fixture bench is 9/9, so a passing test suite proves correctness but puts **no number** on the value. The detect→declare→contest pipeline only earns its keep when keys actually drift — when the extractor emits `employer` in one session and `preferred_employer` in another for the same fact, so the two never contest and a stale value silently survives.

This arm **injects controlled key drift** into the oracle LongMemEval claims-file, then runs arm A **with** vs **without** a ground-truth alias map, and measures the `updateCorrect` gap as a function of drift fraction. The result is a dose-response curve: *how much knowledge-update accuracy does key-aliasing recover as drift worsens.*

**Falsifiable claim:** with a perfect (oracle) alias map, contradiction grouping is restored to the no-drift state regardless of drift fraction. So the **aliased-on curve should stay ~flat at the recorded baseline** while the **aliased-off curve declines** with fraction. If aliased-on does *not* stay flat, either the alias map is not regrouping correctly (a bug) or claim-*key* tokens leak into jaccard ranking (a measurable ranking-sensitivity finding) — both are reportable, neither is silently absorbed.

**What this arm does NOT measure:** the real-world *detection* error of the census+judge pipeline. The alias map here is ground-truth (the injector knows every variant it wrote). Earning the map via `key-alias-auto` + `ratify-judge` is a separate, more expensive experiment (it adds LLM judge cost and detection precision/recall) and is explicitly out of scope (§8). This arm measures the **ceiling**: the recovery available if detection were perfect.

---

## 2. Scope

- **Dataset:** oracle 229-question split — `bench/datasets/longmemeval/longmemeval_oracle_target.json` + `bench/datasets/longmemeval/longmemeval-oracle-claims.jsonl` (gitignored, extracted on demand). The 3-question fixture (`bench/longmemeval/fixtures/`) is used only for the fast harness test.
- **Ranker:** jaccard only (matches the recorded oracle baseline and the gate). Hybrid is deferred (§8).
- **Knobs:** `abstainBelowTop: 0`, `relevanceFloor: 0` throughout — isolate the key-matching effect, per the model-specific abstention-calibration caveat.
- **Primary metric:** `updateCorrect` on the knowledge-update (KU) category (`bench/longmemeval/score.ts:150`, KU-only by construction). `recall@{1,3}` recorded as secondary, not gated.
- **Grid:** `fraction {0, 0.1, 0.25, 0.5, 0.75, 1.0} × mode {judged, morph} × aliased {off, on}` → 24 cells.

---

## 3. Architecture and components

Three new files under `bench/longmemeval/manual/`. `run.ts`, `answer.ts`, and `score.ts` are **not modified**.

| File | Purpose |
|---|---|
| `drift-injector.ts` | Pure function `injectDrift(claims, opts) → { claims, aliasMap }`. No I/O, no LLM, no wall-clock. |
| `drift-injection-sweep.ts` | Grid driver. Mirrors `key-matching-sweep.ts`: loads dataset+claims once, loops the grid, enforces the baseline gate, emits a markdown table + dose-response dump. |
| `drift-injector.test.ts` | Unit tests for the injector in isolation. |

**Per-cell data flow** (driver):
```
load questions + claims (once)
for each cell (fraction, mode, aliased):
  { claims: drifted, aliasMap } = injectDrift(allClaims, { mode, fraction, seed })
  for each question:
    records = claimsFor(q, drifted, { oracle: true })
    ingestQuestion(session, q, records)               // throwaway tmp DB, per run.ts
    resultA = answerArmA(session, corpusId, q, {
      k, keyCardinality: MANUAL_KEY_CARDINALITY,
      rankFn: "jaccard", abstainBelowTop: 0, relevanceFloor: 0,
      keyAliases: aliased ? aliasMap : undefined,      // answer.ts:24 field
    })
    scoreQuestion(q, resultA, ks)
  aggregate → ScoreRow[] for this cell
```

The throwaway corpus is a `mkdtemp` tmp DB exactly as `run.ts` does. **No writes touch `~/.mneme/knowledge.db` or any persistent store**, and this arm is never pointed at the dogfood corpus.

---

## 4. The injector (`drift-injector.ts`)

### 4.1 Signature

```ts
type DriftMode = "judged" | "morph";

interface DriftOpts {
  mode: DriftMode;
  fraction: number;            // 0..1
  seed: string;                // determinism anchor
  multiKeys: Record<string, "single" | "multi">;  // = MANUAL_KEY_CARDINALITY
  judgedVocab?: CanonicalGroups; // required for mode "judged" (built once, see 4.4)
}

interface DriftResult {
  claims: ClaimRecordT[];                 // drifted copy (input untouched)
  aliasMap: Record<string, string>;       // every emitted variant → its canonical
  coverage: { eligibleKeys: number; driftedKeys: number; noVariantKeys: number };
}

export function injectDrift(claims: ClaimRecordT[], opts: DriftOpts): DriftResult;
```

`ClaimRecordT` is the existing schema (`bench/longmemeval/types.ts`): `{ subject, key, value, validFrom, confidence?, tags[] }`.

### 4.2 Selection (deterministic)

For each claim, compute `h = hash(seed + "|" + subject + "|" + key + "|" + validFrom + "|" + value)`. Drift the claim iff its key is **eligible** (§4.5) and `(h mod 1_000_000) / 1_000_000 < fraction`. Identity excludes list position, so output is invariant to input ordering.

### 4.3 The variant-set requirement (monotonicity mechanism)

Each canonical key maps to a **set of ≥2 variants**. A chosen claim selects one variant by `hash(seed + claimIdentity + ":variant") mod |variantSet|`.

This is load-bearing: if all drifted claims of one lineage moved to the *same* variant key, they would still contest each other and the wedge would **vanish at fraction = 1.0**, breaking the dose-response curve. Distributing across a variant set fragments a superseding lineage across multiple keys, so fragmentation — and the aliased-off penalty — grows monotonically with fraction.

### 4.4 Variant vocabularies per mode

- **`morph`** — generated from the canonical key via fixed template sets: prefixes `{preferred_, current_, primary_}` and suffixes `{_current, _now}` (a ≥2-member set per key by construction). Applies to any key. Underscore variants score jaccard = 0 against the canonical (documented gotcha); this is expected — the oracle map regroups them at ⊥ regardless of ranking score, and the residual ranking effect is exactly what the aliased-on curve diagnoses.
- **`judged`** — variants drawn from the committed judged-pairs dataset `bench/longmemeval/manual/data/key-ratify-judgments.jsonl`. That file is **symmetric pairs** `{ a, b, same, score }` (header `{kind:"key-ratify-header"}`), **not** canonical→variant. So `judgedVocab` is built once by **reusing `key-alias-auto.ts`'s grouping**: union-find over `same: true` pairs into components, then pick the canonical per component by its existing rule (most claims in corpus; ties → lexicographically smallest). A component is usable only if its canonical key appears in the claims-file; the other members are the variant set (components of size 1 yield no variant). This is the real drift distribution the extractor actually produced.

### 4.5 Eligibility and exclusions

- **Multi-value keys excluded.** Any key whose `multiKeys[key] === "multi"` is never drifted — multi-value keys never contest (`run.ts:71` `MANUAL_KEY_CARDINALITY`), so drifting them measures nothing and only adds noise. The driver passes the same constant `run.ts` uses (single source of truth).
- **judged-mode no-variant keys** stay canonical and are counted in `coverage.noVariantKeys`, so the effective drift fraction is reported honestly (e.g. "drifted 31 of 47 single-value keys; 16 had no judged variant").

### 4.6 Output guarantees

`aliasMap` contains exactly the variants emitted → their canonicals; no canonical key appears as a *key* of the map. At `fraction = 0` the output claims equal the input and `aliasMap` is empty (true no-op).

---

## 5. The sweep driver (`drift-injection-sweep.ts`)

### 5.1 CLI (mirrors `key-matching-sweep.ts`)

```
tsx bench/longmemeval/manual/drift-injection-sweep.ts \
  --file bench/datasets/longmemeval/longmemeval_oracle_target.json \
  --claims bench/datasets/longmemeval/longmemeval-oracle-claims.jsonl \
  [--fractions 0,0.1,0.25,0.5,0.75,1.0] \
  [--modes judged,morph] \
  [--seed drift-v1] \
  [--expect-update-correct 0.403] \
  [--append-results bench/RESULTS.md]
```

### 5.2 Baseline gate (hard abort)

The `fraction = 0, aliased = off` cell must reproduce the recorded oracle **KU `updateCorrect` = 0.403** within float tolerance (the value is the `--expect-update-correct` arg, default 0.403, identical idiom to `key-matching-sweep.ts:8,15`). `fraction = 0` is mode-independent, so it is a single shared anchor. Mismatch aborts the run — it proves the injector is a true no-op at zero drift and the run is comparable to the recorded baseline.

### 5.3 Reported correctness property (not gated)

Aliased-on cells are expected to stay within a tolerance band of the baseline across all fractions. The driver prints, per fraction and mode, the `(off, on)` pair and the gap. Aliased-on deviations from flat are flagged in the output as the ranking-sensitivity diagnostic (since ⊥ grouping is restored by the oracle map, residual movement is ranking, not resolution).

### 5.4 Output

- Markdown table: `fraction, mode, aliased, updateCorrect, recall@1, recall@3, n` (3-decimal rounding, per `key-matching-sweep.ts:72`), optionally appended to `bench/RESULTS.md`.
- Compact dose-response dump: per mode, two columns (`off`, `on`) over the fraction axis, ready for the GTM artifact.
- judged-mode coverage line per run.

---

## 6. Testing

### 6.1 Unit tests (`drift-injector.test.ts`) — the determinism guarantee

- **Determinism:** identical `(claims, mode, fraction, seed)` → byte-identical `claims` and `aliasMap` across calls.
- **No-op at fraction 0:** output claims deep-equal input; `aliasMap` empty.
- **Monotonic fragmentation:** distinct-key count is non-decreasing in fraction; at 1.0 a ≥2-claim lineage is split across ≥2 variant keys.
- **Multi-key exclusion:** keys marked `"multi"` are never rewritten at any fraction.
- **Alias-map exactness:** every rewritten key is present → correct canonical; no canonical appears as a map key.
- **judged eligibility/coverage:** only keys with a judged variant drift; `coverage` counts are correct; size-1 components yield no variant.

### 6.2 Harness test (fixture, fast, CI-safe)

One cell end-to-end on `bench/longmemeval/fixtures/claims.jsonl` proving `injectDrift → ingestQuestion → answerArmA → scoreQuestion` round-trips, and that on a drifted superseding pair `aliased = on` recovers the newest value while `aliased = off` serves both — the `answer.test.ts:996` scenario, now driven through the injector instead of a hand-built map.

### 6.3 The 24-cell oracle sweep

Run on demand (loads the gitignored oracle dataset), **not in CI** — same policy as the existing sweep.

---

## 7. Gotchas accounted for

- **jaccard underscore = 0** — morph (and some judged) variants share no tokens with the canonical under jaccard; expected, and the oracle map groups them at ⊥ regardless. The aliased-on curve quantifies any residual ranking effect.
- **`MANUAL_KEY_CARDINALITY` multi-keys** — excluded from injection (§4.5).
- **Abstention threshold is model-specific** — knobs stay at 0 (§2).
- **Converter resume-accounting** — irrelevant; this arm consumes an already-extracted claims-file and performs no extraction.
- **`MANUAL_KEY_CARDINALITY` inherited at oracle scale** (6 keys, unvalidated) — this arm uses the same constant as the recorded baseline, so it inherits the same assumption; not introduced here, noted for parity.

---

## 8. Out of scope (YAGNI)

- **Earned alias map** (census + ratify-judge on the drifted corpus) — oracle map only this round; the detection-gap experiment is deferred.
- **Hybrid ranker cells** — jaccard only (matches the gate baseline); add as a later row if the morph/underscore interaction needs isolating.
- **recall@k as a gated signal** — recorded, not gated.
- **Temporal / abstention categories** — pass through scoring untouched but are not analyzed; KU is the wedge metric.
- **Persistent storage** — throwaway tmp DB per run; never the `knowledge` corpus.
