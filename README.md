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

```ts
mneme.replay(claim).status;
// A plain committed claim has no recorded query → "integrity_unknown".
// Claims derived from a recorded query re-execute to "exact" / "mismatch".
```

## Where to go next

- Replay re-execution engine: `docs/superpowers/specs/2026-05-28-replay-reexecution-engine-design.md`
- The bio (cognitive) layer ships with its own quickstart (coming next).
