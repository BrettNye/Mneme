# Mneme benchmark results

Pressure-testing Mneme's import + query path across synthetic and real datasets.
Numbers are machine-specific (Windows 10, `better-sqlite3` WAL, single process,
run via `tsx`) — read them as **relative trends**, not absolutes.

## How to run

```bash
# Synthetic sweep (scale x contradiction-policy), with integrity assertions
npx tsx bench/synthetic.ts --scales 2000,10000,50000,100000 --policies always_accept,reject,resolve

# Real datasets (download on demand into bench/datasets/, which is gitignored)
curl -s "https://raw.githubusercontent.com/mniepert/mmkb/master/TemporalKGs/icews14/icews_2014_train.txt" -o bench/datasets/icews14_raw.txt
npx tsx bench/convert/icews.ts bench/datasets/icews14_raw.txt bench/datasets/icews14.jsonl
npx tsx bench/dataset.ts --name icews14 --file bench/datasets/icews14.jsonl --as icews --policy always_accept

# ConceptNet: stream only a capped subset rather than the full 350MB dump
curl -s "https://s3.amazonaws.com/conceptnet/downloads/2019/edges/conceptnet-assertions-5.7.0.csv.gz" | gunzip | head -n 150000 > bench/datasets/cn_subset.tsv
npx tsx bench/convert/conceptnet.ts bench/datasets/cn_subset.tsv bench/datasets/cn.jsonl
npx tsx bench/dataset.ts --name conceptnet --file bench/datasets/cn.jsonl --as conceptnet
```

### LongMemEval

LongMemEval is a benchmark for long-context memory in dialogue systems. It requires
a one-time LLM extraction step (network, cached, resumable) to convert raw sessions
into a claims JSONL, after which all evaluation runs are deterministic and network-free.

**Step 1: Download the dataset (one-time)**

The dataset lives in the HuggingFace dataset repo `xiaowu0162/longmemeval`. Download
`longmemeval_s.json` (the standard split) and optionally `longmemeval_oracle.json`
(oracle/attribution variant) into `bench/datasets/longmemeval/` (gitignored):

```bash
# Requires huggingface-cli (pip install huggingface_hub)
huggingface-cli download xiaowu0162/longmemeval longmemeval_s.json --repo-type dataset --local-dir bench/datasets/longmemeval

# Optional oracle variant (used with --oracle flag)
huggingface-cli download xiaowu0162/longmemeval longmemeval_oracle.json --repo-type dataset --local-dir bench/datasets/longmemeval
```

Note: verify exact filenames against https://huggingface.co/datasets/xiaowu0162/longmemeval
if the above fail — the HF repo may rename files between dataset versions.

**Step 2: Extract claims (one-time, LLM-assisted, resumable)**

Requires `ANTHROPIC_API_KEY` in your environment. Runs `claude-sonnet-4-6` over
each session to extract structured claims. Caches results in the output JSONL
so interrupted runs resume where they left off:

```bash
ANTHROPIC_API_KEY=sk-... npm run eval:lme:extract
```

**Step 3: Run the benchmark (deterministic)**

```bash
npm run eval:lme
```

Prints a Markdown aggregate table and `checks N/M`. Exits nonzero on any check failure.

**Network-free CI smoke test (fixture dataset)**

Uses the committed fixture dataset and pre-extracted claims in `bench/longmemeval/fixtures/`.
No network access, no external files:

```bash
npm run eval:lme:fixture
```

**Flags**

- `--oracle`: resolve questions using oracle attribution. Requires re-extracting claims from `longmemeval_oracle.json` (download step 1) and passing that file as `--file` and the resulting claims as `--claims` — the `eval:lme` npm script targets the standard split only.
- `--k 1,3,10`: comma-separated recall depth values (default `1,3,10`).
- `--raw`: skip strict JSON schema validation on dataset (useful for non-standard splits).

Every run asserts integrity invariants and reports `checks N/M`. A run that
fails an invariant exits nonzero.

## Headline findings

1. **Import was O(n²); now O(n).** `maxRecordedSeq()` runs `SELECT MAX(recorded_seq)`
   on every commit, and with no index on that column SQLite full-scanned the table
   per insert. `always_accept` throughput fell from ~840 rows/s at 2k to ~320 at 10k.
   Adding `idx_claims_recorded_seq` made it O(log n); throughput is now **flat ~800
   rows/s from 2k to 100k**. (commit `perf(adapter): index recorded_seq …`)

2. **`session.close()` didn't release the DB handle.** It was a no-op, so the
   `better-sqlite3` file stayed open and the db couldn't be removed/reopened on
   Windows (EBUSY). Added an optional `StorageAdapter.close()` wired into
   `session.close()`. (commit `fix(adapter): add optional close() …`)

3. **Write throughput tracks contradiction density.** Mostly-unique data
   (ConceptNet) imports at ~1900 rows/s; a 30%-contradiction synthetic load runs
   ~800 rows/s — the per-claim contradiction lookup dominates cost.

4. **Read-side `count` over a full corpus is slow at scale** (6.3s @73k, 10.8s
   @150k). `leaf` loads the whole corpus into memory per query; aggregation is
   not pushed down to SQL. Candidate next optimization.

5. **Integrity held everywhere.** `committed+rejected+dup+skipped == total` and
   `count == committed` passed across all datasets, scales, and policies.

## Synthetic — throughput vs scale (`always_accept`, after the index fix)

Flat throughput confirms the O(n²) cliff is gone; memory stays bounded (streaming).

| scale  | import ms | rows/s | committed | count | peak MB | checks |
|--------|-----------|--------|-----------|-------|---------|--------|
| 2,000  | 2,375     | 842    | 2,000     | 2,000 | 108     | 4/4    |
| 10,000 | 11,711    | 854    | 10,000    | 10,000| 149     | 4/4    |
| 50,000 | 67,507    | 741    | 50,000    | 50,000| 195     | 4/4    |
| 100,000| 123,799   | 808    | 100,000   | 100,000| 356    | 4/4    |

## Synthetic — contradiction policies @10k (contradiction=0.3, duplicate=0.1)

| policy        | rows/s | committed | rejected | count | checks |
|---------------|--------|-----------|----------|-------|--------|
| always_accept | 777    | 10,000    | 0        | 10,000| 4/4    |
| reject        | 1,104  | 5,911     | 4,089    | 5,911 | 4/4    |
| resolve       | 785    | 10,000    | 0        | 10,000| 4/4    |

