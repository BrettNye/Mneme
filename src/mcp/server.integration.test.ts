/**
 * Integration tests for the Mneme MCP server.
 *
 * Embedding strategy: NEVER import transformers-local here.
 * Before the first recall, call:
 *   _resetEmbeddingsForTest()
 *   initEmbeddings(async () => { throw new Error("no model in CI"); })
 * This primes the singleton with the jaccard fallback so the server handler's bare
 * initEmbeddings() returns the cached jaccard state without attempting real model load.
 */
import { beforeAll, describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMnemeMcpServer } from "./server.js";
import { _resetEmbeddingsForTest, initEmbeddings } from "./embeddings.js";

type TextContent = { content: { type: string; text: string }[] };
type StructuredRecall = {
  structuredContent?: {
    corpus: string;
    content: string;
    matches: { subject: string; key: string; value: unknown; confidence: number; score: number }[];
    topScore?: number;
    abstained: boolean;
    rankFn: string;
  };
};

// ── Embedding isolation ────────────────────────────────────────────────────────
// Prime the singleton with jaccard before any test that triggers recall.
// This MUST run before the server's first recall handler fires (which calls bare
// initEmbeddings()), so the cached state is already set to the jaccard fallback.
beforeAll(async () => {
  _resetEmbeddingsForTest();
  await initEmbeddings(async () => { throw new Error("no model in CI"); });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), "mneme-mcp-int-"));
}

async function connected(corpus = "dev", dbPath?: string) {
  const resolvedDbPath = dbPath ?? join(makeTmpDir(), "store.db");
  const { server } = createMnemeMcpServer({ dbPath: resolvedDbPath, defaultCorpus: corpus });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, dbPath: resolvedDbPath };
}

// ── Existing tests (must remain passing) ──────────────────────────────────────

describe("mneme MCP server (protocol)", () => {
  it("advertises remember / recall / list_corpora over MCP", async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["list_corpora", "recall", "remember"]);
    await client.close();
  });

  it("remember then recall round-trips through tool calls", async () => {
    const { client } = await connected();

    const rem = (await client.callTool({
      name: "remember",
      arguments: { subject: "project:mneme", key: "decision", value: "dogfood via MCP", confidence: 0.9 },
    })) as TextContent;
    expect(rem.content[0].text).toMatch(/committed/);

    const rec = (await client.callTool({
      name: "recall",
      arguments: { about: "dogfood MCP decision" },
    })) as TextContent;
    expect(rec.content[0].text).toContain("dogfood");
    expect(rec.content[0].text).toMatch(/p=0\.90/); // confidence surfaced in top matches

    await client.close();
  });

  it("isolates corpora: recall only returns the queried corpus's claims", async () => {
    // One server / one store, two corpora written and read via real tool calls — the
    // exact multi-tenant separation a work user relies on (e.g. work vs personal, or
    // project-A vs project-B). Guards the query-time corpus-isolation contract end-to-end.
    const { client } = await connected("A");
    await client.callTool({ name: "remember", arguments: { subject: "doc", key: "fact", value: "alpha-only-secret", corpus: "A" } });
    await client.callTool({ name: "remember", arguments: { subject: "doc", key: "fact", value: "bravo-only-secret", corpus: "B" } });

    const recA = (await client.callTool({ name: "recall", arguments: { about: "secret", corpus: "A" } })) as TextContent;
    expect(recA.content[0].text).toContain("alpha-only-secret");
    expect(recA.content[0].text).not.toContain("bravo-only-secret");

    const recB = (await client.callTool({ name: "recall", arguments: { about: "secret", corpus: "B" } })) as TextContent;
    expect(recB.content[0].text).toContain("bravo-only-secret");
    expect(recB.content[0].text).not.toContain("alpha-only-secret");

    await client.close();
  });

  it("ships tool annotations and structured output for AI consumption", async () => {
    const { client } = await connected();

    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    // read-only hints let a client reason about which tools are safe to call freely
    expect(byName.recall.annotations?.readOnlyHint).toBe(true);
    expect(byName.list_corpora.annotations?.readOnlyHint).toBe(true);
    expect(byName.remember.annotations?.readOnlyHint).not.toBe(true); // remember is a write
    // tools advertise an output schema for typed consumption
    expect(byName.recall.outputSchema).toBeDefined();
    expect(byName.remember.outputSchema).toBeDefined();

    // structuredContent is returned alongside the human-readable text blob
    const rem = (await client.callTool({
      name: "remember",
      arguments: { subject: "s", key: "k", value: "v", confidence: 0.8 },
    })) as { structuredContent?: { id: string; status: string; corpus: string } };
    expect(rem.structuredContent?.status).toBe("committed");
    expect(typeof rem.structuredContent?.id).toBe("string");

    const rec = (await client.callTool({
      name: "recall",
      arguments: { about: "v", subject: "s" },
    })) as { structuredContent?: { matches: { subject: string; key: string; confidence: number; score: number }[] } };
    expect(Array.isArray(rec.structuredContent?.matches)).toBe(true);
    expect(rec.structuredContent?.matches[0]).toMatchObject({ subject: "s", key: "k" });
    expect(typeof rec.structuredContent?.matches[0].confidence).toBe("number");

    await client.close();
  });
});

