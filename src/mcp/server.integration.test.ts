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
import { beforeAll, describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMnemeMcpServer } from "./server.js";
import { _resetEmbeddingsForTest, initEmbeddings } from "../surface/embeddings.js";

type TextContent = { content: { type: string; text: string }[] };
type StructuredRecall = {
  structuredContent?: {
    corpus: string;
    content: string;
    matches: { subject: string; key: string; value: unknown; confidence: number; score: number }[];
    topScore?: number;
    abstained: boolean;
    rankFn: string;
    warnings?: string[];
  };
};
type StructuredCensus = {
  structuredContent?: {
    corpus: string;
    keys: { key: string; claims: number }[];
    candidates: { a: string; b: string; score: number }[];
    aliases: Record<string, string>;
    unratified: string[];
    warnings: string[];
    rankFn: string;
    content: string;
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
    const names = tools.map((t) => t.name).sort();
    // key_census is also registered; the original three must be present.
    expect(names).toContain("remember");
    expect(names).toContain("recall");
    expect(names).toContain("list_corpora");
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

// ── key_census wiring tests ────────────────────────────────────────────────────

describe("mneme MCP server (key_census wiring)", () => {
  /**
   * (6) key_census tool is advertised in the tool list.
   *     After the wiring task, the server must advertise key_census alongside the
   *     existing remember/recall/list_corpora tools.
   */
  it("advertises key_census alongside existing tools", async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toContain("key_census");
    expect(names).toEqual(
      ["audit", "declare_cardinality", "history", "inspect", "key_census", "list_corpora", "reconcile", "recall", "remember", "subject_census"].sort(),
    );
    await client.close();
  });

  /**
   * (7) key_census with no corpus argument defaults to the server's defaultCorpus.
   *     Calling key_census without specifying corpus must census the server-default
   *     corpus, NOT the hardcoded "knowledge" corpus.
   */
  it("key_census defaults to the server defaultCorpus when corpus is omitted", async () => {
    const { client } = await connected("my-default-corpus");

    // Remember into the default corpus (no corpus arg → goes to "my-default-corpus").
    await client.callTool({
      name: "remember",
      arguments: { subject: "entity:a", key: "status", value: "active" },
    });
    await client.callTool({
      name: "remember",
      arguments: { subject: "entity:b", key: "decision", value: "go" },
    });

    // Census with no corpus → should use "my-default-corpus".
    const result = (await client.callTool({
      name: "key_census",
      arguments: {},
    })) as StructuredCensus;

    expect(result.structuredContent?.corpus).toBe("my-default-corpus");
    // Both keys should appear.
    const keyNames = result.structuredContent?.keys.map((k) => k.key) ?? [];
    expect(keyNames).toContain("status");
    expect(keyNames).toContain("decision");

    await client.close();
  });

  /**
   * (8) key_census returns structuredContent with all expected fields.
   *     Verify corpus, keys, candidates, aliases, unratified, warnings, rankFn, content
   *     are all present in structuredContent.
   */
  it("key_census structuredContent has all required fields", async () => {
    const { client } = await connected("census-test");

    await client.callTool({
      name: "remember",
      arguments: { subject: "s", key: "alpha", value: "val1", corpus: "census-test" },
    });
    await client.callTool({
      name: "remember",
      arguments: { subject: "s", key: "beta", value: "val2", corpus: "census-test" },
    });

    const result = (await client.callTool({
      name: "key_census",
      arguments: { corpus: "census-test" },
    })) as StructuredCensus;

    const sc = result.structuredContent;
    expect(sc).toBeDefined();
    expect(sc?.corpus).toBe("census-test");
    expect(Array.isArray(sc?.keys)).toBe(true);
    expect(Array.isArray(sc?.candidates)).toBe(true);
    expect(typeof sc?.aliases).toBe("object");
    expect(Array.isArray(sc?.unratified)).toBe(true);
    expect(Array.isArray(sc?.warnings)).toBe(true);
    expect(typeof sc?.rankFn).toBe("string");
    expect(typeof sc?.content).toBe("string");

    await client.close();
  });

  /**
   * (9) key_census text content is human-readable and mentions key names.
   *     The text blob in content[] should reference discovered keys.
   */
  it("key_census content text mentions discovered keys", async () => {
    const { client } = await connected("census-text-test");

    await client.callTool({
      name: "remember",
      arguments: { subject: "e", key: "my-unique-key-x1", value: "v", corpus: "census-text-test" },
    });

    const result = (await client.callTool({
      name: "key_census",
      arguments: { corpus: "census-text-test" },
    })) as TextContent;

    expect(result.content[0].text).toContain("my-unique-key-x1");

    await client.close();
  });

  /**
   * (10) key_census is read-only: calling it on an unknown corpus returns empty,
   *      does not create the corpus.
   */
  it("key_census on unknown corpus returns empty result without creating the corpus", async () => {
    const { client } = await connected("existing-corpus");

    const result = (await client.callTool({
      name: "key_census",
      arguments: { corpus: "nonexistent-corpus-xyz" },
    })) as StructuredCensus;

    expect(result.structuredContent?.corpus).toBe("nonexistent-corpus-xyz");
    expect(result.structuredContent?.keys).toEqual([]);
    expect(result.structuredContent?.candidates).toEqual([]);

    // Confirm the corpus was not created by checking list_corpora.
    const corpora = (await client.callTool({ name: "list_corpora", arguments: {} })) as {
      structuredContent?: { corpora: { id: string }[] };
    };
    const ids = corpora.structuredContent?.corpora.map((c) => c.id) ?? [];
    expect(ids).not.toContain("nonexistent-corpus-xyz");

    await client.close();
  });

  /**
   * (11) recall outputSchema and structuredContent carry warnings field.
   *      After the recall wiring delta, warnings must be present in the outputSchema
   *      and structuredContent must pass it through when present.
   */
  it("recall outputSchema includes warnings field", async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();
    const recallTool = tools.find((t) => t.name === "recall");
    expect(recallTool?.outputSchema).toBeDefined();
    // The outputSchema should include a 'warnings' field (optional array of strings).
    const schema = recallTool!.outputSchema as Record<string, unknown>;
    const props = (schema as { properties?: Record<string, unknown> }).properties ?? {};
    expect("warnings" in props).toBe(true);
    await client.close();
  });

  /**
   * (12) Warnings land on stderr when census returns warnings.
   *      Spy on process.stderr.write / console.error to confirm a census invocation
   *      that produces a warning (malformed alias claim) surfaces it to stderr.
   *      The structuredContent warnings array must also contain the warning.
   */
  it("warnings from census are surfaced to stderr and in structuredContent.warnings", async () => {
    const stderrLines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((...args: Parameters<typeof process.stderr.write>) => {
      const [chunk] = args;
      if (typeof chunk === "string") stderrLines.push(chunk);
      else if (Buffer.isBuffer(chunk)) stderrLines.push(chunk.toString());
      return true;
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrLines.push(args.map(String).join(" "));
    });

    try {
      const { client } = await connected("warn-test");

      // Seed a content claim so the census has real content.
      await client.callTool({
        name: "remember",
        arguments: { subject: "e", key: "alpha", value: "go", corpus: "warn-test" },
      });

      // Seed an alias cycle (alpha → beta, beta → alpha) — aliasMapOf will
      // detect the cycle and emit a warning into structuredContent.warnings,
      // which the server then routes to stderr via console.error.
      await client.callTool({
        name: "remember",
        arguments: {
          subject: "key:alpha",
          key: "alias-of",
          value: "beta",
          corpus: "warn-test",
        },
      });
      await client.callTool({
        name: "remember",
        arguments: {
          subject: "key:beta",
          key: "alias-of",
          value: "alpha",
          corpus: "warn-test",
        },
      });

      stderrLines.length = 0; // clear setup noise

      const result = (await client.callTool({
        name: "key_census",
        arguments: { corpus: "warn-test" },
      })) as StructuredCensus;

      // structuredContent.warnings must contain the cycle warning from aliasMapOf.
      expect(result.structuredContent?.warnings.length).toBeGreaterThan(0);
      // The cycle warning must have been routed to stderr with the census prefix.
      expect(stderrLines.some((l) => l.includes("[mneme/key_census]"))).toBe(true);

      await client.close();
    } finally {
      spy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("recall with explain:true returns a trace; without it, no trace", async () => {
    const { client } = await connected("explain-test");
    await client.callTool({
      name: "remember",
      arguments: { subject: "project:mneme", key: "deploy.target", value: "us-east prod cluster", corpus: "explain-test" },
    });
    await client.callTool({
      name: "remember",
      arguments: { subject: "project:mneme", key: "deploy.cadence", value: "weekly on Tuesdays", corpus: "explain-test" },
    });

    const withoutExplain = (await client.callTool({
      name: "recall",
      arguments: { about: "deploy", corpus: "explain-test" },
    })) as { structuredContent?: { trace?: unknown; matches: { id: string }[] } };
    expect(withoutExplain.structuredContent?.trace).toBeUndefined();

    const withExplain = (await client.callTool({
      name: "recall",
      arguments: { about: "deploy", corpus: "explain-test", explain: true },
    })) as { structuredContent?: { trace?: { stageCounts?: unknown }; matches: { id: string }[] } };
    expect(withExplain.structuredContent?.trace).toBeDefined();
    expect(withExplain.structuredContent?.trace?.stageCounts).toBeDefined();
    // explain never changes the served result:
    expect(withExplain.structuredContent?.matches.map((m) => m.id))
      .toEqual(withoutExplain.structuredContent?.matches.map((m) => m.id));

    await client.close();
  });

  it("recall structuredContent carries coverage and match provenance handles", async () => {
    const { client } = await connected("covsrv");
    await client.callTool({
      name: "remember",
      arguments: { subject: "user", key: "accommodation", value: "Airbnb", tags: ["session:s1"] },
    });
    const res = (await client.callTool({
      name: "recall",
      arguments: { about: "When did I book the Airbnb in Sacramento?" },
    })) as {
      structuredContent?: {
        coverage: { entities: { text: string; supported: boolean }[]; missing: string[] };
        matches: { id: string; tags: string[] }[];
        warnings?: string[];
      };
    };
    expect(res.structuredContent?.coverage.missing).toEqual(["Sacramento"]);
    expect(res.structuredContent?.matches[0]?.id).toEqual(expect.any(String));
    expect(res.structuredContent?.matches[0]?.tags).toContain("session:s1");
    expect(res.structuredContent?.warnings?.some((w) => w.includes("no claim available to this recall"))).toBe(true);
    await client.close();
  });
});

// ── subject_census wiring tests ─────────────────────────────────────────────────

describe("mneme MCP server (subject_census wiring)", () => {
  it("advertises subject_census as read-only, idempotent, closed-world", async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.subject_census).toBeDefined();
    expect(byName.subject_census.annotations?.readOnlyHint).toBe(true);
    expect(byName.subject_census.annotations?.idempotentHint).toBe(true);
    expect(byName.subject_census.annotations?.openWorldHint).toBe(false);
    expect(byName.subject_census.outputSchema).toBeDefined();
    await client.close();
  });

  it("subject_census returns structuredContent with all expected fields and defaults corpus", async () => {
    const { client } = await connected("subj-default-corpus");

    await client.callTool({
      name: "remember",
      arguments: { subject: "project:crewtracks", key: "status", value: "active" },
    });
    await client.callTool({
      name: "remember",
      arguments: { subject: "project:crewTracks", key: "decision", value: "go" },
    });

    const result = (await client.callTool({
      name: "subject_census",
      arguments: {},
    })) as {
      structuredContent?: {
        corpus: string;
        subjects: { subject: string; claims: number }[];
        candidates: { a: string; b: string; score: number }[];
        rankFn: string;
        warnings: string[];
        content: string;
      };
    };

    const sc = result.structuredContent;
    expect(sc).toBeDefined();
    expect(sc?.corpus).toBe("subj-default-corpus");
    expect(Array.isArray(sc?.subjects)).toBe(true);
    const subjectNames = sc?.subjects.map((s) => s.subject) ?? [];
    expect(subjectNames).toContain("project:crewtracks");
    expect(subjectNames).toContain("project:crewTracks");
    expect(Array.isArray(sc?.candidates)).toBe(true);
    expect(typeof sc?.rankFn).toBe("string");
    expect(Array.isArray(sc?.warnings)).toBe(true);
    expect(typeof sc?.content).toBe("string");
    expect(sc?.content).toContain("project:crewtracks");

    await client.close();
  });

  it("subject_census is read-only: does not write any new claims", async () => {
    const { client } = await connected("subj-readonly");

    await client.callTool({
      name: "remember",
      arguments: { subject: "entity:a", key: "status", value: "active", corpus: "subj-readonly" },
    });

    const censusBefore = (await client.callTool({
      name: "recall",
      arguments: { about: "active", corpus: "subj-readonly" },
    })) as { structuredContent?: { matches: unknown[] } };
    const countBefore = censusBefore.structuredContent?.matches.length ?? 0;

    await client.callTool({
      name: "subject_census",
      arguments: { corpus: "subj-readonly" },
    });

    const censusAfter = (await client.callTool({
      name: "recall",
      arguments: { about: "active", corpus: "subj-readonly" },
    })) as { structuredContent?: { matches: unknown[] } };
    const countAfter = censusAfter.structuredContent?.matches.length ?? 0;

    expect(countAfter).toBe(countBefore);

    await client.close();
  });
});

// ── reconcile wiring tests ───────────────────────────────────────────────────────

describe("mneme MCP server (reconcile wiring)", () => {
  it("advertises reconcile as read-only, idempotent, closed-world", async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.reconcile).toBeDefined();
    expect(byName.reconcile.annotations?.readOnlyHint).toBe(true);
    expect(byName.reconcile.annotations?.idempotentHint).toBe(true);
    expect(byName.reconcile.annotations?.openWorldHint).toBe(false);
    expect(byName.reconcile.outputSchema).toBeDefined();
    await client.close();
  });

  it("reconcile returns dispositions for subjects and keys, defaults corpus", async () => {
    const { client } = await connected("rec-default-corpus");

    await client.callTool({
      name: "remember",
      arguments: { subject: "project:crewtracks", key: "status", value: "active" },
    });

    const result = (await client.callTool({
      name: "reconcile",
      arguments: {
        subjects: ["project:crewTracks", "division:traffic-control"],
        keys: ["status"],
      },
    })) as {
      structuredContent?: {
        corpus: string;
        subjects: { candidate: string; suggestions: { existing: string; score: number }[]; disposition: string }[];
        keys: { candidate: string; suggestions: { existing: string; score: number }[]; disposition: string }[];
        rankFn: string;
        warnings: string[];
        content: string;
      };
    };

    const sc = result.structuredContent;
    expect(sc).toBeDefined();
    expect(sc?.corpus).toBe("rec-default-corpus");
    expect(sc?.subjects).toHaveLength(2);
    expect(sc?.subjects[0].disposition).toBe("reuse");
    expect(sc?.subjects[0].suggestions[0]?.existing).toBe("project:crewtracks");
    expect(sc?.subjects[1].disposition).toBe("new");
    expect(sc?.keys).toHaveLength(1);
    expect(sc?.keys[0].disposition).toBe("reuse");
    expect(typeof sc?.rankFn).toBe("string");
    expect(Array.isArray(sc?.warnings)).toBe(true);
    expect(typeof sc?.content).toBe("string");

    await client.close();
  });

  it("reconcile accepts custom thresholds and limit", async () => {
    const { client } = await connected("rec-thresholds");

    await client.callTool({
      name: "remember",
      arguments: { subject: "widget", key: "status", value: "active", corpus: "rec-thresholds" },
    });

    const result = (await client.callTool({
      name: "reconcile",
      arguments: {
        corpus: "rec-thresholds",
        subjects: ["widget-extra"],
        newThreshold: 0.2,
        reuseThreshold: 0.9,
      },
    })) as {
      structuredContent?: {
        subjects: { disposition: string; suggestions: { score: number }[] }[];
      };
    };

    expect(result.structuredContent?.subjects[0].disposition).toBe("uncertain");
    expect(result.structuredContent?.subjects[0].suggestions[0].score).toBeCloseTo(0.5, 5);

    await client.close();
  });

  it("reconcile is read-only: does not write any new claims", async () => {
    const { client } = await connected("rec-readonly");

    await client.callTool({
      name: "remember",
      arguments: { subject: "entity:a", key: "status", value: "active", corpus: "rec-readonly" },
    });

    const censusBefore = (await client.callTool({
      name: "recall",
      arguments: { about: "active", corpus: "rec-readonly" },
    })) as { structuredContent?: { matches: unknown[] } };
    const countBefore = censusBefore.structuredContent?.matches.length ?? 0;

    await client.callTool({
      name: "reconcile",
      arguments: { corpus: "rec-readonly", subjects: ["entity:a", "entity:b"], keys: ["status", "new-key"] },
    });

    const censusAfter = (await client.callTool({
      name: "recall",
      arguments: { about: "active", corpus: "rec-readonly" },
    })) as { structuredContent?: { matches: unknown[] } };
    const countAfter = censusAfter.structuredContent?.matches.length ?? 0;

    expect(countAfter).toBe(countBefore);

    await client.close();
  });
});

