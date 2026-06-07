# Agent memory that survives a compliance review

**Mneme — controls mapping (draft for outreach · 2026-06-07 · not legal advice)**

---

## The question your auditor will ask

Agent pilots are reaching production reviews, and memory is becoming a finding. The question
that stalls deployment is not "is the vendor SOC 2 certified" — it is:

> **"What did the agent believe at 14:32 on March 15th, why did it believe it, and can you
> reproduce that state?"**

Memory products built on silent UPDATE/DELETE consolidation cannot answer it. The state that
produced the agent's action no longer exists; the log, if any, describes a database, not a
belief. Mneme is an epistemic substrate built so that question is a query, not a forensic
project.

## Control mapping

| Requirement | Regulatory hook | Mneme mechanism | Demonstrable artifact |
|---|---|---|---|
| Automatic recording of events over the system lifetime | **EU AI Act Art. 12** (high-risk record-keeping; obligations phasing in from Aug 2026) | Append-only claim ledger: every write, supersession, and resolution is an event; nothing is destroyed in place | `claim_events` table; live corpus walkthrough |
| Deployer log retention | **EU AI Act Art. 26** | Ledger + recall log persist as ordinary files/DB under the deployer's control and retention policy | `.mneme/store.db`, `recall-log.jsonl` |
| Reproducibility of model-adjacent decisions | **SR 11-7** (model risk management: documentation, reproducibility, effective challenge) | Deterministic replay: derived beliefs carry their full query expression, input claims, and model versions; replay returns `exact` or names the divergence | `replayStatus()` → `exact`, demonstrated across post-hoc changes |
| Books and records with complete audit trail | **SEC 17a-4 (as amended 2022: audit-trail alternative to WORM)** | Supersession, not deletion: corrected facts deprecate their predecessors with full lineage; the "wrong" record remains inspectable forever | Any superseded claim: old value, new value, timestamps, writer |
| Audit controls on information activity | **HIPAA 45 CFR 164.312(b)** | Every read is logged (what was asked, what was served, what was suppressed); every write carries writer identity and provenance | recall log + claim provenance fields |
| Explainable automated behavior | Art. 13/14-style transparency expectations | Refusals and merges cite their reasons: "no claim available mentions 'X'" (coverage facts), "merged under rule: separator-fold," "ratified by judge: <recorded reason>" | Coverage annotations; 358 benchmark ratifications, each with a recorded reason |

## Why this cannot be retrofitted

Audit features bolted onto a destructive store log *changes to a database*. They cannot answer
the belief question, because the substrate discards the very states the question is about.
Mneme's guarantees are properties of the data model — claims with bitemporal validity,
supersession-only conflict resolution, replayable derivations — not features layered on top.
**A vendor can add an audit log; they cannot un-DELETE.**

## The receipts (public benchmark, reproducible for ~$11)

On LongMemEval knowledge-update questions (oracle attribution), measured and committed:

- Naive memory serves the updated fact **33%** of the time; Mneme's deterministic supersession
  alone: **40%**; with judgment-ratified key reconciliation and semantic ranking: **56%
  (1.67× naive)** — with retrieval quality *above* baseline and every merge auditable.
- The failure mode is measurable: **~50 points of headroom on this benchmark is key identity**,
  not retrieval — exactly the class of silent error a destructive store hides and an auditable
  one exposes.
- The full loop was re-run through the production interfaces and reproduced the numbers
  **exactly** — the benchmark claim *is* the production behavior.
- Where the system cannot answer, it says so with a reason: explainable refusal recovered 37%
  of unanswerable questions at a measured 4.5% false-decline floor — every refusal citing the
  missing entity.

All artifacts (datasets, judgments with reasons, run gates) are committed and deterministic;
a skeptical engineer can re-derive every number.

## What Mneme is and is not

Mneme is the **memory substrate**: an embeddable claims engine (TypeScript library + MCP
server) for agent belief state. It pairs with execution governance (policy enforcement and
dispatch logging) to reconstruct the full timeline — *believed X, was authorized for Y, did Z*.
It is not a compliance certification, a hosted service guarantee, or legal advice; mappings
above identify which mechanisms support which obligations, for review with your counsel.

---

*Want the 20-minute version? The demo is live: write conflicting facts, watch supersession
resolve them, ask "why did the agent believe X on date T," and replay the answer bit-for-bit.*