`reject_on_contradiction` rejects *any* second write to an existing
`(subject,key,scope)` — differing value or identical re-write — committing each
identity exactly once. `accept_and_resolve` accepts all and deprecates the prior.

## Real — ICEWS14 (72,826 temporal facts; `valid.from = event date`)

| policy        | rows/s | committed | rejected | count  | query ms | checks |
|---------------|--------|-----------|----------|--------|----------|--------|
| always_accept | 623    | 72,826    | 0        | 72,826 | 6,321    | 2/2    |
| reject        | 1,887  | 33,873    | 38,953   | 33,873 | 742      | 2/2    |

Modeling note: with `scope={}` the temporal dimension lives only in `valid.from`,
so under `reject` repeated `(actor, relation)` facts at different dates collide on
identity → ~53% retained (one fact per actor-relation pair). To keep all temporal
facts under a contradiction policy, put the event date in `scope`.

## Real — ConceptNet 5.7 (150k-edge head subset)

| policy        | rows/s | committed | count   | query ms | peak MB | checks |
|---------------|--------|-----------|---------|----------|---------|--------|
| always_accept | 1,945  | 150,000   | 150,000 | 10,800   | 169     | 2/2    |

Caveat: this is the alphabetically-early **head** of the sorted dump (language- and
relation-skewed), streamed to cap the download — not a representative sample.
Faster than synthetic because identities are near-unique (little contradiction work).

## LongMemEval A/B findings (2026-06-05)

The LongMemEval suite tests the core hypothesis: **claims with superseding/temporal
structure are retrieved more correctly through the algebra read path (arm A: recall +
`⊥`/resolve + τ_valid) than through plain similarity recall (arm B)**. Both arms share
identical lexical recall, so every delta is attributable to the algebra stages.

### Designed-separation check (committed fixtures, CI)

`npm run eval:lme:fixture` - on the 3-question fixture set, arm A scores 1.0 and arm B
0.0 on updateCorrect / temporalCorrect / abstentionCorrect. This validates the
instrument (each metric detects the failure mode it claims to), not the hypothesis.

### Real-data sample (manual extraction, 20 questions)

Methodology: claims were extracted **manually** (Claude Code session agents reading the
real session transcripts; no API spend) for 10 knowledge-update + 5 temporal + 5
abstention oracle questions; KU questions were enriched with 2 distractor sessions each
from the `_s` haystacks. 188 claims, 60/60 integrity checks. Scripts:
`bench/longmemeval/manual/build-manual-sample.ts` + `assemble-manual-claims.ts`.
Caveats: small N; extraction agents were explicitly instructed to normalize keys
(favorable conditions); several sampled distractor sessions were empty.

| category (n) | metric | arm A | arm B |
|---|---|---|---|
| knowledge-update (10) | **updateCorrect** | **0.9** | **0.1** |
| knowledge-update (10) | recall@1 / @3 / @10 | 0.5 / 0.9 / 1.0 | 0.5 / 1.0 / 1.0 |
| temporal-reasoning (5) | temporalCorrect | 1.0 | 1.0 |
| abstention (5) | abstentionCorrect | 0.0 | 0.0 |

1. **Knowledge-update is the headline: 0.9 vs 0.1.** On real conversational
   supersession, plain recall surfaced the stale fact on top in 9/10 questions; the
   algebra resolved 9/10 correctly, at a cost of only 0.1 recall@3 (the deliberately
   suppressed superseded claims).
2. **Temporal is non-discriminating in oracle mode** (evidence-only sessions leave
   nothing for τ_valid to exclude). Differentiation requires the full `_s` haystacks.
   Calibration finding along the way: LongMemEval `question_date` has same-day
   granularity (evidence sessions are often timestamped hours *after* the question),
   so both the evaluation clock and the temporalCorrect metric use **end of the
   question's UTC day** (`evaluationInstant` / `endOfUtcDay`); naive instant-precision
   clocks collapse arm A's recall to ~0.17.
3. **Abstention is an honest negative: 0.0 for both arms.** The `_abs` questions ask
   about absent entities amid topically-adjacent sessions; lexical overlap always lets
   *something* survive the pipeline, so structural ("nothing survived") abstention
   never fires. Abstention needs a relevance/confidence threshold - a recall-surface
   design input, not a bench artifact.

### Adversarial probes (`bench/longmemeval/manual/adversarial-probe.ts`)

Six hand-built cases designed to make arm A lose:

| case | verdict |
|---|---|
| additive facts, same key (hobbies) | LOSS - `⊥`'s value-difference criterion wrongly deprecates the older true fact; needs schema-declared key cardinality |
| supersede-then-revert | WIN - latest-wins handles cycles |
| paraphrase values (NYC vs New York City) | benign outcome, wrong reason - audit trail records a phantom contradiction |
| contradiction split across keys (home_city vs city) | BLIND - `⊥` only fires on exact subject+key; the algebra's advantage is gated on extraction-time key normalization |
| timestamp tie, conflicting values | arbitrary (deterministic lexicographic winner) - should flag-for-review |
| fresh low-confidence update vs stale confident fact | BLIND - the 0.5 detection floor hides the contesting claim; detection and resolution arguably need separate confidence semantics |

Each weakness maps to a candidate library slice: cardinality-aware `⊥`,
similarity-tolerant key matching, tie -> flag-for-review, split detection-floor vs
resolution-weighting.

### Extraction-cost incident (2026-06-05)

A bulk API extraction run failed with zero usable output (~$20 consumed): responses
were valid but `JSON.parse` on bare response text failed universally, and each
deterministic failure was retried at full cost while errors were swallowed. Fixes now
in place: structured outputs (`output_config.format`) in `realLlm`, 4-layer lenient
`parseLlmClaims`, retry cap on deterministic failures, fail-fast on 400/401/403 with
the API message, per-reason skip accounting. **Protocol: always run
`bench/longmemeval/manual/smoke-one-call.ts` (~1 cent, prints an explicit VERDICT)
before any bulk extraction run.**

## Key-matching oracle experiment — auto-ratification threshold sweep (2026-06-06)

