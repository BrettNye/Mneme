# Mneme dogfood window-end review — 2026-06-22

**Protocol:** `docs/dogfood/2026-06-06-dogfood-protocol.md`
**Window:** merge 2026-06-06 → end 2026-06-22 (16 days)
**Evidence pulled from:** `~/.mneme/knowledge.db` (claims + claim_events), `~/.mneme/recall-log.jsonl` (72 lines), live `recall` / `key_census` against the connected MCP server.

---

## Headline numbers

| Metric | Value |
|---|---|
| Total recalls (all corpora) | 72 |
| — knowledge / crewtracks-modules / adv-payroll | 40 / 13 / 19 |
| `rankFn` = hybrid | **72 / 72** (zero jaccard fallback) |
| `abstained` = true | **0 / 72** (knobs off by design) |
| Total claims in `knowledge` | 122 (122 claim_events) |
| Distinct keys in `knowledge` | 63 |
| Active corpora | knowledge (primary), adv-payroll, crewtracks-modules, smoke-test-a/b |

---

## Q1 — Supersession value: **YES (strong, live-confirmed)**

- **17** `(subject, key)` groups in `knowledge` carry more than one claim.
- **0** stored deprecation events — every `claim_events.deprecated_id` is null. Resolution is **read-time** via `resolveDeprecateOlder` on `valid_from`, exactly as [[mneme-recall-resolves-raw-accretes]] describes: the leaf accretes every write; `recall` collapses to latest-per-`(subject,key)`.
- Deepest live chains:
  - `project:mneme | benchmark-oracle` — **6** progressive states (oracle-run → sweep → capstone → judge-spot-check → sealed → +ranking-lever).
  - `project:agora | v1-hardening.program-status` — **5** states.
  - `project:agora | testing.orchestrator-suite.load-timeout-flake` — **4** states.
- **Live confirmation:** `recall(project:mneme, "oracle benchmark citable config")` served **only the latest** `benchmark-oracle` state (the 0.556 ratified+hybrid config) and suppressed all five earlier ones. A naive "return all matching claims" would have surfaced six contradictory magnitudes (0.403 / 0.472 / 0.528 / 0.556…) in one answer — genuinely confusing. The algebra served the right fact.

**Verdict:** the supersession hypothesis is confirmed on real, naturally-accumulated dogfood data, not a constructed fixture.

## Q2 — Key drift: **NO true drift; proliferation pressure is real**

- 63 keys, **every one a singleton** (1 claim/key) — the proliferation signature, not the synonym-collision signature Q2 set out to catch.
- Top `key_census` candidate pairs are high-similarity but **semantically distinct**, i.e. deliberate, not drift:
  - `benchmark` ↔ `benchmark-oracle` (0.946) — distinct: corpus import vs LME oracle arc.
  - `key-census-baseline` ↔ `key-census-midpoint` (0.924) — intentional two snapshots.
  - `finding-corpus-model` ↔ `finding-corpus-isolation` (0.923) — two different findings.
- **0** ratified aliases, **0** unratified self-aliases, **0** warnings. The mid-window decision (recorded in-corpus, 2026-06-12) was to **not** ratify during the window — ratifying mutates served recall on the measured corpus (Q2 contamination) and used to trip the alias-blind scalar-pooling crash (since fixed, `evidencePoolingRule: MAX_MEAN`).
- No `editor` / `preferred_editor`-style synonym drift ever appeared under single-author natural use.

**Recommendation:** key-matching slice = **needed eventually, not urgent**. The live risk is key *proliferation* (singletons), which `key_census` already surfaces — the contest machinery has no drift to bite on yet. Ratification of the genuine-merge pairs can now happen post-window (crash fix is in).

## Q3 — Abstention calibration: **performed → KEEP KNOBS OFF**

- 65 `topScore` values (7 recalls had `matchCount` 0 and no topScore). Range **0.831 – 0.941** — a dense, smooth, high cluster with **no natural separation point**.
- The benchmark's **0.872 sits in the middle** of this distribution: ~half the useful interactive recalls fall below it. Setting `abstainBelowTop = 0.872` would have falsely refused roughly half of them. This is the protocol's "0.872 is NOT transferable" warning confirmed by observed data — interactive attribute-lookup queries compress into a higher, tighter band than LME question-style queries.
- The 7 zero-match recalls already return empty without any threshold; there is no useful/not-useful boundary to exploit.

**Dial decision:** `abstainBelowTop = 0`, `relevanceFloor = 0` — **stay off**. No separation point exists; a threshold would only cost recall.

## Q4 — Friction: **low; habit took**

- `rankFn` = hybrid on **72/72** recalls → the embedding model loaded on every call across the window; warm-up latency was a non-issue (the `node --import tsx` launch fix from [[mcp-npx-handshake-timeout]] held).
- Explicit-write was ergonomically fine: 122 `knowledge` writes accumulated naturally, plus adv-payroll/crewtracks activity. No instances of skipping a write because `remember` felt onerous.
- Subjective rating: **5 — would use without prompting** (the dogfood habit stuck; this review itself runs entirely off accumulated passive artifacts).

---

## Decisions out of this window

1. **Knobs stay at 0** (abstainBelowTop, relevanceFloor). No re-calibration until a query population with an actual separation point appears.
2. **Supersession wedge is validated in production use** — cite the live `benchmark-oracle` 6-chain as the dogfood proof point (read-time resolution, no stored deprecation, serves latest).
3. **Key-matching slice de-prioritized** to "eventually": no synonym drift under natural single-author use; proliferation is the real (and already-instrumented) risk. Post-window alias ratification of the genuine-merge census pairs is now unblocked (scalar-pooling crash fixed).
4. **Dogfood habit continues** unprompted — no formal second window needed; `key_census` + recall-log remain the passive instruments.
