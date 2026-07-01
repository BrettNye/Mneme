# OpenClaw `memory-mneme` Plugin — Design

**Date:** 2026-07-01
**Status:** Approved (brainstorming) → ready for implementation plan

## Goal

Make mneme OpenClaw's **direct memory backend** — a native memory-slot plugin, not
an optional MCP tool the agent may or may not call. When installed and selected via
`plugins.slots.memory = "memory-mneme"`, every agent turn gets auto-recall from mneme,
and the agent can write typed claims back through an explicit `remember` tool.

The plugin drives mneme's engine **in-process** (library-direct) against its SQLite DB.
No subprocess, no REST bridge.

## Non-goals

- **No free-text auto-capture.** Unlike mem0/LanceDB memory plugins, this plugin does
  NOT dump conversation turns into memory on `agent_end`. Mneme stores typed claims
  `(subject, key, value)` with confidence and supersession; explicit-write is the wedge
  ("capture lessons, not transients", non-destructive). Auto-capturing raw messages
  would pollute the corpus and defeat the point. A future LLM-extraction phase is left
  as a documented, off-by-default seam — out of scope here.
- No changes to mneme's algebra, write pipeline, or MCP server.
- No packaging/publish to ClawHub/npm in this slice (local `--link` install is enough).

## Context / reference

- OpenClaw memory plugins own an exclusive **slot**: `plugins.slots.memory = "<id>"`.
  Only one plugin owns the active memory slot. Selection force-activates the plugin.
- Reference implementation studied: `serenichron/openclaw-memory-mem0` (a memory-slot
  plugin backed by a self-hosted REST API). It establishes the exact contract we mirror:
  - Manifest `openclaw.plugin.json`: `{ id, name, description, version, kind:"memory",
    author, configSchema, tools[], cliCommands[] }`.
  - `package.json`: `type:"module"`, `openclaw.extensions:["./index.ts"]`, dep
    `@sinclair/typebox` for tool parameter schemas.
  - `index.ts` default export: `{ id, name, description, kind:"memory" as const,
    configSchema, register(api) }`.
  - Inside `register(api)`:
    - `api.pluginConfig` → resolved config object.
    - `api.registerTool({ name, label, description, parameters: Type.Object(...),
      async execute(toolCallId, params) { return { content:[{type:"text", text}] } } },
      { name })`.
    - `api.registerCli(({ program }) => { ... }, { commands:[...] })`.
    - `api.on("before_agent_start", async (event) => { ...; return { prependContext } })`
      — `event.prompt` is the incoming user prompt.
    - `api.on("agent_end", async (event) => { ... })` — `event.messages[]`, `event.agentId`.
      **We do not register this hook** (explicit-write only).
- OpenClaw loads the plugin's own `.ts` entry directly (Node 18+, TS-capable loader).
  Installing/updating plugin code requires a Gateway restart.

## Mneme integration surface

Mneme already exposes everything needed as a library:

- `openSession({ dbPath, writer })` from `mneme/surface` → the `Session` facade.
- `initEmbeddings()` (in `src/mcp/embeddings.ts`) → embeddings state.
- `config.keyCardinality` from the mneme config loader.
- Exported from `mneme/mcp`: `remember(session, args)`, `recall(session, args, deps)`,
  `listCorpora(session)`, `ensureCorpus`. (`keyCensus(session, args)` exists in
  `src/mcp/tools.ts` but is not yet re-exported from `mneme/mcp` — the plugin needs it
  exported; fold this into the same one-line export change as `openMnemeEngine`.)

