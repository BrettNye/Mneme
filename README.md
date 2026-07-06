# Mneme

**A deterministic, non-destructive, replayable memory substrate for AI agents.**

Most agent memory systems *consolidate*: they UPDATE and DELETE belief state in place. That
makes a fast demo and an unanswerable audit — when an agent acts on a wrong memory, the state
that produced it is gone. Mneme is built the other way: memory is an **append-only ledger of
claims**. Facts are superseded, never overwritten; conflicts are resolved by explicit rules,
not silent last-write-wins; and any served belief can be **replayed bit-for-bit** to show why
the agent believed it.

The bet: LLM-powered ingestion is table stakes. The durable wedge is a memory whose every state
is reconstructable — what an agent in a regulated or high-trust setting needs when someone asks
*"what did it believe at 14:32 on March 15th, and can you reproduce that?"*

> **Status:** pre-1.0, active development. Core engine, MCP server (10 tools), the ingestion /
> canonicalization layer, the bio layer, and the benchmark + pressure suites are working and
> tested (**~1,994 tests, 157 files**). Not yet published to npm — install from source.

## Core properties

| Property | What it means |
|---|---|
| **Append-only ledger** | Every write / supersession / resolution is an event; nothing is destroyed in place. |
| **Supersession, not deletion** | Corrected facts deprecate their predecessors with full lineage; the old value stays inspectable and is served-past by `history`. |
| **Deterministic replay** | Derived beliefs carry their query, inputs, and model versions; replay returns `exact` or names the divergence. |
| **Bitemporal validity** | Claims know both when they were *recorded* and when they were *valid* — time-travel (`asOf`) queries are first-class. |
| **Confidence with evidence** | Beta-distributed confidence: not just *how sure* but *how much evidence* — corroboration strengthens belief. |
| **Explainable retrieval** | Recall reports coverage facts ("no claim mentions 'X'"), a per-claim trace (`explain`), and provenance handles, so an agent can refuse or cite with a reason. |
| **Propose, never auto-apply** | Maintenance (aliasing, cardinality, over-merge) is surfaced as ranked *proposals* a human/agent ratifies — the substrate never silently rewrites your entities. |

## Two theses, two layers