// ── declare_cardinality wiring tests ────────────────────────────────────────────

describe("mneme MCP server (declare_cardinality wiring)", () => {
  it("advertises declare_cardinality as a write, idempotent, closed-world tool", async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.declare_cardinality).toBeDefined();
    expect(byName.declare_cardinality.annotations?.readOnlyHint).toBe(false);
    expect(byName.declare_cardinality.annotations?.idempotentHint).toBe(true);
    expect(byName.declare_cardinality.annotations?.openWorldHint).toBe(false);
    expect(byName.declare_cardinality.outputSchema).toBeDefined();
    await client.close();
  });

  it("declare_cardinality makes a single-cardinality key coexist and clears the warning", async () => {
    const { client } = await connected();

    async function callTool(name: string, args: Record<string, unknown>) {
      return (await client.callTool({ name, arguments: args })) as {
        structuredContent?: Record<string, unknown>;
      };
    }

    await callTool("remember", { subject: "proj", key: "plan", value: "alpha", corpus: "cc" });
    await callTool("remember", { subject: "proj", key: "plan", value: "bravo", corpus: "cc" });
    const before = await callTool("recall", { about: "plan", subject: "proj", key: "plan", corpus: "cc" });
    expect(
      (before.structuredContent?.warnings as string[] | undefined)?.some((w) => /single-cardinality/.test(w)),
    ).toBe(true);

    const decl = await callTool("declare_cardinality", { corpus: "cc", cardinality: { plan: "multi" } });
    expect(decl.structuredContent?.keyCardinality).toMatchObject({ plan: "multi" });

    const after = await callTool("recall", { about: "plan", subject: "proj", key: "plan", corpus: "cc" });
    expect((after.structuredContent?.matches as unknown[]).length).toBe(2); // both coexist
    expect(
      (after.structuredContent?.warnings as string[] | undefined)?.some((w) => /single-cardinality/.test(w)),
    ).toBeFalsy();

    await client.close();
  });
});

