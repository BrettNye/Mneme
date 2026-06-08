# Mneme dogfood protocol — 2026-06-06

**Status:** Pre-registered experiment design (pre-merge)
**Window:** 2 weeks from merge date
**Derived from:** `docs/superpowers/specs/2026-06-06-mcp-dogfood-upgrade-design.md` §8

> **Amendment 2026-06-07 (observation-only):** the recall-log line schema was additively extended with `missingCount`, `missing` (coverage entity strings with no claim available), `warningCount`, and the `subject`/`key` filter args the call used. Logging-only — `remember`/`recall` semantics, ranking, and coverage computation are unchanged, so the Q1–Q4 measured behavior is not altered. Pre-extension lines remain valid (new fields are optional). Precedent: the corpus-model amendment below.

---

## 1. Window and scope

- **Duration:** 2 weeks from the day the mcp/dogfood-upgrade-exec branch merges to main.
- **Corpora:** single `knowledge` corpus at `~/.mneme/knowledge.db`, with `subject` as the namespace (`project:<repo-basename>` for project facts, `user` for cross-project preferences). *Amended 2026-06-06: this doc originally said one corpus per repo, but that contradicted the ratified 2026-05-31 decision (corpus = tenant boundary, not per-repo/per-topic) and the live MCP config. Single-corpus governs the window.*
- **Write discipline:** explicit-write only. Do NOT auto-dump conversation transcripts. Store durable decisions, preferences, and facts — things that would still matter in a future session. See the memory-instruction block below.

---

## 2. Memory-instruction block (copy-paste ready)

Paste this into a project-level `.claude/memory/MEMORY.md` or a custom instructions file when the mneme MCP server is connected:

```
## Mneme memory (mneme MCP server)

When the mneme MCP server is connected to this session:

### Storing facts
Use `remember` to store durable decisions, preferences, architectural facts, or user-stated preferences that would still matter in a future session.

Subject / key conventions:
- subject: "project:<repo-basename>" for project facts (e.g. "project:Mneme", "project:agora")
- subject: "user" for cross-project user preferences (e.g. editor, style, workflow)
- key: the attribute name — use a stable, lowercase, underscore-separated identifier (e.g. "preferred_editor", "test_framework", "deployment_target")
- scope: use when the referent is ambiguous — e.g. { "context": "mcp" } to distinguish an MCP-specific decision from the same key in a different context
- validFrom: supply an ISO timestamp when backdating a fact that was decided before this session (ensures supersession ordering is honest)

Store facts like:
  remember({ subject: "project:Mneme", key: "embedding_model", value: "Xenova/bge-base-en-v1.5" })
  remember({ subject: "user", key: "preferred_editor", value: "VS Code", scope: { context: "local" } })

### Recalling facts
Use `recall` when prior context would help — e.g. before proposing a config value, ask if a preference is already stored; before repeating an architectural decision, check if it was recorded.

  recall({ subject: "project:Mneme", about: "embedding model choice" })
  recall({ subject: "user", about: "editor preference" })

### What NOT to store
- Conversation summaries or transcripts
- Temporary values, intermediate reasoning, or in-progress drafts
- Facts that are already in source files or commit history
- Anything you would not want to surface verbatim in a future session
```

---

## 3. Falsification questions Q1–Q4

All four questions are pre-registered before the window opens to prevent post-hoc rationalization.

### Q1 — Supersession value

**Hypothesis:** the algebra serves the right fact in cases where plain recall (no temporal resolution) would return a stale or ambiguous value.

**Evidence source:**
- `.mneme/recall-log.jsonl` — each recall line records `{ ts, corpus, about, topScore, matchCount, abstained, rankFn }` (additively extended 2026-06-07, see amendment below).
- `claim_events` table in `.mneme/store.db` — write-event log with timestamps; same `(subject, key)` written more than once indicates a supersession candidate.

**Check procedure:**
1. Query `claim_events` for `(subject, key)` pairs that have more than one write event:
   ```sql
   SELECT subject, key, COUNT(*) AS writes
   FROM claim_events
   GROUP BY subject, key
   HAVING writes > 1
   ORDER BY writes DESC;
   ```