Dataset: bench/datasets/longmemeval/longmemeval_oracle_target.json (oracle attribution). Claims: bench/datasets/longmemeval/longmemeval-oracle-claims.jsonl (model claude-sonnet-4-6, promptVersion lme-extract-v1). Ranking jaccard in all passes; scorer drives key-pair auto-ratification only (single-link components, canonical = most-claims then lexicographic). Bench-only experiment policy — the product keeps human/agent ratification; this curve is calibration evidence for a future auto-suggest dial. Spec: docs/superpowers/specs/2026-06-06-key-matching-oracle-experiment-design.md

| scorer | theta | KU_updateCorrect | KU_recall@1 | KU_recall@3 | KU_recall@10 | TR_correct | TR_recall@3 | ABS_correct | aliases | qAffected | maxComponent |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| — | baseline | 0.403 | 0.493 | 0.917 | 0.965 | 1 | 0.843 | 0 | 0 | 0 | 1 |
| jaccard | 0.5 | 0.417 | 0.493 | 0.91 | 0.965 | 1 | 0.846 | 0 | 486 | 136 | 13 |
| jaccard | 0.6 | 0.403 | 0.493 | 0.91 | 0.965 | 1 | 0.843 | 0 | 166 | 72 | 8 |
| jaccard | 0.7 | 0.403 | 0.493 | 0.917 | 0.965 | 1 | 0.843 | 0 | 19 | 12 | 4 |
| jaccard | 0.8 | 0.403 | 0.493 | 0.917 | 0.965 | 1 | 0.843 | 0 | 2 | 2 | 2 |
| jaccard | 0.9 | 0.403 | 0.493 | 0.917 | 0.965 | 1 | 0.843 | 0 | 0 | 0 | 1 |
| hybrid | 0.5 | 0.903 | 0.493 | 0.618 | 0.688 | 1 | 0.618 | 0 | 4875 | 229 | 79 |
| hybrid | 0.6 | 0.903 | 0.493 | 0.618 | 0.688 | 1 | 0.618 | 0 | 4875 | 229 | 79 |
| hybrid | 0.7 | 0.903 | 0.493 | 0.618 | 0.688 | 1 | 0.618 | 0 | 4875 | 229 | 79 |
| hybrid | 0.8 | 0.903 | 0.493 | 0.625 | 0.694 | 1 | 0.618 | 0 | 4826 | 229 | 79 |
| hybrid | 0.9 | 0.625 | 0.493 | 0.868 | 0.972 | 1 | 0.822 | 0 | 1769 | 225 | 30 |

## Key-matching oracle experiment — auto-ratification threshold sweep (2026-06-06)

Dataset: bench/datasets/longmemeval/longmemeval_oracle_target.json (oracle attribution). Claims: bench/datasets/longmemeval/longmemeval-oracle-claims.jsonl (model claude-sonnet-4-6, promptVersion lme-extract-v1). Ranking jaccard in all passes; scorer drives key-pair auto-ratification only (single-link components, canonical = most-claims then lexicographic). Bench-only experiment policy — the product keeps human/agent ratification; this curve is calibration evidence for a future auto-suggest dial. Spec: docs/superpowers/specs/2026-06-06-key-matching-oracle-experiment-design.md

| scorer | theta | KU_updateCorrect | KU_recall@1 | KU_recall@3 | KU_recall@10 | TR_correct | TR_recall@3 | ABS_correct | aliases | qAffected | maxComponent |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| — | baseline | 0.403 | 0.493 | 0.917 | 0.965 | 1 | 0.843 | 0 | 0 | 0 | 1 |
| jaccard | 0.92 | 0.403 | 0.493 | 0.917 | 0.965 | 1 | 0.843 | 0 | 0 | 0 | 1 |
| jaccard | 0.94 | 0.403 | 0.493 | 0.917 | 0.965 | 1 | 0.843 | 0 | 0 | 0 | 1 |
| jaccard | 0.96 | 0.403 | 0.493 | 0.917 | 0.965 | 1 | 0.843 | 0 | 0 | 0 | 1 |
| jaccard | 0.98 | 0.403 | 0.493 | 0.917 | 0.965 | 1 | 0.843 | 0 | 0 | 0 | 1 |
| hybrid | 0.92 | 0.556 | 0.493 | 0.896 | 0.965 | 1 | 0.839 | 0 | 1078 | 208 | 18 |
| hybrid | 0.94 | 0.486 | 0.493 | 0.896 | 0.965 | 1 | 0.843 | 0 | 494 | 173 | 8 |
| hybrid | 0.96 | 0.431 | 0.493 | 0.91 | 0.965 | 1 | 0.842 | 0 | 187 | 102 | 5 |
| hybrid | 0.98 | 0.417 | 0.493 | 0.917 | 0.965 | 1 | 0.843 | 0 | 51 | 37 | 2 |

### Sweep conclusions (2026-06-06)

1. Drift at oracle scale is SEMANTIC: jaccard merges nothing above theta 0.9 and moves no metric; all lift comes from the embedding scorer (bge-base cosine via hybrid-max).
2. Key matching recovers up to +22.2pp KU updateCorrect on real extraction drift (0.403 -> 0.625 at hybrid theta 0.90, recall@3 -4.9pp, recall@10 +0.7pp). Pairs-only merging (theta 0.98) is free: +1.4pp at zero recall cost. The degenerate mega-merge ceiling (0.903) shows ~90% of KU questions have the correct claim present - the failure mode is key identity, not retrieval.
3. No clean threshold exists (smooth precision/recall dial; maxComponent grows 2 -> 79 as theta drops). Empirical vindication of detect -> declare -> contest: blind auto-merge cannot capture the lift safely; a ratification loop over theta ~0.92-0.94 census candidates can. Auto-suggest dial calibration: SUGGEST at ~0.92, never auto-merge.
4. Discovered product bug en route: alias maps + scalar confidence + same-value drifted claims crash EVIDENCE_POOLED (dedupe is alias-blind). Fixed via DetectionOptions.evidencePoolingRule (default unchanged); MCP recall follow-up open.

## Key-matching oracle experiment — auto-ratification threshold sweep (2026-06-06)

