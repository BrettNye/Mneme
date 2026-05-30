# Mneme Usable Surface — Design

**Date:** 2026-05-29
**Status:** Approved for planning
**Author:** Brett (with Claude)

## Problem

Mneme is feature-complete as a library: `createMneme()` exposes a facade for
writes (`commit`, `commitBatch`, `supersede`, `promote`, `derive`), reads
(`query`, `read`, `readByIds`, `replay`), and corpus management. But the only
ways to exercise it are `npm run example` and the vitest suite. There is no
CLI, REPL, or server. Consequently it "feels like a lib" — you cannot poke at
it, and you cannot pressure-test it against real data without writing
TypeScript by hand.

The goal: a **usable surface** that lets the author (a) drive Mneme by hand
during normal dev work, and (b) push a **large real dataset** through it to
find throughput/correctness cliffs. The surface must not foreclose later
**productization** (e.g. an MCP server or hosted service).

## Goals

1. Hand-drivable: create corpora, write claims, run queries, inspect/replay
   claims from a terminal, against persisted state.
2. Bulk-ingest a large dataset and report throughput + accept/reject/dup stats —
   the core pressure test.
3. An ergonomic core that is reusable by *any* future transport (CLI now,
   MCP/HTTP later) — nothing built now is throwaway.
4. Clean module boundaries that can be promoted to separate packages later
   without a rewrite.

## Non-Goals (this pass)

- REPL, HTTP server, MCP server **implementation** (seam only — see below).
- Auth / multi-tenant concerns.
- Downloading datasets automatically — the importer reads a file already on disk.
- Monorepo / separately-published packages — boundaries are enforced as
  subpath exports within the single `mneme` package.

## Decisions (resolved during brainstorming)

- **Approach A**: ergonomic core + CLI now; MCP/HTTP are later thin shells.
- **One package, subpath exports** — not a monorepo. Boundaries:
  `mneme` (core) → `mneme/surface` → `mneme/cli`, strictly one-way.
- **DSL is not its own unit** — it is the read half of the session facade and
  ships with it under `mneme/surface`.
- **Persisted store** — default `./mneme.db` (file), not `:memory:`, so state
  survives across CLI invocations.
- **Importer** — generic JSONL mapper plus `conceptnet` and `icews` presets.

## Architecture

```
mneme            existing core: algebra / write / adapters / bio
   ▲
mneme/surface    session facade + query DSL + importer   (THE reusable asset)
   ▲
mneme/cli        thin shell; CLI-only deps live here
```

Dependency rule: `cli → surface → core`, never backward. Enforced by an
`exports` map in `package.json` and by review (optionally a lint rule later).

### Module: `src/surface/session.ts`

A thin, opinionated facade over `createMneme()`.

```ts
export interface SessionOptions {
  dbPath?: string;            // default "./mneme.db"
  writer?: string;            // default "cli"
  profile?: string;           // default identity for CandidateClaim
  workspace?: string;
  source?: Source;            // default "imported" for bulk, "manual" for single
  availableTiers?: Tier[];    // default [{ kind: "core" }]
}

export interface Session {
  mneme: Mneme;               // escape hatch to the raw facade

  // corpus
  createCorpus(spec: CorpusSpec): CorpusDef;   // CorpusSpec = ergonomic, defaulted
  listCorpora(): CorpusDef[];
  inspectCorpus(corpusId: string): CorpusDef;

  // write — fills CandidateClaim drudgery from session identity + defaults
  write(corpusId: string, rec: WriteRecord): WriteOutcome;
  writeMany(corpusId: string, recs: Iterable<WriteRecord>, opts?: { batchSize?: number })
    : ImportStats;            // streams via commitBatch; returns counts + timing

  // read
  q(corpusId: string, dsl: string): QueryResult;   // terse DSL -> pipe(...)
  inspect(claimId: string): Claim;
  replay(claimId: string): ReplayResult;
}

export function openSession(opts?: SessionOptions): Session;
```

`WriteRecord` is the boilerplate-free input: `{ subject, key, value,
confidence?, scope?, valid?, source?, tags?, status?, ... }`. Missing fields are
filled from session identity and sane defaults (confidence → `scalar 1.0`,
`valid → { from: 0, to: Infinity }`, `status → "validated"`).

`ImportStats = { total, committed, rejected, duplicate, elapsedMs,
claimsPerSec }`.

This module is the **MCP seam**: a future MCP server wraps `Session` directly.
The seam is documented here and in code comments; it is **not implemented** this
pass.

### Module: `src/surface/dsl.ts`

A terse string DSL that compiles to the existing `Stage[]` pipeline. Initial
grammar (line- or pipe-separated stages):

```
from <corpus>                         -> leaf(corpus)   (implicit from CLI arg)
where subject = <s>                   -> sigma subjectEq
where key = <k> | status = <st> | tag in [..] | confidence > <n>
where valid at <t> | recorded after <t>
rank jaccard "<query>" | rank exact "<query>"
decay exp <halfLifeDays> | decay none
as markdown <maxTokens> | as xml <n> | as json <n> | as text <n>
count | count where <pred> | sum <path> | avg <path> | group by <field>
```

The DSL covers the common read shapes; the `session.mneme.query(...)` escape
hatch remains for anything exotic. Parser is small and hand-rolled (no new dep).

### Module: `src/surface/import.ts`

