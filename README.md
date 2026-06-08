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

> **Status:** pre-1.0, active development. Core engine, MCP server, bio layer, and benchmark
> suite are working and tested (~1,690 tests). Not yet published to npm — install from source.

## Core properties

| Property | What it means |
|---|---|
| **Append-only ledger** | Every write / supersession / resolution is an event; nothing is destroyed in place. |
| **Supersession, not deletion** | Corrected facts deprecate their predecessors with full lineage; the old value stays inspectable. |
| **Deterministic replay** | Derived beliefs carry their query, inputs, and model versions; replay returns `exact` or names the divergence. |
| **Bitemporal validity** | Claims know both when they were *recorded* and when they were *valid* — time-travel queries are first-class. |
| **Confidence with evidence** | Beta-distributed confidence: not just *how sure* but *how much evidence* — corroboration strengthens belief. |
| **Explainable retrieval** | Recall reports coverage facts ("no claim available mentions 'X'") and provenance handles, so an agent can refuse or cite with a reason. |

## How it's used

- **As an MCP server** — `remember` / `recall` / `key_census` tools give any MCP client (Claude
  Code, etc.) persistent, principled memory from one config block. This is the primary path
  today; see the day-to-day guide in **[docs/USING-MNEME.md](docs/USING-MNEME.md)**.

  ```json
  {
    "mcpServers": {
      "mneme": {
        "command": "npx",
        "args": ["tsx", "bin/mneme-mcp.ts"],
        "env": { "MNEME_DB": "${USERPROFILE}/.mneme/knowledge.db", "MNEME_CORPUS": "knowledge" }
      }
    }
  }
  ```

- **As an embeddable TypeScript library** — a claims engine with a small relational algebra over
  belief state (select, temporal-slice, decay, similarity-rank, combine, contradiction-resolve,
  compose). The quickstart below is the tour.

## Benchmarks

Measured on LongMemEval (knowledge-update questions, **oracle attribution**), deterministic and
reproducible from committed artifacts (`bench/RESULTS.md`):

- Naive memory serves the updated fact **33%** of the time.
- Mneme's deterministic supersession + semantic ranking, **out of the box: ~49%.**
- With the auditable key-reconciliation loop operated: **56% (1.67× naive)** — retrieval quality
  *above* baseline, every merge carrying a recorded reason.
- The dominant failure mode is *measurable*: ~50 points of headroom on this benchmark is **key
  identity** (the same fact under drifted key names) — the silent rot every LLM-ingestion memory
  shares, which an append-only ledger exposes and repairs rather than hides.

Caveats stated plainly: these are *retrieval-layer* metrics in the *oracle* setting (evidence
sessions only); end-to-end QA numbers comparable to other published systems, and full-haystack
numbers, are not yet measured. Where it can't answer, it says so — explainable refusal recovers
37% of unanswerable questions at a measured 4.5% false-decline floor, each refusal citing the
missing entity.

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

## Project layout

| Path | What |
|---|---|
| `src/algebra/` | the relational algebra over claims (operators) |
| `src/retrieval/` | named recipes composing operators (canonical read pipeline, key-alias, coverage) |
| `src/mcp/` | the MCP server and its tools |
| `src/write/` | derived writes + the replay engine |
| `src/bio/` | the cognitive overlay (recall / reinforce / consolidate) |
| `examples/` | runnable walkthroughs |
| `bench/` | the LongMemEval harness and `RESULTS.md` |
| `docs/gtm/` | positioning + compliance-controls mapping |

## Scripts

```bash
npm test               # full suite (vitest)
npm run typecheck      # tsc --noEmit
npm run example        # library walkthrough
npm run example:bio    # bio-layer walkthrough
npm run mneme-mcp      # start the MCP server
```

## Design notes

- **Compose, don't invent.** New behavior is built from existing operators + declarative inputs
  + dials; new equations only when no composition expresses the need.
- **The substrate stays LLM-free.** LLM-powered maintenance (ratification, consolidation) runs
  *above* the substrate and writes back through the same auditable ledger — judgment lives
  outside the deterministic core.
- **Knobs off until calibrated.** Thresholds ship at zero and are turned on only from observed
  data, never transferred from a different setting.

## Where to go next

- Day-to-day MCP usage: [docs/USING-MNEME.md](docs/USING-MNEME.md)
- Positioning + compliance-controls mapping: [docs/gtm/](docs/gtm/)
- Benchmark methodology + results: [bench/RESULTS.md](bench/RESULTS.md)
- Replay re-execution engine: `docs/superpowers/specs/2026-05-28-replay-reexecution-engine-design.md`
- Bio layer: see [Bio layer (cognitive memory)](#bio-layer-cognitive-memory) above and [`examples/bio-quickstart.ts`](examples/bio-quickstart.ts).

## License

TBD (pre-release).