2. For each multi-write pair, replay: what would a naive "return all matching claims" have returned vs. what `resolveDeprecateOlder` returned?
3. Cross-reference with the recall-log: find entries whose `about` semantically matches that `(subject, key)`. Did the session behave correctly?
4. Record at least one positive instance (algebra returned newer fact, stale would have confused) OR declare "no supersession candidate arose" if no key was written twice.

### Q2 — Key drift

**Hypothesis:** inconsistent key naming (e.g. storing `editor` and `preferred_editor` for the same semantic) silently bypasses `⊥` (contradiction detection) because the claims never contest.

**Evidence source:**
- Key census from each corpus: `SELECT DISTINCT key FROM claims ORDER BY key;` against `.mneme/store.db`.

**Check procedure:**
1. At the midpoint of the window and at the end, run the key census query per active corpus.
2. Group keys by apparent semantic intent. Look for near-duplicates (e.g. `editor` / `preferred_editor` / `default_editor`; `test_runner` / `test_framework`).
3. If near-duplicates exist, determine whether both were written by the same agent (key drift) or deliberately distinct (acceptable). Record findings in §5 of the review template below.
4. Near-duplicates found = evidence for the key-matching slice (future work); record count and examples.

### Q3 — Abstention calibration

**Hypothesis:** once `abstainBelowTop` is set from observed data, it correctly refuses low-confidence recalls without falsely refusing useful ones.

**Pre-condition:** knobs start at 0 (off) for the first window; calibration happens mid-window or at end.

**Evidence source:**
- `.mneme/recall-log.jsonl` — the `topScore` field per recall.

**Calibration procedure (after >= 20 recalls):**
1. Parse the recall-log and extract `topScore` for every non-abstained entry.
2. Split entries into "found-useful" vs "not-useful" (manual annotation — note in a separate scratch file or inline in the review template).
3. Plot or list the percentile distribution of `topScore` for each group.
4. Choose `abstainBelowTop` at the natural separation point (if one exists). Flip it on in the MCP session. Record the chosen value.
5. After flipping on, note: any correct refusals (the model would have cited a weak match)? Any false refusals (the model was blocked from a fact it needed)?

**Default reminder:** both knobs default to 0 (off). The benchmark's 0.872 threshold is calibrated for `bge-base` + question-style LME queries. Interactive queries may distribute differently — do NOT transfer that value without observing your own distribution first.

### Q4 — Friction

**Hypothesis:** explicit-write is ergonomically usable and first-recall warm-up latency is tolerable.

**Evidence source:**
- Session notes (inline in the review template).
- `rankFn` field in recall results: `"hybrid"` = model loaded; `"jaccard"` = fallback (model not available or load failed).

**Check procedure:**
1. Note any session where calling `remember` felt onerous or was skipped in favor of not storing. Record why.
2. Note the warm-up latency on the first `recall` after server start (the embedding model downloads/loads on first call — expected: seconds on a warm cache, longer on first download).
3. Confirm `rankFn` in results: if consistently `"jaccard"`, the model is not loading — investigate stderr for the one-time warning.
4. At window end: subjective rating — would you use this habit without prompting?

---

## 4. Evidence checklist (paths)

The following artifacts accumulate passively during the window:

| Artifact | Path (relative to repo root) | What it captures |
|---|---|---|
| Recall log | `.mneme/recall-log.jsonl` | Per-recall: ts, corpus, about, topScore, matchCount, abstained, rankFn, missingCount, missing, warningCount, subject, key |
| Write-event log | `.mneme/store.db` → `claim_events` table | Every `remember` call with timestamp, subject, key, value |
| Claim provenance | `.mneme/store.db` → `claims` table, `provenance` column | For derived claims: which source claims combined |
| Key census | query against `.mneme/store.db` | Snapshot of distinct keys per corpus (run at midpoint + end) |
| This doc | `docs/dogfood/2026-06-06-dogfood-protocol.md` | Review section below (fill in at window end) |

---

## 5. Real-server smoke procedure

Perform this once, immediately after the branch merges and the MCP server is connected to a Claude Code session.

**Goal:** confirm the full pipeline round-trips correctly and the embedding model loads.

**Steps:**

1. In a Claude Code session with the mneme MCP server connected, call:
   ```
   remember({ subject: "project:Mneme", key: "dogfood_smoke_test", value: "smoke-2026-06-06", validFrom: "<today ISO>" })
   ```
