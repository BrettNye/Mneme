# Using Mneme

Mneme is a **calibrated belief store**: it remembers typed *claims* — `(subject, key, value)` with a **confidence** — and lets you query them back, ranked and composed into a token-bounded context. Think *structured, auditable memory you can reason over*, not a note pile or a document search.

You'll mostly use it through its **MCP server**, which gives an AI agent (Claude Code, etc.) three tools: `remember`, `recall`, `list_corpora`.

---

## 1. Mental model

A **claim** is one fact about one entity:

| Field | What it is | Convention / example |
|---|---|---|
| `subject` | the entity the claim is about | `namespace:id` → `project:migration`, `ticket:4521`, `person:jane`, `host:web-01` |
| `key` | the attribute / predicate | `decision`, `status`, `owner`, `deadline`, `risk`, `root-cause`, `learning` |
| `value` | the fact itself | free text (or any JSON value) |
| `confidence` | 0..1 certainty (defaults to `1`) | `1.0` hard fact; `0.5–0.8` tentative — it's surfaced on recall |
| `tags` | optional cross-cutting labels | `["q2", "rollout", "incident-x"]` |
| `corpus` | the **isolation boundary** | one corpus = one tenant / workspace (e.g. `work`, `personal`, `client:acme`) |

Two properties worth internalizing:

- **Append-only.** You never overwrite or delete. If a belief changes, you `remember` the new claim and both persist — the store is an audit trail of what you believed and when.
- **Corpus = hard isolation.** A query scoped to corpus A can never see corpus B's claims (enforced at the storage layer, not by convention). Use corpora to separate tenants/clients; use `subject`/`key`/`tags` to organize *within* a corpus.

---

## 2. Setup (MCP server)

The server is a thin stdio shell over the library. Register it in your project's `.mcp.json` (or your user-level Claude config to make it available everywhere):

```jsonc
{
  "mcpServers": {
    "mneme": {
      "command": "node",
      "args": [
        "C:/path/to/Mneme/node_modules/tsx/dist/cli.mjs",
        "C:/path/to/Mneme/bin/mneme-mcp.ts"
      ],
      "env": {
        "MNEME_DB": "C:/Users/<you>/.mneme/work.db",
        "MNEME_CORPUS": "work"
      }
    }
  }
}
```

- **Don't launch via `npx`.** `npx tsx …` re-resolves the `tsx` binary on every start; from a working directory without a local `node_modules/tsx` (i.e. any project other than the Mneme repo) it falls back to a registry/cache resolve that can take **60–90 s** — well past Claude Code's 30 s MCP handshake timeout, so the server silently fails to connect. Calling `node` directly against the checked-in `node_modules/tsx/dist/cli.mjs` boots in ~1–2 s from any directory. (Inside the repo itself, project-scoped `.mcp.json` can use the shorter `"command": "node", "args": ["--import", "tsx", "bin/mneme-mcp.ts"]` form, since cwd is the repo.)
- **Use absolute paths** to both `tsx/dist/cli.mjs` and `bin/mneme-mcp.ts` for a user-level config. Relative paths only resolve when Claude Code launches the server with its working directory set to the Mneme repo; absolute paths work from any project.
- **`MNEME_DB`** — where the SQLite store lives (default `./.mneme/store.db`). Point work at its own file, separate from any personal store.
- **`MNEME_CORPUS`** — the default corpus when a tool call doesn't pass `corpus` (falls back to the project-directory name if unset).
- **Prereqs (do these before you need it, not during):** in the Mneme checkout run `npm install` — this compiles the native `better-sqlite3` module, which needs build tools and can fail on a locked-down laptop. Then confirm `node --import tsx bin/mneme-mcp.ts` starts without error (prints the `mneme MCP server on stdio …` banner).

The store is a plain local SQLite file — nothing leaves the machine.

---

## 3. The tools

### `remember` — capture a claim *(write; non-destructive append)*

```
remember(subject, key, value, [confidence], [tags], [corpus])
```

Commits a new claim (auto-creating the corpus if needed). Returns structured output `{ id, status, corpus }` where `status` is `committed | rejected | duplicate`, plus a human-readable line.

### `recall` — retrieve relevant claims *(read-only, idempotent)*

```
recall(about, [subject], [key], [limit], [maxTokens], [corpus])
```

