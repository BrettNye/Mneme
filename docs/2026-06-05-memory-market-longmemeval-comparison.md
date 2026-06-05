# Memory-system market comparison: Mneme vs published LongMemEval results

**Date:** 2026-06-05 (post detection-composition slice, PR #20 / main `496a131`)
**Purpose:** positioning context — where Mneme's bench results sit relative to commercial/OSS memory systems, and what can/cannot be honestly compared. Pairs with `bench/RESULTS.md` (note: RESULTS.md's recorded LME numbers are from the original extraction; current committed data is the re-extraction — see the apples-to-apples table below).

## TL;DR

- Every vendor publishes **end-to-end QA accuracy** (answer LLM + LLM judge, full 500-question LongMemEval-S, ~115k-token haystacks). Mneme's numbers are **retrieval-layer metrics** (no LLM anywhere) on a **20-question manually-extracted subset**. Different metric species — direct number-vs-number comparison is invalid.
- Mneme's differentiated claim has **no published counterpart**: `updateCorrect 1.0 vs 0.3` shows the **retrieval layer alone** resolving conversational supersession — deterministically, auditable, LLM-free — where plain similarity recall fails 70% of the time. Vendor knowledge-update numbers (Zep 83.3%, Mem0 98.2%) are QA-level: a GPT-4o answerer can rescue retrieval that surfaces both stale and fresh facts (especially at Mem0's top-k=200).
- The vendors' own numbers are at war: the same system (Zep on LOCOMO) spans **58.44 → 65.99 → 75.14** depending on who configures and counts. Conditions matter more than headlines.

## "Hermes"

Nous Research's **Hermes Agent** has no single memory solution — built-in file memory plus **8 pluggable providers**: Honcho, OpenViking, **Mem0**, **Hindsight**, Holographic, RetainDB, ByteRover, Supermemory ([docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers)). The two with prominent published LongMemEval numbers are Mem0 and Hindsight.

## Published scoreboard (with conditions — the conditions ARE the story)