// ── remember supersession wiring tests ──────────────────────────────────────────

describe("mneme MCP server (remember supersession wiring)", () => {
  it("remember outputSchema advertises an optional supersession field", async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();
    const rememberTool = tools.find((t) => t.name === "remember");
    expect(rememberTool?.outputSchema).toBeDefined();
    const schema = rememberTool!.outputSchema as { properties?: Record<string, unknown> };
    expect("supersession" in (schema.properties ?? {})).toBe(true);
    await client.close();
  });

  it("a distinct value under a single-cardinality key returns supersession.action=superseded with deprecatedIds", async () => {
    const { client } = await connected("supersession-test");

    const first = (await client.callTool({
      name: "remember",
      arguments: { subject: "proj:x", key: "plan", value: "alpha", corpus: "supersession-test" },
    })) as { structuredContent?: { id: string; supersession?: { action: string; deprecatedIds: string[] } } };
    expect(first.structuredContent?.supersession?.action).toBe("committed");
    const firstId = first.structuredContent?.id;

    const second = (await client.callTool({
      name: "remember",
      arguments: { subject: "proj:x", key: "plan", value: "bravo", corpus: "supersession-test" },
    })) as {
      structuredContent?: { id: string; supersession?: { action: string; deprecatedIds: string[] } };
      content: { type: string; text: string }[];
    };

    expect(second.structuredContent?.supersession?.action).toBe("superseded");
    expect(second.structuredContent?.supersession?.deprecatedIds).toContain(firstId);
    expect(second.structuredContent?.supersession?.deprecatedIds.length).toBeGreaterThan(0);
    expect(second.content[0].text).toMatch(/superseded 1 earlier claim/);

    await client.close();
  });
});

