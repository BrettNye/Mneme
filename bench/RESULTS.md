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