| System | Benchmark | Headline | Knowledge-update | Temporal | Conditions |
|---|---|---|---|---|---|
| Full-context GPT-4o (no memory) | LongMemEval-S | 60.2% | 78.2% | 45.1% | 115k tokens in context; GPT-4o judge ([Zep paper](https://arxiv.org/abs/2501.13956)) |
| **Zep** (temporal KG / Graphiti) | LongMemEval-S | 71.2% (gpt-4o) | 83.3% | 62.4% | top-20 facts ≈ 1.6k tokens; GPT-4o answer+judge; note single-session-assistant REGRESSED 94.6→80.4 |
| **Mem0 v3** (managed cloud, self-reported) | LongMemEval | 94.4% | 98.2% | 76.7% | **top-k=200**; GPT-4o answers AND judges; vendor harness ([mem0.ai/research](https://mem0.ai/research)); paper config on LOCOMO scored *below* full-context |
| **Hindsight** (Vectorize) | LongMemEval-S | 91.4% (Gemini-3) / 89.0% | 92.3% | 85.7% | **GPT-OSS-120B judge** (not GPT-4o → not directly comparable to Zep) ([paper](https://arxiv.org/abs/2512.12818)) |
| **Letta/MemGPT** | — | none published | — | — | Their position: these benchmarks measure the harness, not the memory; a Letta agent storing history in plain files beat Mem0-graph on LOCOMO (74.0 vs 68.5, gpt-4o-mini) |
| Original LongMemEval paper | LongMemEval-S | GPT-4o 0.870 oracle → 0.606 haystack | — | best retrieval config ≈ 0.722 Recall@5 (temporal) | the ONLY source publishing retrieval-layer Recall@k/NDCG@k ([arXiv:2410.10813](https://arxiv.org/abs/2410.10813)) |

**Mem0 ↔ Zep dispute** (why headline numbers can't be trusted naked): Mem0's paper scored Zep 65.99 on LOCOMO; Zep's rebuttal ([blog](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/)) alleges misconfiguration and re-runs at 75.14 — also showing plain full-context (~73%) beating Mem0 (~68%); Mem0's CTO countered ([getzep/zep-papers#5](https://github.com/getzep/zep-papers/issues/5)) that Zep's later "84%" LOCOMO claim used an inconsistent denominator, computing 58.44. LOCOMO itself is criticized (16–26k-token conversations, ground-truth errors, no knowledge-update category).

## Mneme's current numbers (for reference)

Manual-extraction real-data subset: 20 questions (10 KU / 5 temporal / 5 abstention), 188 hand-extracted claims, committed at `bench/longmemeval/manual/data/`. Retrieval-layer metrics, no answer LLM, no judge. Post detection-composition slice (apples-to-apples vs pre-slice code on identical data):

| Metric | A pre | A post | B (plain recall) |
|---|---|---|---|
| KU updateCorrect | 1.0 | 1.0 | **0.3** |
| KU recall@3 / @10 | 0.7 / 0.95 | 0.75 / **1.0** | 1.0 / 1.0 |
| temporalCorrect (oracle mode) | 1.0 | 1.0 | 1.0 |
| abstentionCorrect | 0 | 0 | 0 |

Known residue: KU recall@3 gap vs B is the deliberate supersession-vs-evidence-coverage trade plus `rho.jaccard` ranking (gold old-session sibling claims rank 4–9); the ranking part is the embedding/similarity slice's target. Abstention needs a relevance threshold (recall-surface).

## What can and cannot be compared

1. **`updateCorrect` — no counterpart, and that's the point.** Stricter claim than any vendor's KU accuracy: the algebra resolves updates *before* any LLM sees the context, deterministically, with replayable provenance. Fair sentence: *"plain similarity recall gets conversational supersession wrong 70% of the time; Mneme resolves it at the retrieval layer without an LLM in the loop."* NOT: "we beat Zep's 83%."
2. **recall@k** — same metric family as the original paper's retrieval-analysis section only. Comparable in kind, not population: theirs = 500 questions over full 115k-token haystacks (the distractor problem is what everyone is measured on); ours = curated subset that doesn't exercise it.
3. **Temporal 1.0 (oracle mode)** — analogous to the paper's oracle condition (GPT-4o 0.870 incl. answer model); says nothing about haystack retrieval.
4. **Abstention** — only the original paper measures it; no vendor reports it; our honest 0 is at least measured.

## What an apples-to-apples leaderboard entry would require

(a) full LongMemEval-S 500 questions; (b) full ~115k-token haystack ingestion; (c) frozen answer model + standard GPT-4o judge on top; (d) reported retrieval k + tokens-in-context (Mem0@k=200 vs Zep@20-facts are different operating points); (e) judge disclosure. Cost: ~$10 oracle / ~$110 full haystack (see `lme-bench-status` memory — currently credit-blocked, optional). Structural note for then: Zep's win is largely context compression (1.6k vs 115k tokens); Mneme's pipeline output is similarly compact *and* carries deterministic supersession — competitive story before any end-to-end number exists.

## Strategic read

The market litigates QA-accuracy headlines under incomparable harnesses. Mneme's defensible wedge is the layer nobody else measures: **deterministic, auditable, LLM-free update resolution at retrieval time** (plus replayable derivation provenance). Sequencing stays per the standing decision: dogfood via MCP on un-curated data first (where the floor/dedupe insurance shipped in PR #20 starts to matter), funded full-haystack benchmark later if/when the leaderboard number is worth $110.

### The epistemic-substrate framing (founder-ratified, 2026-06-05)

LLM **ingestion** is universal across the market — table stakes, not a differentiator. What varies is **where the epistemic decisions get made**: Mem0's LLM issues ADD/UPDATE/DELETE at write time (destructive, on an LLM's judgment); Zep's LLM detects contradictions at write, temporal metadata invalidates; vector RAG resolves nothing and pushes the mess to the answer model; Letta's agent re-judges at every read. **Mneme is alone in doing it with a deterministic, non-destructive, replayable algebra — wrong resolution policy? Re-derive under a different rule; the claims were never destroyed. Mem0 can't un-DELETE what its LLM overwrote six months ago.** This is the reason the system exists.

Sharpened hypothesis for all evaluation work: *given that everyone pays the LLM-ingestion tax, does a deterministic claims algebra beat LLM/vector heuristics for the downstream epistemic operations — at equal or better quality, with auditability and replayability the heuristics structurally cannot offer?* Keep the two value claims separate: accuracy benchmarks can test the first clause; the auditability/replay clause is demonstrated (dogfood, governance/RaState story), never benchmarked — no published metric rewards it.

## Sources

[LongMemEval paper](https://arxiv.org/abs/2410.10813) · [Zep paper](https://arxiv.org/abs/2501.13956) · [Mem0 paper](https://arxiv.org/abs/2504.19413) · [Mem0 research page](https://mem0.ai/research) · [mem0ai/memory-benchmarks](https://github.com/mem0ai/memory-benchmarks) · [Zep rebuttal](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/) · [Mem0 issue vs Zep](https://github.com/getzep/zep-papers/issues/5) · [Letta blog](https://www.letta.com/blog/benchmarking-ai-agent-memory) · [Hindsight paper](https://arxiv.org/abs/2512.12818) · [Hermes Agent memory providers](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers)