Dataset: bench/datasets/longmemeval/longmemeval_oracle_target.json (oracle attribution). Claims: bench/datasets/longmemeval/longmemeval-oracle-claims.jsonl (model claude-sonnet-4-6, promptVersion lme-extract-v1). Ranking jaccard in all passes; scorer drives key-pair auto-ratification only (single-link components, canonical = most-claims then lexicographic). Bench-only experiment policy — the product keeps human/agent ratification; this curve is calibration evidence for a future auto-suggest dial. Spec: docs/superpowers/specs/2026-06-06-key-matching-oracle-experiment-design.md

| scorer | theta | KU_updateCorrect | KU_recall@1 | KU_recall@3 | KU_recall@10 | TR_correct | TR_recall@3 | ABS_correct | aliases | qAffected | maxComponent |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| — | baseline | 0.403 | 0.493 | 0.917 | 0.965 | 1 | 0.843 | 0 | 0 | 0 | 1 |
| jaccard | 0.92 | 0.403 | 0.493 | 0.917 | 0.965 | 1 | 0.843 | 0 | 0 | 0 | 1 |
| hybrid | 0.92 | 0.556 | 0.493 | 0.896 | 0.965 | 1 | 0.839 | 0 | 1078 | 208 | 18 |
| ratified | ratified | 0.528 | 0.493 | 0.903 | 0.965 | 1 | 0.83 | 0 | 380 | 161 | 7 |

### Ratified arm conclusions (2026-06-06)

Judge: claude-sonnet-4-6, ratify-v1, suggest band >=0.92 (1,192 unique census candidates, $~2.3). Approval rate 26.4% (315) - the judge rejects ~3 of 4 candidates in the band (e.g. "current sweetener" vs "sweetener issue" at 0.921: related topic, different attribute). Judgments artifact committed at bench/longmemeval/manual/data/key-ratify-judgments.jsonl for deterministic replay.

Ratified row: KU updateCorrect 0.403 -> 0.528 (+12.5pp, 1.31x baseline, 1.59x naive arm B) at -1.4pp recall@3 and unchanged recall@10, using 380 aliases (35% of blind-0.92 volume, maxComponent 7 vs 18). Per-alias lift efficiency 2.3x blind. Blind-0.92 scores higher updateCorrect (0.556) because false merges sometimes accidentally serve the newest claim - lift without precision; the ratified row is the honest, auditable number (every merge has a recorded reason).

Open lever: the suggest band only exposed >=0.92 to judgment; true drift below 0.92 remains unrecovered (ceiling 0.903). Widening the band (e.g. >=0.85) with the same judge is the next increment toward the ceiling.

### Capstone: production-loop replication (2026-06-06)

The ratified benchmark re-run through the LITERAL product surfaces (in-process MCP server, real SQLite db): every claim via `remember`, candidates via `key_census` (229/229 hybrid), 358 alias ratifications written as supersedable ledger claims via `remember`, every question recalled via `recall` (229/229 served - the scalar-pooling fix verified at scale), scored from the same db with alias maps derived from the ledger (recall internals).

RESULT: KU updateCorrect 0.528, recall@1/3/10 = 0.493/0.903/0.965 - byte-identical to the harness ratified row. The harness numbers ARE production numbers. Script: bench/longmemeval/manual/capstone-production-loop.ts (gate: --expect-update-correct fails loudly on divergence).

### Judge spot-check + validated-band configuration (2026-06-07)

Blind stratified human grading (50 pairs, founder-graded): judge agreement 100% in 0.96-0.98, 86% in 0.94-0.96, 75% in 0.98+ (n=8), but 36% in 0.92-0.94 - ALL 8 sampled approvals at the band floor graded DIFF. falseReject ~2 overall (lost-lift direction is small); falseAccepts concentrate at the floor.

Citable configuration = ratified restricted to human-validated bands (score >= 0.94, ~89% agreement): KU updateCorrect 0.403 -> 0.472 (+6.9pp, 1.42x naive) at -1.4pp recall@3, 225 aliases, maxComponent 4. The full-band 0.528 stands only with the floor-band caveat. The 0.92-0.94 band (+5.6pp) behaved like blind merging - lift without judgment precision; recovering it is a bounded judging problem (richer context / stricter prompt / 3-vote panel).

Artifacts: spot-check.ts (blind sheet + scorer), filled sheet, key-ratify-judgments-min094.jsonl.

### Capstone re-certification on the validated-band config (2026-06-07)

Production-loop re-run with key-ratify-judgments-min094.jsonl: KU updateCorrect 0.472, recall@1/3/10 = 0.493/0.903/0.965 - exact match with the harness validated-band row; hardening clean (0 conservation failures, 0 serving divergences). The CITABLE number now carries the same production certification as the full-band config.

## Key-matching oracle experiment — auto-ratification threshold sweep (2026-06-06)

Dataset: bench/datasets/longmemeval/longmemeval_oracle_target.json (oracle attribution). Claims: bench/datasets/longmemeval/longmemeval-oracle-claims.jsonl (model claude-sonnet-4-6, promptVersion lme-extract-v1). Ranking: hybrid (integrity baseline always jaccard); scorer drives key-pair auto-ratification only (single-link components, canonical = most-claims then lexicographic). Bench-only experiment policy — the product keeps human/agent ratification; this curve is calibration evidence for a future auto-suggest dial. Spec: docs/superpowers/specs/2026-06-06-key-matching-oracle-experiment-design.md

| scorer | theta | rank | KU_updateCorrect | KU_recall@1 | KU_recall@3 | KU_recall@10 | TR_correct | TR_recall@3 | ABS_correct | aliases | qAffected | maxComponent |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| — | baseline | jaccard | 0.403 | 0.493 | 0.917 | 0.965 | 1 | 0.843 | 0 | 0 | 0 | 1 |
| — | baseline | hybrid | 0.486 | 0.493 | 0.931 | 0.979 | 1 | 0.887 | 0 | 0 | 0 | 1 |
| jaccard | 0.92 | hybrid | 0.486 | 0.493 | 0.931 | 0.979 | 1 | 0.887 | 0 | 0 | 0 | 1 |
| hybrid | 0.92 | hybrid | 0.625 | 0.493 | 0.917 | 0.979 | 1 | 0.861 | 0 | 1080 | 209 | 18 |
| ratified | ratified | hybrid | 0.556 | 0.493 | 0.931 | 0.979 | 1 | 0.87 | 0 | 225 | 118 | 4 |