Filters (by `subject`/`key` if given), similarity-ranks against `about`, and composes the top claims into a token-bounded context. Returns structured output:

```jsonc
{
  "corpus": "work",
  "content": "…markdown composed context…",
  "matches": [
    { "subject": "project:migration", "key": "decision",
      "value": "use feature flags", "confidence": 0.9, "score": 0.41 }
  ]
}
```

Recall is **side-effect-free**: querying an unknown corpus returns empty — it does **not** create it.

### `list_corpora` — enumerate corpora *(read-only)*

```
list_corpora()
```

Returns `{ corpora: [{ id, displayName }] }`.

> The tools ship MCP **annotations** (`readOnlyHint`, etc.) and **structured output** (`outputSchema` + `structuredContent`), so an AI client can both reason about which tools are safe to call freely and consume results as *typed data* rather than parsing the text.

---

## 4. Patterns that make it work well

1. **Namespace your subjects** (`project:x`, `client:acme`, `ticket:1234`). Consistent subjects make filtered recall sharp.
2. **Reuse keys as predicates** (`decision`, `status`, `owner`, `risk`). Then "all decisions for project X" is one query.
3. **🔑 Retrieve with filters, not pure free-text.** This is the single most important habit today (see Limitations). Narrow with `subject`/`key`, then let `about` rank *within* that slice:
   ```
   recall(about="rollout", subject="project:migration", key="decision")   ✅ sharp
   recall(about="what did we decide about the rollout")                    ⚠️ unreliable ranking
   ```
4. **Set confidence deliberately.** `1.0` for decided facts; lower for tentative observations. It surfaces on recall so you can see how sure past-you was.
5. **Use tags for cross-cutting pulls** (`sprint-12`, `incident-x`) when subject/key don't capture the grouping.

---

## 5. Worked examples

Capture as you work:

```
remember(subject="project:migration", key="decision",
         value="use feature flags for the rollout", confidence=0.9, tags=["q2","rollout"])

remember(subject="ticket:4521", key="owner", value="jane")

remember(subject="incident:db-outage", key="root-cause",
         value="connection-pool exhaustion under retry storm", confidence=0.8)
```

Recall before a standup or a decision:

```
recall(about="rollout decisions", subject="project:migration", key="decision")
recall(about="who owns it", subject="ticket:4521")
recall(about="db outage cause", subject="incident:db-outage")
```

Keep work and a client separate via corpora:

```
remember(subject="api", key="rate-limit", value="600/min", corpus="client:acme")
recall(about="rate limit", corpus="client:acme")     # never sees other clients' claims
```

---

## 6. How `recall` works (for the curious)

Recall runs Mneme's query algebra as a small pipeline:

- **σ (select)** — filter by `subject` / `key` (exact match) to narrow the working set.
- **ρ (rank)** — similarity-rank the survivors against your `about` text, attaching a score.
- **κ (compose)** — fold the ranked claims into a single markdown context, capped at `maxTokens`, surfacing each claim's confidence.

That composable, confidence-aware retrieval is what distinguishes Mneme from a flat key-value memory.

---

## 7. Limitations & gotchas

- **Free-text ranking is lexical today.** The ρ step uses token-overlap (jaccard) similarity, not semantic embeddings — so a natural-language `about` query discriminates weakly (scores cluster near zero, ordering is rough). **Workaround:** use `subject`/`key` filters to narrow, as in Pattern 3. (Semantic ranking — `rho.embedding` — is a known, localized future addition; it lands when real use shows the weak ranking actually blocks you.)
- **The MCP surface is `remember` / `recall` / `list_corpora` only.** The library also supports belief-revision (`supersede`, `promote`), derivation (`derive`), and reproducibility (`replay`), but those aren't exposed over MCP yet — so via MCP it's *append + read*.
- **Append-only + local.** You can deprecate but not hard-delete, and the store is single-machine SQLite (no sync across devices). Don't store secrets/PII you'd need to truly erase.
- **`remember` is not idempotent over MCP.** Two identical `remember` calls create two claims. Capture deliberately.

---

## 8. Where data lives

A single SQLite file at `MNEME_DB` (plus its `-wal`/`-shm` companions). Concurrent access is safe — multiple Claude Code sessions or the server + CLI can share one store without corruption. Back it up by copying the file.