`recall()` returns both a token-bounded **`content` string** (a `ComposedContext` built
precisely for injecting memory into an agent's context) and resolved `matches`
(`RecallMatch { subject, key, value, confidence, score, id, tags }`), already collapsed
to latest-per-`(subject,key)` by the algebra (served health, not the raw accreting leaf).
It also applies `relevanceFloor` / `abstainBelowTop` **server-side**. `remember(session,
args)` takes `RememberArgs { subject, key, value, corpus, confidence?, tags?, scope?,
validFrom? }` and returns `{ id, status, corpus }`.

**Reuse, don't re-render (DRY).** The plugin consumes `recall().content` and passes
`relevanceFloor` into `recall` — it does NOT hand-roll a match-line formatter or filter
matches client-side. Both already exist in the engine (`content` = ComposedContext;
server.ts renders inline match lines; filtering is a recall arg).

### One mneme-side addition — a shared engine bootstrap

Add **`openMnemeEngine({ dbPath, corpus })`** at `src/mcp/engine.ts`, re-exported from
`mneme/mcp`, returning a stable facade:
`{ session, defaultCorpus, keyCardinality, initEmbeddings }` (where `initEmbeddings` is
the memoized lazy loader; `keyCardinality` comes from `loadMnemeConfig`). A recall/census
call builds its `RecallDeps` as `{ embeddings: await initEmbeddings(), keyCardinality }`
— identical to what server.ts does today.

This must be a **genuine extraction, not a parallel bootstrap (DRY):** the same
`loadMnemeConfig` + `openSession` sequence currently inlined in `createMnemeMcpServer`
moves into `openMnemeEngine`, and `createMnemeMcpServer` is refactored to consume it.
Constraints:

- **Preserve lazy embeddings.** `openMnemeEngine` must NOT eagerly load the embedding
  model — it returns the memoized `initEmbeddings` so the first recall pays the cost and
  `register()` / Gateway boot stays instant (matches the server's existing pattern).
- Also re-export **`keyCensus`** from `mneme/mcp` (it exists in `src/mcp/tools.ts` and is
  used by server.ts, but is not currently on the `mneme/mcp` index) for the
  `memory_key_census` tool.

**SoC win:** the plugin then imports *only* `openMnemeEngine` plus the tool fns
(`remember`, `recall`, `listCorpora`, `keyCensus`) from `mneme/mcp` — it never reaches
into `surface` / `config` / `embeddings` internals.

These are the only changes inside the mneme package proper. Trade-off noted: this touches
the battle-tested `createMnemeMcpServer`; it is covered by the existing
`server.test.ts` / `server.integration.test.ts` suites, which must stay green.

## Plugin architecture

```
integrations/openclaw/memory-mneme/
  openclaw.plugin.json   # manifest: id, kind:memory, configSchema, tools, cliCommands
  package.json           # type:module, openclaw.extensions:["./index.ts"], dep: mneme (file:)
  index.ts               # default export + register(api) — wiring + I/O only
  format.ts              # pure: wrap recall().content in <relevant-memories> envelope
  README.md              # install + config + slot selection
  index.test.ts          # unit + register() smoke test
```

Keep `index.ts` thin (wiring + logging). Pure logic lives in `format.ts` so it is
testable without a live `api`. Per house convention ("servers/adapters do I/O, pure
helpers stay pure"), all logging (`[memory-mneme] …` to stderr) lives in `index.ts`;
`format.ts` is pure. `format.ts` is deliberately tiny — it wraps `recall().content` in
the `<relevant-memories>` envelope and guards the empty case; it does NOT re-render
matches (see F1/DRY).

### Config schema

| Field | Default | Source | Meaning |
|---|---|---|---|
| `dbPath` | `~/.mneme/knowledge.db` | `MNEME_DB` env fallback | SQLite corpus DB path |
| `corpus` | `openclaw` | `MNEME_CORPUS` env fallback | Corpus id for recall + writes |
| `autoRecall` | `true` | — | Inject resolved memory before each turn |
| `recallLimit` | `5` | — | Max matches per recall |
| `relevanceFloor` | `0.0` | — | Drop matches scoring below this (off by default) |
| `defaultScope` | `undefined` | — | Optional `{ project, context }` applied to writes |

Config resolution order (mirroring the reference plugin): `api.pluginConfig` →
env (`MNEME_DB`, `MNEME_CORPUS`) → defaults.

### Tools (agent-facing)

1. **`memory_recall`** — params `{ about: string, limit?: number, relevanceFloor?: number }`.
   Calls `recall(session, { about, corpus, limit, relevanceFloor }, { embeddings, keyCardinality })`.
   Returns `recall().content` (mneme's own ComposedContext) as the tool text. Empty →
   a clear "no relevant memories" message. Does not re-render matches client-side (F1).

2. **`memory_remember`** — params `{ subject: string, key: string, value: string,
   confidence?: number, scope?: object, tags?: string[] }`. Calls
   `remember(session, { ...params, corpus, scope: params.scope ?? defaultScope })`.
   The tool **description embeds mneme discipline**: type the subject as `type:name`,
   reuse kebab-case keys, set confidence (~0.7 fresh single observation, 0.85–0.95
   verified, 1.0 only for unconditional facts), and recall-before-write. Returns
   `{ id, status }`.

3. **`memory_key_census`** *(introspection — kept)* — params `{ corpus?: string }`.
   Wraps `keyCensus`. Surfaces key proliferation for hygiene.

4. **`memory_corpora`** *(introspection — kept)* — no params. Wraps `listCorpora`.

### CLI commands

Mirror the tools for host-side use: `mneme recall <about>`, `mneme remember <subject>
<key> <value> [--confidence]`, `mneme census`, `mneme corpora`. Registered via
`api.registerCli`.

### Lifecycle hooks

- **`before_agent_start`** (registered iff `autoRecall`): read `event.prompt`; skip if
  empty. `recall()` with `recallLimit` + `relevanceFloor` (filtering happens server-side
  inside recall). If `recall().content` is empty, return nothing. Otherwise return
  `{ prependContext: format.wrapMemories(recall().content) }`, where `wrapMemories` is the
  pure `format.ts` helper that wraps the ComposedContext in `<relevant-memories>…
  </relevant-memories>`. No client-side match rendering or filtering (F1).
- **`agent_end`**: intentionally not registered. Explicit-write only.

## Data flow

```
user turn ──▶ before_agent_start ──▶ recall(prompt) ──▶ resolved matches
                                                          │
                              prependContext<relevant-memories> ──▶ agent
agent decides a fact is worth keeping ──▶ memory_remember(subject,key,value,conf)
                                                          │
                                              remember() ──▶ typed claim in SQLite
                                              (supersession handled by the algebra)
```

## Error handling

- All engine calls wrapped: failures log `[memory-mneme] …` and degrade gracefully —
  recall failure returns empty (agent proceeds with no injected memory), tool failure
  returns an error `content` block rather than throwing into the host.
- Engine opened once per `register()` (lazy singleton); a DB-open failure is logged and
  disables the tools/hook rather than crashing the Gateway.

## Risks

- **R1 — TS-source dependency import.** mneme's `package.json` `exports` point at
  `./src/*.ts` (not compiled JS). OpenClaw loads the plugin's own `index.ts`, so it has
  a TS-capable loader — but whether it transpiles a TS dependency resolved from
  `node_modules` is unverified. **Mitigation:** implementation task 1 is a spike — a
  minimal plugin that imports `mneme` and logs a recall. If the loader won't transpile
  the dep, fall back to adding a `tsc` build to mneme (emit `dist/`) and repoint the
  `openMnemeEngine` import at compiled output (or add a `mneme/engine` export mapped to
  built JS). Design otherwise unchanged.
- **R2 — native binding ABI.** `better-sqlite3` must be built for the host Node runtime.
  The big-helper Docker image already rebuilds it for Linux (`npm install --include=dev`);
  for a local host install the plugin's `npm install` must compile it there. Documented
  as a prerequisite in the README.

## Testing

- `format.ts`: unit tests — `wrapMemories` (empty content → no envelope; non-empty →
  wrapped once); any `defaultScope` merge helper used by `memory_remember`.
- `index.ts`: smoke test — call `register(stubApi)` against a temp SQLite DB; assert the
  four tools + the `before_agent_start` hook (when `autoRecall`) are registered, and that
  a `memory_remember` → `memory_recall` round-trip returns the written claim.
- `openMnemeEngine`: the existing `server.test.ts` / `server.integration.test.ts` must
  stay green after `createMnemeMcpServer` is refactored to consume it (proves the
  extraction preserved behaviour, incl. lazy embeddings).
- Reuse mneme's existing temp-DB test helpers.

## Audit conformance (repo patterns / DRY / SRP / SoC)

- **DRY** — no re-rendering: recall content + match rendering + relevance filtering all
  come from the engine (F1). `openMnemeEngine` extracts the bootstrap rather than forking
  it, and `createMnemeMcpServer` consumes the extraction (F2).
- **SRP** — `format.ts` pure formatting; `index.ts` wiring + I/O; `engine.ts` bootstrap;
  each unit does one thing.
- **SoC** — the plugin talks to mneme through one intentional facade (`openMnemeEngine` +
  the four tool fns), never reaching into `surface`/`config`/`embeddings` internals (F3).
- **House conventions matched** — `format.ts` module name (mirrors `surface/format.ts`),
  `opts ?? env ?? default` config resolution, pure-helpers/IO-at-edges split, and a
  `[memory-mneme]` stderr log prefix (mirrors `[mneme/recall]`) (F4).
- **Deferred for consistency** — server.ts writes best-effort `appendRecallLog` telemetry
  per recall; the plugin omits it in v1 to avoid coupling to MCP-specific telemetry, noted
  as optional future for unified dogfood observability (F5).

## Out of scope / future

- LLM-extraction auto-capture on `agent_end` (behind an off-by-default flag).
- Multi-agent corpus routing (per-agent corpora vs. one shared corpus).
- ClawHub / npm publish + `openclaw.compat.pluginApi` version pinning.
- Wiring this plugin into the `big-helper/openclaw` deployment (that deployment already
  runs mneme as an MCP server; migrating it to the memory slot is a separate follow-up).