### Hybrid-ranking arm conclusions (2026-06-07)

Ranking was the frozen dial: every prior oracle cell ranked jaccard. Hybrid (bge) ranking ALONE lifts the no-alias baseline 0.403 -> 0.486 (+8.3pp) and improves recall@3 (+1.4pp), recall@10 (+1.4pp), TR recall@3 (+4.4pp) - no trade-off at oracle scale. STACKED with validated-band ratification: KU updateCorrect 0.556 (+15.3pp over baseline, 1.67x naive) with recall@3 0.931 ABOVE the original baseline - the old -1.4pp recall caveat is eliminated. Levers confirmed orthogonal (aliases choose survivors; ranking orders them). Production alignment: the MCP server already ranks hybrid, so this config is closer to production than the jaccard-ranked numbers were. recall@1 frozen at 0.493 across all 6 configs/both rankers - structural, noted. Abstention knobs still OFF (calibration is the next lever).

### Abstention calibration at oracle scale: NEGATIVE result, dial stays OFF (2026-06-07)

Per-question topScore under the citable config (ratified-min094 + hybrid ranking), deterministic 50/50 train/holdout split. Distributions OVERLAP (holdout answerable med 0.890 vs abstention med 0.842, ranges interleave). Best train threshold (0.862) on holdout: abstentionCorrect 0.545 but 16.7% FALSE abstentions on answerable (mostly TR @ 0.83-0.86) - net negative; no threshold wins. The manual-sample 0.872 "clean window" was N=20 luck; the protocol''s do-not-transfer warning vindicated at N=229. Conclusion: similarity topScore is not an abstention signal at scale - related-but-unanswerable claims score high. Abstention forwards to the bio layer (evidence-backed confidence) with measured justification. Bonus: q 07741c45 topScore -Inf (all evidence post-dates the question; tau excludes everything) - structural quirk noted.

### Abstention deep-dive: entity coverage beats every score threshold (2026-06-07)

Multi-signal study (6 signals x 2 directions, train/holdout): no score-derived signal nets positive (best: top1 @ 0.868 -> 7/11 caught but 20/96 false). Qualitative inspection revealed the structure: LME abstention questions are MISSING-ENTITY questions (Sacramento / Porsche / Tom absent) on well-covered TOPICS - invisible to similarity by construction. New signal entityCoverage (fraction of question entity-tokens present in surviving claim text): 5/11 caught at only 3/96 false (62.5% flag precision vs 26% for top1) - the first NET-POSITIVE abstention mechanism, compositional, no LLM, and EXPLAINABLE ("entity X has zero corpus support"). Residual class (entities present, attribute missing) remains the bio-confidence case. Product implication: coverage ANNOTATION on recall warnings (agent-in-the-loop refusal), not silent auto-abstention. Small-n caveat: 19/11 train/holdout abstentions - signal-quality evidence, not a production dial.

## Key-matching oracle experiment — auto-ratification threshold sweep (2026-06-06)

Dataset: bench/datasets/longmemeval/longmemeval_oracle_target.json (oracle attribution). Claims: bench/datasets/longmemeval/longmemeval-oracle-claims.jsonl (model claude-sonnet-4-6, promptVersion lme-extract-v1). Ranking: hybrid (integrity baseline always jaccard); scorer drives key-pair auto-ratification only (single-link components, canonical = most-claims then lexicographic). Bench-only experiment policy — the product keeps human/agent ratification; this curve is calibration evidence for a future auto-suggest dial. Spec: docs/superpowers/specs/2026-06-06-key-matching-oracle-experiment-design.md

| scorer | theta | rank | KU_updateCorrect | KU_recall@1 | KU_recall@3 | KU_recall@10 | TR_correct | TR_recall@3 | ABS_correct | aliases | qAffected | maxComponent |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| — | baseline | jaccard | 0.403 | 0.493 | 0.917 | 0.965 | 1 | 0.843 | 0 | 0 | 0 | 1 |
| — | baseline | hybrid | 0.486 | 0.493 | 0.931 | 0.979 | 1 | 0.887 | 0 | 0 | 0 | 1 |
| jaccard | 0.92 | hybrid | 0.486 | 0.493 | 0.931 | 0.979 | 1 | 0.887 | 0 | 0 | 0 | 1 |
| hybrid | 0.92 | hybrid | 0.625 | 0.493 | 0.917 | 0.979 | 1 | 0.861 | 0 | 1080 | 209 | 18 |
| ratified | ratified | hybrid | 0.556 | 0.493 | 0.931 | 0.979 | 1 | 0.87 | 0 | 225 | 118 | 4 |
| agent | agent-decides | hybrid | 0.556 | 0.486 | 0.924 | 0.972 | 0.937 | 0.821 | 0.367 | 225 | 118 | 4 |

### Agent-decides arm conclusions (2026-06-07)

Trivial simulated-agent policy (decline when coverage fraction < 0.75 over the canonical-pipeline survivors - the validated operating point): ABS_correct 0 -> 0.367 (11/30, each refusal citing its missing entity) at the cost of 9 false declines (8 TR, 1 KU; 4.5% of answerable). Raw counts net +2; decisively positive where declining-correctly outweighs answering (the compliance value function). KU updateCorrect unchanged at 0.556. This is the FLOOR of what coverage annotation enables - the trivial policy has no conversation context; a real agent consumes the same structured facts with more information. Headline config remains 0.556/0.931/ABS-0; agent-decides is the option row.

## Key-matching oracle experiment — auto-ratification threshold sweep (2026-06-06)

Dataset: bench/datasets/longmemeval/longmemeval_oracle_target.json (oracle attribution). Claims: bench/datasets/longmemeval/longmemeval-oracle-claims.jsonl (model claude-sonnet-4-6, promptVersion lme-extract-v1). Ranking: hybrid (integrity baseline always jaccard); scorer drives key-pair auto-ratification only (single-link components, canonical = most-claims then lexicographic). Bench-only experiment policy — the product keeps human/agent ratification; this curve is calibration evidence for a future auto-suggest dial. Spec: docs/superpowers/specs/2026-06-06-key-matching-oracle-experiment-design.md