// ── audit wiring tests ───────────────────────────────────────────────────────────

describe("mneme MCP server (audit wiring)", () => {
  it("advertises audit as read-only, idempotent, closed-world", async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.audit).toBeDefined();
    expect(byName.audit.annotations?.readOnlyHint).toBe(true);
    expect(byName.audit.annotations?.idempotentHint).toBe(true);
    expect(byName.audit.annotations?.openWorldHint).toBe(false);
    expect(byName.audit.outputSchema).toBeDefined();
    await client.close();
  });

  it("audit structuredContent has all required fields and defaults corpus", async () => {
    const { client } = await connected("audit-default-corpus");

    await client.callTool({
      name: "remember",
      arguments: { subject: "user:brett", key: "editor", value: "vim" },
    });
    await client.callTool({
      name: "remember",
      arguments: { subject: "user:brett", key: "preferred_editor", value: "emacs" },
    });

    const result = (await client.callTool({
      name: "audit",
      arguments: {},
    })) as {
      structuredContent?: {
        corpus: string;
        proposals: { kind: string; entities: string[]; claimsAffected: number; suggestedAction: string; detail: string }[];
        rankFn: string;
        warnings: string[];
        content: string;
      };
    };

    const sc = result.structuredContent;
    expect(sc).toBeDefined();
    expect(sc?.corpus).toBe("audit-default-corpus");
    expect(Array.isArray(sc?.proposals)).toBe(true);
    expect(typeof sc?.rankFn).toBe("string");
    expect(Array.isArray(sc?.warnings)).toBe(true);
    expect(typeof sc?.content).toBe("string");
    expect(sc?.content).toContain("Audit");

    await client.close();
  });

  it("audit proposes a cardinality-declare for a single-cardinality collision; the tool itself writes nothing; declare_cardinality then clears it on re-audit", async () => {
    const { client } = await connected("audit-cc");

    async function callTool(name: string, args: Record<string, unknown>) {
      return (await client.callTool({ name, arguments: args })) as {
        structuredContent?: Record<string, unknown>;
      };
    }

    await callTool("remember", { subject: "proj", key: "plan", value: "alpha", corpus: "audit-cc" });
    await callTool("remember", { subject: "proj", key: "plan", value: "bravo", corpus: "audit-cc" });

    const before = await callTool("recall", { about: "plan", subject: "proj", key: "plan", corpus: "audit-cc" });
    const countBefore = (before.structuredContent?.matches as unknown[]).length;

    const auditResult1 = await callTool("audit", { corpus: "audit-cc" });
    const proposals1 = (auditResult1.structuredContent?.proposals ?? []) as { kind: string; entities: string[] }[];
    const cardProposal = proposals1.find((p) => p.kind === "cardinality-declare" && p.entities.includes("plan"));
    expect(cardProposal).toBeDefined();

    // Charter I3: audit is propose-then-confirm, never auto-applied — claim count
    // and served matches must be unchanged before/after the audit call itself.
    const afterAudit = await callTool("recall", { about: "plan", subject: "proj", key: "plan", corpus: "audit-cc" });
    const countAfterAudit = (afterAudit.structuredContent?.matches as unknown[]).length;
    expect(countAfterAudit).toBe(countBefore);

    // Applying the proposal is a separate, explicit agent action...
    await callTool("declare_cardinality", { corpus: "audit-cc", cardinality: { plan: "multi" } });

    // ...which clears the proposal on re-audit.
    const auditResult2 = await callTool("audit", { corpus: "audit-cc" });
    const proposals2 = (auditResult2.structuredContent?.proposals ?? []) as { kind: string; entities: string[] }[];
    expect(proposals2.some((p) => p.kind === "cardinality-declare" && p.entities.includes("plan"))).toBe(false);

    await client.close();
  });
});