2. Immediately call:
   ```
   recall({ subject: "project:Mneme", about: "dogfood smoke test" })
   ```
3. Record the response fields:
   - `topScore` — expect > 0 (the claim was just written; it should rank highly)
   - `rankFn` — expect `"hybrid"` when the embedding model has loaded; `"jaccard"` on the first call if the model is still loading (retry once after a few seconds)
   - `abstained` — expect `false` (knobs are off at 0; nothing should be suppressed)
   - `matchCount` — expect >= 1

4. Record results here (fill in after running):

   | Field | Expected | Observed |
   |---|---|---|
   | topScore | > 0 | ___ |
   | rankFn | "hybrid" (after model load) | ___ |
   | abstained | false | ___ |
   | matchCount | >= 1 | ___ |

5. If `rankFn` stays `"jaccard"` after a retry: check server stderr for the one-time embedding-init warning. Model may not have downloaded yet — the server falls back to jaccard gracefully.

---

## 6. Window-end review template

Fill this in at the end of the 2-week window. Replace `___` placeholders.

```
## Dogfood window-end review

**Window:** merge date ___ to end date ___
**Total recalls:** ___ (from recall-log line count)
**Total remembers:** ___ (from claim_events COUNT)
**Active corpora:** ___

### Q1 — Supersession value

Did the algebra serve the right fact where plain recall wouldn't?

Answer: [YES / NO / NOT ENOUGH DATA]

Evidence:
- Multi-write (subject, key) pairs found: ___
- Example (if YES): subject=___, key=___, older value=___, newer value=___,
  recall result returned: ___ (correct newer / incorrect older)
- Notes: ___

### Q2 — Key drift

Did inconsistent key naming silently bypass ⊥?

Answer: [YES — drift found / NO — keys were consistent / NOT ENOUGH DATA]

Evidence:
- Key census (midpoint): [paste or summarize]
- Key census (end): [paste or summarize]
- Near-duplicate pairs found: ___
  Examples: ___
- Recommendation: [add to key-matching slice backlog / no action needed]

### Q3 — Abstention calibration

Calibration performed: [YES / NO — insufficient recalls]

If YES:
- Recall count at calibration: ___
- topScore distribution summary: ___
- Chosen abstainBelowTop: ___
- Chosen relevanceFloor: ___
- Correct refusals observed after dialing: ___
- False refusals observed after dialing: ___

If NO:
- Recall count reached: ___
- Reason not calibrated: ___

### Q4 — Friction

Explicit-write usable?
- Instances where remember was skipped (and why): ___
- Subjective rating: [1–5, where 5 = would use without prompting]

Warm-up latency tolerable?
- First-recall latency (approximate): ___ seconds
- rankFn observed (hybrid / jaccard / mixed): ___
- Any model-load warnings in stderr: [YES / NO]

### Dial decision (post-window)

abstainBelowTop: ___  (0 = keep off until more data)
relevanceFloor:  ___  (0 = keep off until more data)

Rationale: ___

### Next-slice inputs

Based on this window:
- Q2 key drift evidence → key-matching slice: [needed urgently / needed eventually / not needed]
  Key-drift examples to feed the slice: ___
- Any other signals for upcoming slices: ___
```

---

## 7. Knobs-off-until-calibrated reminder

Both knobs default to **0 (off)**:

- `abstainBelowTop` = 0: the model returns all matches regardless of confidence.
- `relevanceFloor` = 0: no precision filtering.

This is intentional for the first dogfood window. The window's purpose is to accumulate a real distribution of `topScore` values from interactive queries before any threshold is chosen.

**The benchmark's 0.872 is NOT transferable.** That value was calibrated on `bge-base-en-v1.5` + LongMemEval question-style queries — a qualitatively different query population than the short, attribute-lookup-style queries typical of interactive MCP recall. Interactive queries may produce a compressed score distribution. Adopt a dial value only after running the calibration procedure in Q3.

Set knobs only when:
1. >= 20 recalls have accumulated in `.mneme/recall-log.jsonl`
2. The topScore distribution has been reviewed (Q3 procedure above)
3. A separation point between useful and not-useful recalls is visible
4. The chosen value is recorded in the review template above