| scorer | theta | rank | KU_updateCorrect | KU_recall@1 | KU_recall@3 | KU_recall@10 | TR_correct | TR_recall@3 | ABS_correct | aliases | qAffected | maxComponent |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| — | baseline | jaccard | 0.389 | 0.444 | 0.84 | 0.958 | 0.976 | 0.761 | 0 | 0 | 0 | 1 |
| — | baseline | hybrid | 0.431 | 0.479 | 0.944 | 0.979 | 1 | 0.854 | 0 | 0 | 0 | 1 |
| jaccard | 0.92 | hybrid | 0.431 | 0.479 | 0.944 | 0.979 | 1 | 0.854 | 0 | 0 | 0 | 1 |
| hybrid | 0.92 | hybrid | 0.569 | 0.486 | 0.903 | 0.972 | 1 | 0.823 | 0 | 7791 | 229 | 37 |
| ratified | ratified | hybrid | 0.5 | 0.479 | 0.924 | 0.972 | 1 | 0.836 | 0 | 1434 | 223 | 6 |

## Key-matching oracle experiment — auto-ratification threshold sweep (2026-06-06)

Dataset: bench/datasets/longmemeval/longmemeval_oracle_target.json (oracle attribution). Claims: bench/datasets/longmemeval/longmemeval-oracle-claims.jsonl (model claude-sonnet-4-6, promptVersion lme-extract-v1). Ranking: hybrid (integrity baseline always jaccard); scorer drives key-pair auto-ratification only (single-link components, canonical = most-claims then lexicographic). Bench-only experiment policy — the product keeps human/agent ratification; this curve is calibration evidence for a future auto-suggest dial. Spec: docs/superpowers/specs/2026-06-06-key-matching-oracle-experiment-design.md

| scorer | theta | rank | KU_updateCorrect | KU_recall@1 | KU_recall@3 | KU_recall@10 | TR_correct | TR_recall@3 | ABS_correct | aliases | qAffected | maxComponent |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| — | baseline | jaccard | 0.375 | 0.431 | 0.799 | 0.931 | 0.969 | 0.723 | 0 | 0 | 0 | 1 |
| — | baseline | hybrid | 0.444 | 0.479 | 0.91 | 0.972 | 1 | 0.817 | 0 | 0 | 0 | 1 |
| jaccard | 0.92 | hybrid | 0.444 | 0.479 | 0.91 | 0.972 | 1 | 0.817 | 0 | 2 | 1 | 2 |
| hybrid | 0.92 | hybrid | 0.569 | 0.486 | 0.868 | 0.951 | 1 | 0.817 | 0 | 15446 | 229 | 72 |
| ratified | ratified | hybrid | 0.5 | 0.479 | 0.889 | 0.958 | 1 | 0.805 | 0 | 2732 | 229 | 7 |

## Key-matching oracle experiment — auto-ratification threshold sweep (2026-06-06)

Dataset: bench/datasets/longmemeval/longmemeval_oracle_target.json (oracle attribution). Claims: bench/datasets/longmemeval/longmemeval-oracle-claims.jsonl (model claude-sonnet-4-6, promptVersion lme-extract-v1). Ranking: hybrid (integrity baseline always jaccard); scorer drives key-pair auto-ratification only (single-link components, canonical = most-claims then lexicographic). Bench-only experiment policy — the product keeps human/agent ratification; this curve is calibration evidence for a future auto-suggest dial. Spec: docs/superpowers/specs/2026-06-06-key-matching-oracle-experiment-design.md

| scorer | theta | rank | KU_updateCorrect | KU_recall@1 | KU_recall@3 | KU_recall@10 | TR_correct | TR_recall@3 | ABS_correct | aliases | qAffected | maxComponent |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| — | baseline | jaccard | 0.347 | 0.424 | 0.729 | 0.896 | 0.937 | 0.664 | 0 | 0 | 0 | 1 |
| — | baseline | hybrid | 0.403 | 0.465 | 0.896 | 0.972 | 0.976 | 0.766 | 0 | 0 | 0 | 1 |
| ratified | ratified | hybrid | 0.458 | 0.465 | 0.868 | 0.958 | 0.984 | 0.76 | 0 | 6480 | 229 | 9 |

---

## Bio efficacy oracle run (2026-06-07)

Protocol: docs/bio/2026-06-07-bio-efficacy-protocol.md. Dataset: bench/datasets/longmemeval/longmemeval_oracle_target.json (oracle attribution). Claims: bench/datasets/longmemeval/longmemeval-oracle-claims.jsonl. Ratified: bench/longmemeval/manual/data/key-ratify-judgments-min094.jsonl (201 approved pairs). Pseudocount sweep {2, 5, 10}. One shared EmbeddingCache + warmEmbeddings pass (bge-base, 3803 keys + 229 questions). 229 questions total: 30 abstention, 199 answerable.

**Harness invocation:**
```
npx tsx bench/longmemeval/manual/pooling-efficacy.ts \
  --file bench/datasets/longmemeval/longmemeval_oracle_target.json \
  --claims bench/datasets/longmemeval/longmemeval-oracle-claims.jsonl \
  --ratified bench/longmemeval/manual/data/key-ratify-judgments-min094.jsonl \
  --expect-update-correct 0.556 --expect-recall3 0.931 --expect-recall10 0.979
```

Harness exit code: 1 (P2 gate abort on KU updateCorrect mismatch — measured outcome, not instrument error).

### bio-efficacy: P0 (2026-06-07)

P0 property tests (vitest): 3/3 PASS. Command: `npx vitest run bench/longmemeval/manual/pooling-efficacy.test.ts`

### bio-efficacy: P1 cross-fit (2026-06-07)

Cross-fit P1 sweep table (pooled + baseline rows). All pooled and scalar signals are identical across all pseudocounts — pooled confidence carries no additional separation over the constant scalar baseline.

| pc | signal | TP | FP | precision | falseAbst | totalResidual | totalAnswerable | underpowered |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | pooled | 19 | 198 | 0.088 | 198 | 19 | 199 | - |
| 2 | scalar/MAX_MEAN | 19 | 198 | 0.088 | 198 | 19 | 199 | - |
| 5 | pooled | 19 | 198 | 0.088 | 198 | 19 | 199 | - |
| 5 | scalar/MAX_MEAN | 19 | 198 | 0.088 | 198 | 19 | 199 | - |
| 10 | pooled | 19 | 198 | 0.088 | 198 | 19 | 199 | - |
| 10 | scalar/MAX_MEAN | 19 | 198 | 0.088 | 198 | 19 | 199 | - |