// ── MNEME_WRITE_SCHEMA instructions ────────────────────────────────────────────

describe("mneme MCP server (instructions)", () => {
  it("server instructions reference audit as a periodic maintenance pass", async () => {
    const { client } = await connected();
    const instructions = client.getInstructions();
    expect(instructions).toBeDefined();
    expect(instructions).toMatch(/run audit periodically/i);
    expect(instructions).toMatch(/propose-then-confirm/i);
    expect(instructions).toMatch(/never auto-applied/i);
    await client.close();
  });
});

// ── history (lineage) wiring tests ──────────────────────────────────────────────

describe("mneme MCP server (history wiring)", () => {
  it("advertises history as read-only, idempotent, closed-world", async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.history).toBeDefined();
    expect(byName.history.annotations?.readOnlyHint).toBe(true);
    expect(byName.history.annotations?.idempotentHint).toBe(true);
    expect(byName.history.annotations?.openWorldHint).toBe(false);
    expect(byName.history.outputSchema).toBeDefined();
    await client.close();
  });

  it("returns all versions of a superseded (subject,key), latest served and older deprecated", async () => {
    const { client } = await connected("history-test");

    const first = (await client.callTool({
      name: "remember",
      arguments: { subject: "proj:h", key: "plan", value: "alpha", corpus: "history-test" },
    })) as { structuredContent?: { id: string } };
    const second = (await client.callTool({
      name: "remember",
      arguments: { subject: "proj:h", key: "plan", value: "bravo", corpus: "history-test" },
    })) as { structuredContent?: { id: string } };

    const result = (await client.callTool({
      name: "history",
      arguments: { corpus: "history-test", subject: "proj:h", key: "plan" },
    })) as {
      structuredContent?: {
        corpus: string;
        subject: string;
        key: string;
        asOf: number;
        entries: { id: string; value: unknown; disposition: string }[];
        content: string;
      };
    };

    const sc = result.structuredContent;
    expect(sc).toBeDefined();
    expect(sc?.corpus).toBe("history-test");
    expect(sc?.subject).toBe("proj:h");
    expect(sc?.key).toBe("plan");
    expect(typeof sc?.asOf).toBe("number");
    expect(sc?.entries).toHaveLength(2);

    const byId = Object.fromEntries((sc?.entries ?? []).map((e) => [e.id, e]));
    expect(byId[first.structuredContent!.id]?.disposition).toBe("deprecated");
    expect(byId[second.structuredContent!.id]?.disposition).toBe("served");
    expect(byId[first.structuredContent!.id]?.value).toBe("alpha");
    expect(byId[second.structuredContent!.id]?.value).toBe("bravo");

    await client.close();
  });

  it("history defaults corpus to the server defaultCorpus when omitted", async () => {
    const { client } = await connected("hist-default-corpus");

    await client.callTool({
      name: "remember",
      arguments: { subject: "proj:d", key: "status", value: "active" },
    });

    const result = (await client.callTool({
      name: "history",
      arguments: { subject: "proj:d", key: "status" },
    })) as { structuredContent?: { corpus: string; entries: unknown[] } };

    expect(result.structuredContent?.corpus).toBe("hist-default-corpus");
    expect(result.structuredContent?.entries).toHaveLength(1);

    await client.close();
  });

  it("history is read-only: does not write any new claims nor create an unknown corpus", async () => {
    const { client } = await connected("hist-readonly");

    await client.callTool({
      name: "remember",
      arguments: { subject: "entity:a", key: "status", value: "active", corpus: "hist-readonly" },
    });

    const result = (await client.callTool({
      name: "history",
      arguments: { corpus: "nonexistent-corpus-hist", subject: "entity:a", key: "status" },
    })) as { structuredContent?: { entries: unknown[] } };
    expect(result.structuredContent?.entries).toEqual([]);

    const corpora = (await client.callTool({ name: "list_corpora", arguments: {} })) as {
      structuredContent?: { corpora: { id: string }[] };
    };
    const ids = corpora.structuredContent?.corpora.map((c) => c.id) ?? [];
    expect(ids).not.toContain("nonexistent-corpus-hist");

    await client.close();
  });
});