Streaming dataset ingest.

```ts
export type RowMapper = (row: unknown) => WriteRecord | null;  // null = skip row

export const mappers: Record<"jsonl" | "conceptnet" | "icews", RowMapper>;

export function importFile(
  session: Session,
  corpusId: string,
  filePath: string,
  opts: { format: "jsonl" | "conceptnet" | "icews"; batchSize?: number;
          map?: RowMapper; onProgress?: (n: number) => void }
): ImportStats;
```

- Uses a **streaming line reader** (Node `readline` over a file stream) so a
  multi-GB file never loads into memory.
- Buffers `batchSize` records (default 1000) and flushes via
  `session.writeMany` → `commitBatch`.
- Preset mappers:
  - `jsonl` — each line is a JSON object already shaped like `WriteRecord`.
  - `conceptnet` — CSV/JSONL assertion: `relation → key`, `start → subject`,
    `end → value`, `weight → confidence (scalar)`, `dataset/source → source`.
  - `icews` — temporal quadruple `(subject, relation, object, timestamp)`:
    `subject → subject`, `relation → key`, `object → value`,
    `timestamp → valid.from`. Exercises the `valid` interval machinery.

### Module: `src/cli/main.ts` + `bin/mneme.ts`

Thin CLI shell over `Session`. Commands:

| Command | Behavior |
|---|---|
| `mneme corpus create <id> [--schema …]` | ergonomic corpus creation |
| `mneme corpus ls` | list corpora |
| `mneme corpus inspect <id>` | show corpus def |
| `mneme commit <corpus> --subject … --key … --value … [--confidence …]` | single write |
| `mneme query <corpus> "<dsl>"` | run DSL, formatted output |
| `mneme inspect <claimId>` | show a claim |
| `mneme replay <claimId>` | show replay result |
| `mneme import <corpus> <file> --as conceptnet\|icews\|jsonl [--batch N]` | **bulk pressure-test**; prints throughput + stats |

- Arg parsing: Node `util.parseArgs` (built-in, no new dependency).
- Global flags: `--db <path>` (default `./mneme.db`), `--writer <id>`.
- Output: human-readable by default; `--json` for machine output.
- CLI-only concerns (process exit codes, stderr, parseArgs) live **only** here.

### `package.json` changes

- Add `"bin": { "mneme": "./bin/mneme.ts" }` (run via `tsx` shim; a build step
  to JS is a later concern).
- Add `"exports"` map:
  ```json
  {
    ".":        "./src/index.ts",
    "./surface": "./src/surface/index.ts",
    "./cli":     "./src/cli/index.ts"
  }
  ```
- Add scripts: `"mneme": "tsx bin/mneme.ts"`.
- No new runtime dependencies (DSL parser + arg parser are hand-rolled / built-in).

## Data Flow

**Bulk import (the pressure test):**
`mneme import` → `importFile` streams file lines → `RowMapper` per row →
`WriteRecord` buffered to `batchSize` → `session.writeMany` → `commitBatch`
(existing write pipeline: idempotency, contradiction policy, distribution
serialization, SQLite insert) → accumulate `ImportStats` → CLI prints
throughput + accept/reject/dup.

**Query:** `mneme query` → `dsl.parse` → `Stage[]` → `session.mneme.query` →
formatter → terminal.

## Error Handling

- **Importer**: a malformed row is logged and skipped (counts toward a `skipped`
  tally), it does not abort the run. A failed *batch* is reported with the
  batch's row range; import continues. Final stats always print.
- **CLI**: unknown command / missing required flag → usage message + exit 1.
  Domain errors (e.g. corpus not found) → readable message + exit 1, no stack
  trace unless `--debug`.
- **DSL**: parse error → points at the offending token + the supported grammar.

## Testing

vitest, matching existing conventions:

- `session.test.ts` — defaults filled correctly; `write` round-trips; `writeMany`
  returns accurate `ImportStats`; persisted `dbPath` survives reopen.
- `dsl.test.ts` — each grammar form compiles to the expected `Stage[]`; parse
  errors are reported.
- `import.test.ts` — each preset mapper maps a sample row → correct
  `WriteRecord`; end-to-end import of a small fixture file (a few hundred rows)
  yields correct counts and is queryable afterward.
- `cli.test.ts` — argument parsing for each command; `--json` output shape.

Manual acceptance: download ConceptNet (or ICEWS14), run
`mneme import <corpus> <file> --as conceptnet`, confirm throughput stats print
and a follow-up `mneme query` returns sensible claims.

## Recommended pressure-test datasets

- **ConceptNet 5** — easy CSV/JSONL, `weight` → confidence, millions of edges.
  First target.
- **ICEWS14 / GDELT / YAGO11k** — temporal quadruples; exercise `valid`
  intervals + `recordedSeq`.
- **NELL** — beliefs carry confidence + provenance + iteration; most on-model.
- **Wikidata truthy subset** — qualifiers → `scope`, references →
  `provenance`/`evidence`; the millions-of-claims-with-contradictions stress test.

## Future (explicitly deferred)

- MCP server wrapping `Session` (the documented seam).
- HTTP/JSON daemon.
- Promote `mneme/surface` → `@mneme/surface` and `mneme/cli` → its own package
  once a second consumer exists.
- Compiling the CLI to JS for a dependency-free `npx mneme`.
