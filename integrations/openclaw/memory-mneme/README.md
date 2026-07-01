# Mneme Memory Integration for OpenClaw

This plugin integrates Mneme's typed claim memory system as a memory slot for OpenClaw.

## Installation

Install the plugin in your OpenClaw project:

```bash
npm install @openclaw/memory-mneme
```

## Configuration

### Slot Selection

Configure OpenClaw to use Mneme as the memory backend in your config. Set `plugins.slots.memory` to `"memory-mneme"`:

```yaml
plugins:
  slots:
    memory: "memory-mneme"
```

### Configuration Schema

The following configuration options are available:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dbPath` | string | (required) | Path to the SQLite database file for storing claims |
| `corpus` | string | `"openclaw"` | Corpus identifier for partitioning memories across projects |
| `autoRecall` | boolean | `true` | Automatically recall relevant memories during operations |
| `recallLimit` | number | `10` | Maximum number of memories to recall per query |
| `relevanceFloor` | number | `0.5` | Minimum relevance score (0-1) for recalled memories |
| `defaultScope` | object | `{ "project": "openclaw" }` | Default scope for memory queries and writes |

Example configuration:

```json
{
  "plugins": {
    "memory": "memory-mneme",
    "config": {
      "memory-mneme": {
        "dbPath": "./data/memory.db",
        "corpus": "my-project",
        "autoRecall": true,
        "recallLimit": 15,
        "relevanceFloor": 0.6,
        "defaultScope": {
          "project": "my-project",
          "context": "production"
        }
      }
    }
  }
}
```

## Prerequisites

This plugin requires **better-sqlite3** to be installed and available in your host environment. The better-sqlite3 library provides the underlying SQLite database support that Mneme depends on.

Install it with:

```bash
npm install better-sqlite3
```

Note: better-sqlite3 is a native module and requires Node.js and Python development tools to build from source.

## API

Each tool takes a single arguments object and returns a text result. Recall
returns mneme's resolved, token-bounded context (latest-per-`(subject,key)`).

### memory_recall

Retrieve relevant resolved memories for a query.

```typescript
memory_recall({ about: string, limit?: number, relevanceFloor?: number })
```

### memory_remember

Store a typed claim `(subject, key, value)`. Explicit-write only — no auto-capture.

```typescript
memory_remember({
  subject: string, key: string, value: string,
  confidence?: number, tags?: string[], scope?: Record<string, string>,
})
```

### memory_key_census

Census the distinct keys in the corpus and surface alias candidates.

```typescript
memory_key_census({ limit?: number })
```

### memory_corpora

List available memory corpora.

```typescript
memory_corpora({})
```

## Architecture

Mneme provides a principled, non-destructive epistemic substrate for agent memory:

- **Typed Claims**: Each memory is a strongly-typed claim with subject, key, value, and confidence score
- **Durable & Auditable**: All writes are persisted and fully auditable
- **Replayable**: Claims can be replayed deterministically
- **Non-destructive**: Operations never delete historical data; instead, they supersede via confidence updates

This makes memory operations suitable for regulated AI applications where auditability is critical.

## Development

### Build

```bash
npm run build
```

### Test

```bash
npm test
```