// ── inspect (raw claim) wiring tests ────────────────────────────────────────────

describe("mneme MCP server (inspect wiring)", () => {
  it("advertises inspect as read-only, idempotent, closed-world", async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.inspect).toBeDefined();
    expect(byName.inspect.annotations?.readOnlyHint).toBe(true);
    expect(byName.inspect.annotations?.idempotentHint).toBe(true);
    expect(byName.inspect.annotations?.openWorldHint).toBe(false);
    expect(byName.inspect.outputSchema).toBeDefined();
    await client.close();
  });

  it("returns the raw claim's fields for a written claim id", async () => {
    const { client } = await connected("inspect-test");

    const rem = (await client.callTool({
      name: "remember",
      arguments: { subject: "proj:i", key: "status", value: "active", confidence: 0.8, corpus: "inspect-test" },
    })) as { structuredContent?: { id: string } };
    const claimId = rem.structuredContent!.id;

    const result = (await client.callTool({
      name: "inspect",
      arguments: { corpus: "inspect-test", claimId },
    })) as {
      structuredContent?: {
        found: boolean;
        id: string;
        subject: string;
        key: string;
        value: unknown;
        confidence: number;
      };
    };

    const sc = result.structuredContent;
    expect(sc?.found).toBe(true);
    expect(sc?.id).toBe(claimId);
    expect(sc?.subject).toBe("proj:i");
    expect(sc?.key).toBe("status");
    expect(sc?.value).toBe("active");
    expect(typeof sc?.confidence).toBe("number");

    await client.close();
  });

  it("returns found:false for a missing claim id", async () => {
    const { client } = await connected("inspect-missing");
    // Seed the corpus so it exists (inspect on a truly unknown corpus is out of scope here).
    await client.callTool({
      name: "remember",
      arguments: { subject: "entity:a", key: "status", value: "active", corpus: "inspect-missing" },
    });

    const result = (await client.callTool({
      name: "inspect",
      arguments: { corpus: "inspect-missing", claimId: "nonexistent-claim-id" },
    })) as { structuredContent?: { found: boolean; claimId: string } };

    expect(result.structuredContent?.found).toBe(false);
    expect(result.structuredContent?.claimId).toBe("nonexistent-claim-id");

    await client.close();
  });

  it("inspect is read-only: does not write any new claims", async () => {
    const { client } = await connected("inspect-readonly");

    await client.callTool({
      name: "remember",
      arguments: { subject: "entity:a", key: "status", value: "active", corpus: "inspect-readonly" },
    });

    const before = (await client.callTool({
      name: "recall",
      arguments: { about: "active", corpus: "inspect-readonly" },
    })) as { structuredContent?: { matches: unknown[] } };
    const countBefore = before.structuredContent?.matches.length ?? 0;

    await client.callTool({
      name: "inspect",
      arguments: { corpus: "inspect-readonly", claimId: "some-id" },
    });

    const after = (await client.callTool({
      name: "recall",
      arguments: { about: "active", corpus: "inspect-readonly" },
    })) as { structuredContent?: { matches: unknown[] } };
    const countAfter = after.structuredContent?.matches.length ?? 0;

    expect(countAfter).toBe(countBefore);

    await client.close();
  });
});
