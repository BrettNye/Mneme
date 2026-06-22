# Real-answer confirmation — design

**Date:** 2026-06-18
**Status:** Design (pre-plan)
**Branch:** `feat/real-answer-confirmation` (stacked on `feat/bench-recency-ranking`, PR #30)
**Motivated by:** the recency-aware ranking gate (`bench/RESULTS.md`; memory `drift-injection-null-result`): blended recency ranking lifts KU `updateCorrect` 0.403 → up to 0.972. But `updateCorrect` is the session proxy ("top-1 traces to the latest answer session"), which recency trivially maximizes (Trap 1). This experiment is the **confirmation gate**: does the win hold on *real answer correctness*, on the realistic served context — before any `src` promotion of a recency-aware ranking operator.

---

## 1. Purpose and the decision it gates

For a few ranking cells, judge whether the **served top-k context actually contains/supports the gold answer** (`q.answer`), via an LLM judge — and compare blends against the jaccard baseline. This defeats the proxy circularity and surfaces the recall tradeoff in *answer* terms.

- **Confirmed:** a blend lifts KU `answerInContext` over the α=1 baseline AND holds TR ≥ baseline → the recency win is real → proceed to the `src`-promotion cycle.
- **Refuted:** the KU gain evaporates (recency surfaced the latest *session* but the context no longer *answers* better) OR TR regresses (the `recall@k` degradation bites in answer terms) → the proxy misled us; pick a gentler α or stop.

This is still a **gate** — no `src` change here.

---

## 2. Scope

- **Bench-only.** New files: `answer-correctness-judge.ts` + `answer-judge-sweep.ts` (+ tests + a smoke script). No `src/` change; no change to existing bench files.
- **Reuses** `resolveOnly` + `rankBlend` (from `feat/bench-recency-ranking`) for the served context, and the `ratify-judge.ts` LLM-call + cache idiom.
- **Dataset:** oracle 229q, **KU + TR only** (abstention excluded — its gold answer is "don't know," a different judgment, and it is non-discriminating).
- **Cells (4):** α=1 (jaccard baseline), α=0.25/90d, α=0.5/90d (bracket the recommended blend), α=0 (pure recency). `halfLife=90d` fixed for the blends (the gate's dose-response already covered half-life; this confirmation fixes one).
- **Context depth:** top-**k=5** served claims (realistic agent context; small enough that the `recall@k` tradeoff bites). Flag-tunable.
- **Metric basis:** LLM-judged real-answer correctness — NOT the session proxy.

---

## 3. Architecture and components

| File | Change | Responsibility |
|---|---|---|
| `bench/longmemeval/manual/answer-correctness-judge.ts` | Create | The judge: `judgeAnswerInContext(apiKey, item) → {correct, reason}` via Anthropic Messages API (`json_schema`), prompt builder, lenient parse. Mirrors `ratify-judge.ts`. |
| `bench/longmemeval/manual/answer-correctness-judge.test.ts` | Create | Unit tests: prompt shape, parse, the cheap exact/substring pre-check, empty-context → false. |
| `bench/longmemeval/manual/answer-judge-sweep.ts` | Create | Driver: ingest once → precompute `resolveOnly` survivors → per cell `rankBlend` top-k context → judge (cached) → report `answerInContext` per (cell, category) + the baseline-relative verdict. Takes an **injectable `judge` fn** (defaults to the real `judgeAnswerInContext`) so the test stubs it without network — mirroring the bio `dreamFn` injection pattern. |
| `bench/longmemeval/manual/answer-judge-sweep.test.ts` | Create | CLI/arg validation + a fixture dry-run with a STUBBED judge (no network) asserting wiring + cache behavior. |
| `bench/longmemeval/manual/smoke-answer-judge.ts` | Create | One real judge call through the production request+parse (≈1¢) before any bulk run (mirrors `smoke-one-call.ts`). |

**Per-question data flow (driver):**
```
records  = claimsFor(q, allClaims, { oracle: true })
ingestQuestion(session, q, records)
corpusId = corpusIdFor(q.question_id)   // = `lme-${question_id}`; do NOT hand-build the literal
survivors = resolveOnly(session, corpusId, q, { keyCardinality: MANUAL_KEY_CARDINALITY, evidencePoolingRule: RULE.MAX_MEAN })  // once per question
for each cell (alpha):
  context = rankBlend(survivors, q.question, { alpha, halfLifeMs, t }).slice(0, CONTEXT_K)
  verdict = judged-cache.get(cell, q.question_id) ?? judge({ question: q.question, gold: stringify(q.answer), context })   // cached
  accumulate answerInContext per (cell, categoryOf(q))
```

---

## 4. The judge (`answer-correctness-judge.ts`)

- **Model:** `ANSWER_JUDGE_MODEL = "claude-sonnet-4-6"`, `ANSWER_JUDGE_PROMPT_VERSION = "answer-judge-v1"` (distinct constants; the cache header pins them so a model/prompt change can't silently mix). Request shape mirrors `ratify-judge.ts` (fetch, `anthropic-version: 2023-06-01`, `output_config.format.type: "json_schema"`, `additionalProperties: false`). *The plan will verify the model id + request shape against the claude-api skill before writing the call.*
- **Input item:** `{ question: string; gold: string; context: string[] }` where each `context` entry is a top-k served claim rendered **`subject.key = value (as of <ISO valid.from>)`** — value via `canonicalizeValue` (a `Claim.value` is `Value`, not guaranteed `string`), and the **date is included for ALL categories** (necessary for TR ordering questions like "which did I do first, X or Y?"; harmless for KU). `gold` = `String(q.answer)` (the field is `z.unknown().optional()`, but verified populated as a literal-answer string in the oracle).
- **Rubric / structured output:** "Given the question and the gold answer, does the served context contain or support that answer? Be strict: partial/adjacent facts that don't answer the question are `false`." → `{ correct: boolean, reason: string }` (one sentence).
- **NO substring pre-check — the LLM judges every non-empty item.** An exact gold-in-context short-circuit was considered and REJECTED (audit): real golds are short/numeric/yes-no/disambiguation (`"bike"`, `"four"`, `"Yes."`) that appear in context regardless of correctness — a substring shortcut would silently inflate `answerInContext` and corrupt the confirmation. All ~800 items go to the LLM (still cheap, ~$2–3); validity over the marginal saving.
- **Empty context** (no survivors) → `{ correct: false, reason: "empty context" }`, no call.
- **Cache:** resume-safe JSONL. Header `{ kind: "answer-judge-header", model, promptVersion, contextK }`; records `{ cell, questionId, category, correct, reason }`; keyed by `(cell, questionId)`. **NET-NEW vs `ratify-judge.ts` (which does NOT validate its header or repair torn writes):** this judge ADDS header-mismatch abort + last-valid-line torn-write recovery, modeled on the EXTRACTION cache (`bench/convert/longmemeval.ts`), so a model/prompt/k change can't silently mix and a killed run resumes cleanly.

---

## 5. Driver, metric, decision

- **Grid:** `alpha ∈ {1.0, 0.25, 0.5, 0.0}` (α=1 baseline; blends at halfLife=90d) × {KU, TR}. ~4 × (72 KU + ~127 TR) ≈ **800 LLM judgments** (cached; ~$2–3 sonnet). The driver **prints the actual filtered KU/TR counts at runtime** (don't hard-code 72/127 — KU=72 is corroborated by `bench/RESULTS.md`, but the TR count must be observed since the oracle file is gitignored).
- **Metric:** `answerInContext` = fraction of questions in (cell, category) the judge marks `correct`.
- **Output:** table (`alpha, category, answerInContext, n`); per-category dose-response over α; and a **verdict block** computing per blend cell `ΔKU = answerInContext_KU − baselineKU`, `ΔTR = answerInContext_TR − baselineTR`, labeling CONFIRMED (`ΔKU > 0 ∧ ΔTR ≥ 0`) / REFUTED-KU (`ΔKU ≤ 0`) / REFUTED-TR (`ΔTR < 0`).
- **Cost discipline:** `smoke-answer-judge.ts` (1 real call + parse check) + `--limit N` partial run + a printed cost estimate and explicit approval before the full ~800. Smoke-before-bulk-spend is mandatory.

---

## 6. Validation & determinism

- **Judge-error bound:** a stratified blind **human spot-check** (~50 judgments, reusing the `spot-check-sheet.md` pattern) → reported judge-error rate, so the confirmation states its own reliability rather than trusting sonnet blindly. Optional escalation: re-judge disagreements with opus.
- **Determinism:** served context is deterministic (`resolveOnly`+`rankBlend`); judgments cached by `(cell, questionId)`; re-runs replay from cache ($0). The judge call itself is non-deterministic across fresh runs (LLM), which is exactly why judgments are cached and committed — the recorded verdict is reproducible from the cache.

---

## 7. Forks (recorded, selected by the result)

- **CONFIRMED → `src` promotion** (separate spec/plan): a new claim-metadata-aware ranking operator in `src/algebra` + a `rankedTailStages` dial + an MCP `recall` recency option, default (α, half-life) tuned from the gate + this confirmation.
- **REFUTED-KU → stop / rethink:** the proxy misled; recency surfaces the latest session but not better *answers*. Investigate why (attribute mismatch?).
- **REFUTED-TR → gentler α or intent-aware:** the recall tradeoff is real in answer terms; pick a smaller (1−α) recency weight, or revisit the explicit-as-of-from-caller fork.

---

## 8. Out of scope (YAGNI)

- No `src/` change (gate only).
- No opus bulk judge (sonnet + human spot-check; opus only for optional disagreement re-judge).
- No top-1 metric (top-k context is the honest test).
- Abstention excluded.
- Full 15-cell grid excluded (4 cells).
- No new LLM-client abstraction — reuse the existing fetch idiom verbatim.