Gates checked (pc=2, held-out pooled): precision 0.088 << 62.5%; falseAbst 198/199 = 99.5% >> 5% ceiling; pooled TP == scalar TP (no strict dominance). All three conditions fail.

### bio-efficacy: P2 headline (2026-06-07)

P2 metrics at pc=2 (citable cell, EVIDENCE_POOLED + hybrid ranking + ratified-min094 aliases):

| pc | metric | value |
| --- | --- | --- |
| 2 | KU updateCorrect | 0.542 |
| 2 | recall@3 | 0.931 |
| 2 | recall@10 | 0.979 |

KU updateCorrect 0.542 ≠ registered 0.556 (GATE FAIL). recall@3 0.931 = registered 0.931 (PASS). recall@10 0.979 = registered 0.979 (PASS). Cause not investigated in this run; see the protocol's registered expectation for candidate mechanisms (⊕_dedupe/confidence-threshold side effects of promotion).

### bio-efficacy: dial sweep (2026-06-07)

Pseudocount sweep {2, 5, 10}: pooled signal is identical to scalar at all three sweep points. P1 counts (TP/FP/precision) are invariant across pseudocounts. No movement with pseudocount magnitude.

### bio-efficacy: arm D (2026-06-07)

Arm D (dream-ratification baseline pin) harness motion is declared out of scope in the protocol ("Arm-D harness motion (deferred until bio attaches)"). No capstone run through bio's gateway/ledger was executed.

## Drift-injection arm (2026-06-17) — oracle 229q, jaccard, oracle alias map

Injects synthetic key drift into the oracle claims-file, runs arm A WITH vs WITHOUT the ground-truth (oracle) variant→canonical map. Baseline gate reproduced KU updateCorrect 0.403 ✓. Knobs off; evidencePoolingRule=MAX_MEAN (scalar-safe).

| fraction | mode | aliased | updateCorrect | recall@1 | recall@3 | n |
|---|---|---|---|---|---|---|
| 0    | judged | off | 0.403 | 0.493 | 0.917 | 72 |
| 0    | judged | on  | 0.403 | 0.493 | 0.917 | 72 |
| 0.1  | judged | off | 0.403 | 0.493 | 0.917 | 72 |
| 0.1  | judged | on  | 0.417 | 0.493 | 0.917 | 72 |
| 0.25 | judged | off | 0.389 | 0.493 | 0.910 | 72 |
| 0.25 | judged | on  | 0.403 | 0.493 | 0.910 | 72 |
| 0.5  | judged | off | 0.417 | 0.493 | 0.917 | 72 |
| 0.5  | judged | on  | 0.431 | 0.493 | 0.917 | 72 |
| 0.75 | judged | off | 0.472 | 0.493 | 0.910 | 72 |
| 0.75 | judged | on  | 0.486 | 0.493 | 0.910 | 72 |
| 1    | judged | off | 0.500 | 0.493 | 0.917 | 72 |
| 1    | judged | on  | 0.514 | 0.493 | 0.910 | 72 |
| 0.1  | morph  | off | 0.375 | 0.493 | 0.917 | 72 |
| 0.1  | morph  | on  | 0.389 | 0.493 | 0.917 | 72 |
| 0.25 | morph  | off | 0.389 | 0.493 | 0.924 | 72 |
| 0.25 | morph  | on  | 0.389 | 0.493 | 0.917 | 72 |
| 0.5  | morph  | off | 0.361 | 0.493 | 0.931 | 72 |
| 0.5  | morph  | on  | 0.361 | 0.493 | 0.931 | 72 |
| 0.75 | morph  | off | 0.347 | 0.493 | 0.931 | 72 |
| 0.75 | morph  | on  | 0.347 | 0.493 | 0.931 | 72 |
| 1    | morph  | off | 0.347 | 0.493 | 0.931 | 72 |
| 1    | morph  | on  | 0.347 | 0.493 | 0.931 | 72 |

judged coverage: 202 of 3802 single-value keys had a judged variant (5.3%).

**Result = near-null.** Aliasing benefit (on−off) ≈ +0.014 = exactly 1/72 (one KU question) in judged, 0 in morph. recall@1 flat at 0.493 everywhere. NOT the predicted "off declines, on flat at baseline" wedge.

**Diagnosis (see memory drift-injection-null-result):** primarily an INSTRUMENT issue, surfacing one real substrate-surface truth.
1. `updateCorrect` is RANKING-dominated: it reads top-1 of a jaccard-ranked list, and the claim KEY feeds the ranker. Drift mangles the ranked text, not just the ⊥ contest. The resolver still deprecates the stale claim, but the metric reads the ranked top-1 → morph (gibberish keys) shows zero lift because aliasing fixes ⊥ but not the ranking damage.
2. The oracle map covers only INJECTED drift, not the pre-existing real drift in the baseline (which the recorded +12.5pp ratified arm DID alias) → on≈off at f=0, small delta everywhere.
3. judged coverage only 5.3% → tiny surface.
4. Random per-claim injection doesn't target the NEWEST claim of a lineage, so it rarely creates the "latest fragments away → stale wins" condition updateCorrect punishes → off-curve even RISES in judged.

**Real substrate-surface truth exposed:** resolution wins are gated by the ranking/retrieval layer. A correctly-resolved claim under a drifted key may not rank into top-k, so key-aliasing's served-answer value is bounded by whether the resolved claim also ranks. Resolution and retrieval must both succeed.

## Drift arm — resolution-vs-served (2026-06-17) — oracle 229q, jaccard

Adds a ranking-free resolution view (`resolveOnly`) + KU-only metrics over the ≥2-answer-session subset (nRes=72). Key columns: staleDeprec, recencyTop1 (control), fragLineages.

**fragLineages is healthy** (drift DID create the condition): judged 0→16→30→40→39→30; morph 0→25→40→52→56→57 over f={0,.1,.25,.5,.75,1}. So the f>0 region is valid.

**Two findings:**