// ── New tests ─────────────────────────────────────────────────────────────────

describe("mneme MCP server (new wiring)", () => {
  /**
   * (1) Full-pipeline round-trip: structuredContent surfaces topScore/abstained/rankFn
   *     on the jaccard fallback path.
   */
  it("recall structuredContent includes topScore, abstained, rankFn on jaccard path", async () => {
    const { client } = await connected();

    await client.callTool({
      name: "remember",
      arguments: { subject: "test:entity", key: "info", value: "some searchable content" },
    });

    const rec = (await client.callTool({
      name: "recall",
      arguments: { about: "searchable content" },
    })) as StructuredRecall;

    expect(rec.structuredContent).toBeDefined();
    expect(typeof rec.structuredContent?.topScore).toBe("number");
    expect(typeof rec.structuredContent?.abstained).toBe("boolean");
    expect(rec.structuredContent?.abstained).toBe(false);
    expect(typeof rec.structuredContent?.rankFn).toBe("string");
    expect(rec.structuredContent?.rankFn).toBe("jaccard");

    await client.close();
  });

  /**
   * (2) Config-driven multi-key behavior: write config.json with a multi-cardinality key
   *     before constructing the server. Remember two values with the same subject+key.
   *     Recall must return both (multi-key means no resolution/dedup to single).
   */
  it("config keyCardinality=multi allows multiple values for same subject+key", async () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "store.db");
    // Write config.json with 'info' as multi-cardinality BEFORE creating the server.
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({ keyCardinality: { info: "multi" } }));

    const { client } = await connected("dev", dbPath);

    await client.callTool({
      name: "remember",
      arguments: { subject: "topic:test", key: "info", value: "first value" },
    });
    await client.callTool({
      name: "remember",
      arguments: { subject: "topic:test", key: "info", value: "second value" },
    });

    const rec = (await client.callTool({
      name: "recall",
      arguments: { about: "value", subject: "topic:test", key: "info" },
    })) as StructuredRecall;

    // With multi-cardinality, both values should survive (no dedup to single).
    const matchValues = rec.structuredContent?.matches.map((m) => m.value as string) ?? [];
    expect(matchValues).toContain("first value");
    expect(matchValues).toContain("second value");

    await client.close();
  });

  /**
   * (3) Bad-config startup rejection: config.json with invalid cardinality value
   *     causes createMnemeMcpServer to throw matching /keyCardinality|config/.
   */
  it("bad config.json (invalid cardinality) causes createMnemeMcpServer to throw", () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "store.db");
    // Write a config with an invalid cardinality value.
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({ keyCardinality: { someKey: "invalid-value" } }),
    );

    expect(() => createMnemeMcpServer({ dbPath, defaultCorpus: "dev" })).toThrow(
      /keyCardinality|config/i,
    );
  });

  /**
   * (4) Recall-log JSONL line appended beside the db after a recall.
   *     After one remember + one recall, a recall-log.jsonl file must exist
   *     beside the db, and the parsed line must contain corpus/about/rankFn/abstained.
   */
  it("recall-log JSONL line is appended beside the db after a recall", async () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "store.db");
    const { client } = await connected("logtest", dbPath);

    await client.callTool({
      name: "remember",
      arguments: { subject: "log:entity", key: "note", value: "log test content" },
    });

    await client.callTool({
      name: "recall",
      arguments: { about: "log test content", corpus: "logtest" },
    });

    // Give the best-effort log append a moment (it's synchronous in implementation).
    const logPath = join(tmpDir, "recall-log.jsonl");
    let logContent: string;
    try {
      logContent = readFileSync(logPath, "utf-8");
    } catch {
      throw new Error(`Expected recall-log.jsonl at ${logPath} but file not found`);
    }

    const lines = logContent.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const entry = JSON.parse(lines[0]);
    expect(entry).toMatchObject({
      corpus: "logtest",
      about: "log test content",
      rankFn: "jaccard",
      abstained: false,
    });
    expect(typeof entry.ts).toBe("string");
    expect(typeof entry.matchCount).toBe("number");

    await client.close();
  });

  /**
   * (5) Remember accepts scope and validFrom over MCP.
   *     Verify the fields are accepted without error and the remember succeeds.
   */
  it("remember accepts scope and validFrom fields over MCP", async () => {
    const { client } = await connected();

    const rem = (await client.callTool({
      name: "remember",
      arguments: {
        subject: "project:test",
        key: "status",
        value: "active",
        confidence: 0.95,
        scope: { project: "mneme", context: "test" },
        validFrom: "2026-01-01T00:00:00Z",
      },
    })) as TextContent;

    expect(rem.content[0].text).toMatch(/committed/);

    await client.close();
  });
});
