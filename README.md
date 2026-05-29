# Mneme

Mneme is an **epistemic store**: it records *claims* (facts with provenance and
uncertainty) instead of plain rows. Confidence is a Beta distribution, not a scalar —
so Mneme tracks *how much evidence* backs a belief. Contradictions are resolved
explicitly, beliefs decay as they go stale, and derived results can be re-executed and
verified.

This quickstart uses a **service/host status monitoring** scenario.

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
mneme.replay(claim).status; // "integrity_unknown"
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
mneme.replay(derived).status; // "exact"
```

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

## Where to go next

- Replay re-execution engine: `docs/superpowers/specs/2026-05-28-replay-reexecution-engine-design.md`
- Bio layer: see [Bio layer (cognitive memory)](#bio-layer-cognitive-memory) above and [`examples/bio-quickstart.ts`](examples/bio-quickstart.ts).