1. **staleDeprec is mis-defined → uninformative (≈0.014 = 1/72 everywhere, off=on, all f).** It requires COMPLETE collapse: zero surviving claims from any non-latest answer session. But oracle KU corpora contain multiple DISTINCT attributes across sessions (employer, city, …); non-contesting older-session claims about *other* attributes legitimately survive, so "total collapse" is almost never true and aliasing can't move it. The answer-session-membership lineage proxy is too coarse — it needs the gold (subject,key) of the evolving fact, which LongMemEval doesn't provide. Lesson: don't proxy a single-fact lineage by whole-question session membership.

2. **THE REAL FINDING — recencyTop1 ≈ 0.972 vs updateCorrect ≈ 0.40–0.50.** recencyTop1 (the rank-free analog of updateCorrect: is the most-recent *resolved survivor* on the latest answer session?) is ~0.97, while jaccard-ranked updateCorrect is ~0.45. Same proxy, different ordering. The gap ≈ **50 percentage points** is the ranking-method tax: **for knowledge-update queries, picking the most-recent resolved claim answers ~97% of the time; jaccard ranking of the same resolved set throws that away to ~45%.** (recencyTop1's height is partly structural — max valid.from ↔ latest-dated session — so treat it as a near-oracle upper bound, not a correctness claim; the *comparison* to updateCorrect is the valid signal.) Aliasing on−off remains ~0 (≈1 question) — confirmed, not the lever.

**Conclusion:** the resolution substrate is not the bottleneck for KU; the **served read's ranking method is.** The dominant lever is recency-aware reading (or τ-aware ranking) on the resolved set, dwarfing key-aliasing (~1 question). Confirms [[mneme-open-deficiency-board]] "ranking residue = next lever" — at ~50pp, far larger than expected. The drift-injection/aliasing line of inquiry is a dead end for KU served accuracy; the ranking-method line is wide open.

## Recency-aware ranking GATE (2026-06-17) — oracle 229q, α×half-life, all categories

Holds the resolved survivor set fixed; re-ranks with rankBlend = α·jaccard + (1−α)·exp(−λ·age). Identity gate PASSED: α=1 KU updateCorrect 0.403, top-1 identical to arm A on all 229 questions ✓ (rig sound).

**KU updateCorrect dose-response (α: 1→0):** 0.403 → 0.736/0.694/0.625 (α.75, hl 30/90/365) → 0.833/0.778/0.694 (α.5) → 0.931/0.833/0.778 (α.25) → **0.972 (α=0, pure recency).** Verdict block: **WIN in EVERY blend cell** (ΔKU>0, ΔTR=0). → OUTCOME A: recency-aware ranking is the lever, DETERMINISTIC, NO intent-routing needed.

**Honest caveats (read the recall columns, not just the verdict):**
1. **TR `temporalCorrect` is saturated at 1.0 everywhere → a USELESS guardrail.** ΔTR=0 is "no regression" only because TR's headline metric is non-discriminating on oracle (prior note). The verdict's TR check under-counts the cost.
2. **The real cost is in recall@k, which DEGRADES with recency** (broad evidence coverage traded for single-latest-fact). recall@10: KU 0.965→0.611, TR 0.975→0.647, abstention 0.972→0.664 as α→0. Pure recency (α=0) floods top-k with newest claims, evicting older relevant evidence. recall@1 stays flat (top-1 is always SOME evidence session in oracle mode).
3. So **pure recency is too aggressive.** A BLEND is the sweet spot: e.g. α=0.5/hl=90 nearly doubles KU (0.403→0.778) while keeping recall@10 at 0.792 (vs 0.611 at α=0). The α dial trades KU-vs-recall; tune it, don't go to 0.

**Conclusion:** OUTCOME A confirmed — recency-aware reading lifts KU served accuracy from 0.403 toward ~0.97, deterministically, on-wedge (uses valid.from, the substrate's bitemporal signal), with NO intent classifier. Pick a blended α (≈0.25–0.5) to balance KU gain against evidence recall. Next checkpoints (spec §7): (a) REAL-answer correctness to defeat the updateCorrect session-proxy circularity; (b) then a src-promotion cycle (new metadata-aware ranking operator + rankedTailStages dial + MCP recall option). The drift/key-aliasing line is dead for KU; recency-aware ranking is the live lever.

## Real-answer confirmation (2026-06-18) — oracle 199q (KU 72, TR 127), sonnet LLM judge

Defeats the updateCorrect session-proxy: an LLM judge (claude-sonnet-4-6) decides whether the served top-5 context (resolveOnly + rankBlend) CONTAINS/SUPPORTS the gold answer. answerInContext per (alpha cell, category) vs the alpha=1 (jaccard) baseline; ~796 judgments cached (bench/longmemeval/manual/data/answer-judgments.jsonl).

| alpha (hl=90d) | KU answerInContext | TR answerInContext | verdict |
|---|---|---|---|
| 1 (jaccard baseline) | 0.472 | 0.378 | — |
| 0.5 | 0.528 (+0.056) | 0.378 (±0) | **CONFIRMED** |
| 0.25 | 0.583 (+0.111) | 0.291 (−0.087) | REFUTED-TR |
| 0 (pure recency) | 0.583 (+0.111) | 0.110 (−0.268) | REFUTED-TR |

**CONFIRMED at alpha=0.5/90d — the recency win is REAL on actual answers, not a proxy artifact.** Moderate recency lifts KU answerInContext 0.472→0.528 (+5.6pp, +11.9% rel) with TR EXACTLY flat (48/127 both) — a Pareto-safe blend. This is the honest counterpart to the gate's updateCorrect 0.403→0.972 (the proxy over-stated the magnitude; real-answer lift is +5.6pp, but it is REAL and TR-safe).

**The dial is load-bearing:** alpha=0.25 and alpha=0 push KU higher (0.583) but crater TR (−8.7pp, −26.8pp) — pure/heavy recency evicts the time-scoped evidence TR needs. So the sweet spot is alpha≈0.5, NOT pure recency (sharpens the earlier "~0.25–0.5" caveat to ~0.5).

**Fork (spec §7): CONFIRMED → src-promotion cycle.** A metadata-aware ranking operator in src/algebra + a rankedTailStages dial + an MCP recall recency option, default tuned to alpha=0.5/halfLife=90d. Caveat: verdict rests on sonnet judgments; the ~50-pair human spot-check (judge-error bound) is still pending and should run before treating CONFIRMED as final.