**1. The algebra is solved; ingestion is the hard part.** Storing, resolving, and recalling
claims works out of the box. The bottleneck for *compounding* memory is turning messy sources
into **canonical** claims — the same fact must land on the same `(subject, key)` every time, or
nothing accretes and no contradiction ever fires. Mneme treats that boundary as a first-class,
**deterministic** layer (see [Ingestion & canonicalization](#ingestion--canonicalization)) rather
than leaving it to an LLM prompt, because LLMs canonicalize unreliably (blind extraction
over-*fragments*; "prefer existing" prompts over-*collapse*).

**2. Non-destructive is the wedge.** Any memory can ingest with an LLM. What Mem0-style
consolidating stores *can't* do is un-DELETE — replay a superseded belief, show the lineage, or
prove what was believed and when. That auditability is the moat, and it's demonstrable, not just
claimed: every correction leaves the original in the ledger, queryable.

## How it's used

- **As an MCP server** — a stdio server exposing **10 tools** to any MCP client (Claude Code,
  etc.) from one config block. This is the primary path today; see the day-to-day guide in
  **[docs/USING-MNEME.md](docs/USING-MNEME.md)**.

  | Tool | Role |
  |---|---|
  | `remember` | append a claim; returns supersession attribution (what it deprecated) |
  | `recall` | similarity-rank into a token-bounded context; `explain: true` returns a per-claim trace |
  | `list_corpora` | enumerate corpora |
  | `reconcile` | score candidate subjects/keys vs live entities → reuse / uncertain / new (read-only) |
  | `key_census` / `subject_census` | detect key / subject fragmentation + alias candidates |
  | `declare_cardinality` | mark a key `single` (latest wins) or `multi` (values coexist) |
  | `audit` | whole-corpus, propose-only maintenance (ranked alias / cardinality / over-merge proposals) |
  | `history` | full non-destructive lineage of one `(subject, key)` — every version + disposition |
  | `inspect` | raw stored fields of one claim by id |

  ```jsonc
  {
    "mcpServers": {
      "mneme": {
        "command": "node",
        "args": ["--import", "tsx", "bin/mneme-mcp.ts"],
        "env": { "MNEME_DB": "${USERPROFILE}/.mneme/knowledge.db", "MNEME_CORPUS": "knowledge" }
      }
    }
  }
  ```

  Ranking is **semantic by default**: on first recall the server lazily loads a local
  `bge-base-en-v1.5` embedding model and ranks with `hybrid` (lexical ⊕ cosine); it falls back to
  pure `jaccard` only if the model can't load. Nothing leaves the machine — the store is a local
  SQLite file.

- **As an embeddable TypeScript library** — a claims engine with a small relational algebra over
  belief state (select, temporal-slice, decay, similarity-rank, combine, contradiction-resolve,
  compose) plus a first-class `surface` layer (`recall`, `remember`, `reconcile`, `ingest`,
  `explainRecall`, …). The quickstart below is the tour; `import { ... } from "mneme/surface"`.

## Ingestion & canonicalization

The layer that turns sources into *canonical* claims — deterministic, propose-only, LLM-free at
its core. All the ops below are importable from `mneme/surface`; several are also exposed as
**MCP tools** (see [How it's used](#how-its-used)).

- **`ingest(session, { corpus, extract }, deps)`** — the enforced *recall-before-write* loop.
  Gathers the corpus's live canonical entities, hands them to your injected `extract` callback
  (an LLM extractor, or pre-structured claims), reconciles the candidates, **auto-remaps only
  high-confidence matches** while routing borderline ones to a ratify bucket (the *over-anchoring
  guard*), writes each via supersession-aware `remember`, and returns propose-only maintenance
  proposals. Pure composition of the primitives below — no new algebra.
- **`reconcile`** — the *under-folding* guard: given candidate subjects/keys, returns the existing
  canonical entities to reuse (so you don't mint `project:crewTracks-liner-build` next to
  `project:crewtracks`). Read-only, scored, disposition = reuse / uncertain / new.
- **`reverseReconcile`** — the *over-folding* detector (symmetric): flags a subject that is holding
  claims from **multiple** entities and should be split. Propose-only, confidence-honest
  (never asserts, never auto-splits).
- **`keyCensus` / `subjectCensus`** — enumerate distinct keys/subjects and score near-duplicate
  pairs; surface fragmentation and single-cardinality collisions.
- **`session.declareCardinality(corpus, map)`** *(Session method)* — a `single` key silently
  deprecates distinct facts (last-write-wins); a `multi` key lets them coexist. Cardinality is
  *declared*, never guessed.
- **`audit` / `lineageOf`** — `audit` composes the censuses into one ranked, **propose-only**
  maintenance report (charter invariant: propose, never apply); `lineageOf` (exposed as the
  `history` MCP tool) and `explainRecall` make the resulting belief changes visible — why each
  claim was served / merged / deprecated, and the full lineage of any `(subject, key)`.

> The primitives are deterministic and offline-testable; the LLM-shaped part (extraction) is an
> *injected* callback that lives in the consumer, so the substrate stays LLM-free and the source
> adapter never leaks into the core.

## Benchmarks

Measured on LongMemEval (knowledge-update questions), deterministic and reproducible from
committed artifacts — see **[bench/RESULTS.md](bench/RESULTS.md)** for methodology and caveats.

- **Algebra read path vs plain similarity** (manual 20-question knowledge-update slice): serving
  the *updated* fact — `updateCorrect` **0.9 vs 0.1**. Deterministic supersession + ranked recall
  is the difference between remembering the correction and remembering the stale value.
- **Semantic ranking is the lever, at oracle scale (229q):** all lift is semantic (bge cosine via
  `hybrid`), not lexical aliasing — validated band **KU updateCorrect 0.403 → 0.472 (+6.9pp)** at
  a −1.4pp recall@3 cost; hybrid ranking alone lifts the baseline 0.403 → 0.486.
- **Recency-aware ranking (Pareto-safe, on by default):** at `recencyAlpha=0.5` / 90-day half-life,
  KU answer-in-context **0.472 → 0.528 (+5.6pp)** with temporal-reasoning flat — which is why
  recall ships that as the default blend.
- **The dominant failure mode is *measurable*:** the headroom on this benchmark is **key identity**
  (the same fact under drifted key names) — the silent rot every LLM-ingestion memory shares, which
  an append-only ledger *exposes and repairs* (via the census/reconcile loop) rather than hides.

Stated plainly: these are *retrieval-layer* metrics; end-to-end QA and full-haystack numbers are
not yet measured. Confidence-aware serving is measured-but-*parked* (not Pareto-safe); the bio
efficacy slice is gated off pending a passing pre-registered test. Where recall can't answer, it
says so — explainable refusal, each citing the missing entity.

---

The quickstart below uses a **service/host status monitoring** scenario.

## Install

```bash
npm install
```

## Quickstart

The full, runnable version of the code below lives in
[`examples/quickstart.ts`](examples/quickstart.ts) (run it with `npm run example`).

### 1. Construct a store and a corpus

A *corpus* is a namespaced claim store with a schema and defaults.

```ts
import { createMneme, createSqliteAdapter } from "mneme";

const adapter = createSqliteAdapter(":memory:");
const mneme = createMneme({ adapter, availableTiers: [{ kind: "core" }] });
mneme.createCorpus(corpusDef); // see examples/quickstart.ts for the full definition
```

### 2. Commit a claim (confidence is a distribution)

`confidence` is a Beta `{ alpha, beta }` — here 8 of 9 probes saw the host healthy.

```ts
const committed = mneme.commit("infra:prod", {
  subject: "host:web-01",
  key: "status",
  value: "healthy",
  confidence: { distribution: "beta", parameters: { alpha: 8, beta: 1 }, raw: 8 / 9 },
  // ...profile/workspace/valid/source/provenance/evidence/tags/schema
} as never, { writer: "healthcheck" });
```

### 3. Query it back as a token-bounded context

```ts
import { pipe, leaf, sigma, rho, kappa } from "mneme";

const ctx = mneme.query("infra:prod", pipe(
  leaf("infra:prod"),
  sigma({ op: "subjectEq", value: "host:web-01" }),
  rho.jaccard("web-01 status"),
  kappa.markdown(2000),
));
console.log(ctx.content); // markdown summary, capped at 2000 tokens
```

### 4. Resolve a contradiction with `supersede`

Fresh probes flip the host to `degraded`. The old claim becomes `deprecated`; the
replacement is committed — belief change is explicit and auditable.

```ts
mneme.supersede("infra:prod", committed.id, {
  subject: "host:web-01",
  key: "status",
  value: "degraded",
  confidence: { distribution: "beta", parameters: { alpha: 5, beta: 4 }, raw: 5 / 9 },
  // ...
} as never, { writer: "healthcheck" });
```

### 5. Let stale beliefs decay

Query under an exponential decay policy at a pinned `evaluationClock` — effective
confidence drops as the reading ages. The pinned clock makes the result deterministic.

```ts
import { delta } from "mneme";

// Assume a host:web-02 status claim was committed earlier; read it back to get its
// `recorded` timestamp, then evaluate 30 days later so the reading has gone stale.
const recordedAt = web02.recorded; // from mneme.readByIds(...) — see examples/quickstart.ts
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const decayed = mneme.query("infra:prod", pipe(
  leaf("infra:prod"),
  sigma({ op: "subjectEq", value: "host:web-02" }),
  delta.exponential(7), // 7-day half-life
), { evaluationClock: recordedAt + THIRTY_DAYS_MS });

const c = decayed.claims[0].confidence;
console.log(c.raw, c.effective); // effective < raw
```

### 6. Verify reproducibility with replay

A plain committed claim has no recorded query, so `replay` reports `integrity_unknown`:

```ts
mneme.replay("infra:prod", claim).status; // "integrity_unknown"
```

A claim produced by `mneme.derive` records its query, so it re-executes and is verified —
`exact` if it reproduces, `mismatch` if the inputs changed. Pick a query that doesn't
re-select the derived claim itself (here the derived `status.summary` is excluded by the
`status` filter):

```ts
import { astLeaf, astSigma } from "mneme";

const { id } = mneme.derive(
  "infra:prod",
  astSigma(
    { op: "and", preds: [{ op: "subjectEq", value: "host:web-02" }, { op: "keyEq", value: "status" }] },
    astLeaf("infra:prod"),
  ),
  { subject: "host:web-02", key: "status.summary", scope: {}, writer: "rollup" },
);

const derived = mneme.readByIds("infra:prod", [id])[0];
mneme.replay("infra:prod", derived).status; // "exact"
```

`replay` takes the enforced `corpusId` first; it throws `corpus mismatch` if the
claim carries a different `corpusId` (tenant-isolation guard).

## Bio layer (cognitive memory)

The **bio layer** is a cognitive overlay on the claim store. It doesn't replace claims — it
learns *which* claims matter from how episodes (tasks) turn out: it **recalls** relevant
memories, **reinforces** the ones that led to success, and **consolidates** them. The full
runnable version is in [`examples/bio-quickstart.ts`](examples/bio-quickstart.ts)
(`npm run example:bio`).

```ts
import { createMneme, createSqliteAdapter, createBioMemory } from "mneme";

const mneme = createMneme({
  adapter: createSqliteAdapter(":memory:"),
  availableTiers: [{ kind: "core" }],
});
mneme.createCorpus(corpusDef); // see examples/bio-quickstart.ts for the full definition
const bio = createBioMemory({ mneme, corpusId: "agent:memory" });

// Recall the agent's memories for a task (an "episode"), then report how the task went.
const ep = bio.openEpisode();
bio.recall({ corpusId: "agent:memory" }, [], { now: Date.now(), decay: () => 1 }, ep.id);

// A successful outcome reinforces the recalled memories — their Beta alpha rises.
const report = bio.recordOutcome(ep.id, "success");
// report.opsApplied > 0 — the cognitive cycle strengthened the surfaced memories

bio.consolidate(ep.id); // fold / promote consolidated memories
```

`summarize` and `dream` are deeper bio processes that take an injected model function — see
the bio-layer design docs.

## How it's tested

Correctness is defended at four levels, all runnable from a clean checkout:

- **Unit + property suite** — `npm test` (~1,994 tests, 157 files; `fast-check` property tests
  over the algebra). `npm run typecheck` for `tsc --noEmit`.
- **Deterministic offline validation harnesses** (`scripts/validate-*.ts`) — reproduce real
  findings through the first-class surfaces with **no LLM spend** (temp DB, jaccard deps):
  `validate-shipped-dogfood` (the 5 recorded Fireflies-dogfood findings), `validate-belief-change`
  (declare-cardinality / supersession-aware remember / audit / history / inspect),
  `validate-ingest` (the `ingest` loop), `validate-reverse-reconcile` (over-fold detection).
- **Pressure suite** — `npm run pressure` stresses the durability and isolation guarantees a
  memory-of-record must hold: cross-tenant isolation at volume (`multitenant`, `corpus-identity`),
  data fidelity against hostile input (`adversarial`), **tamper-evidence** against real SQLite
  mutation and forged events (`tamper`, Merkle-chain), N-process concurrent writers (`concurrent`),
  and SIGKILL-mid-write WAL recovery (`crash`).
- **LongMemEval benchmark** — `npm run eval:lme` (+ `eval:lme:fixture` for the zero-model smoke).
  Retrieval-quality measurement with committed, reproducible artifacts; see
  [bench/RESULTS.md](bench/RESULTS.md).

## Project layout

| Path | What |
|---|---|
| `src/surface/` | the first-class op layer: `recall`, `remember`, `reconcile`, `ingest`, `reverseReconcile`, census, audit, history, explain, `openSession` |
| `src/algebra/` | the relational algebra over claims (operators, AST, similarity, embedding) |
| `src/retrieval/` | named recipes composing operators (canonical read pipeline, key-alias, coverage) |
| `src/write/` | write pipeline, contradiction resolution, derived writes + the replay engine |
| `src/bio/` | the cognitive overlay (recall / reinforce / consolidate / dream / summarize) |
| `src/audit/` | tamper-evidence: Merkle chain, signers, local + AWS KMS/S3 anchoring |
| `src/adapters/` | storage (SQLite) + the local embedding adapter (`bge-base-en-v1.5`) |
| `src/mcp/` · `src/cli/` | the MCP server + its 10 tools; the `mneme` CLI |
| `examples/` | runnable walkthroughs (`quickstart`, `bio-quickstart`, `fireflies-ingest`) |
| `bench/` | LongMemEval harness, `RESULTS.md`, and the `pressure/` suite |
| `integrations/` | consumers — e.g. the OpenClaw memory plugin |
| `docs/` | `USING-MNEME.md`, positioning (`gtm/`), bio, and design specs (`superpowers/`) |

## Scripts

```bash
npm test               # full suite (vitest) — ~1,994 tests
npm run typecheck      # tsc --noEmit
npm run example        # library walkthrough
npm run example:bio    # bio-layer walkthrough
npm run mneme-mcp      # start the MCP server
npm run pressure       # durability / isolation / tamper-evidence suite
npm run eval:lme       # LongMemEval retrieval benchmark
```

## Design notes

- **Compose, don't invent.** New behavior is built from existing operators + declarative inputs
  + dials; new equations only when no composition expresses the need. `ingest` and the whole
  canonicalization layer are pure compositions — no new algebra.
- **The substrate stays LLM-free.** LLM-powered work (extraction, ratification, consolidation) runs
  *above* the substrate as injected callbacks and writes back through the same auditable ledger —
  judgment lives outside the deterministic core.
- **Propose, never auto-apply.** Entity maintenance (aliases, cardinality, over-merge, subject
  splits) is surfaced as ranked proposals; the substrate never silently rewrites your entities.
- **Knobs off until calibrated.** Thresholds ship at zero / documented heuristics and are turned on
  only from observed data, never transferred from a different setting.

## Where to go next

- Postgres / async surface (hosted, multi-tenant): [docs/postgres-async-adapter.md](docs/postgres-async-adapter.md)
- Day-to-day MCP usage: [docs/USING-MNEME.md](docs/USING-MNEME.md)
- Ingestion loop spec: `docs/superpowers/specs/2026-07-02-ingest-loop-sdk-design.md`
- Over-anchoring / reverse-reconcile spec: `docs/superpowers/specs/2026-07-02-reverse-reconcile-over-anchoring-design.md`
- Positioning + compliance-controls mapping: [docs/gtm/](docs/gtm/)
- Benchmark methodology + results: [bench/RESULTS.md](bench/RESULTS.md)
- Replay re-execution engine: `docs/superpowers/specs/2026-05-28-replay-reexecution-engine-design.md`
- Bio layer: see [Bio layer (cognitive memory)](#bio-layer-cognitive-memory) above and [`examples/bio-quickstart.ts`](examples/bio-quickstart.ts).

## License

TBD (pre-release).
