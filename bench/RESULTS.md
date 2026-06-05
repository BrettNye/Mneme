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
