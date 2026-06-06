/**
 * Integration tests for the key-matching slice at the MCP boundary.
 *
 * Scenario: editor drift → key_census candidates → alias ratification →
 * recall resolves to winner; loser is NOT deleted (the wedge).
 *
 * Key names use hyphen-separated tokens (e.g. "preferred-editor") so the
 * jaccard tokenizer (which splits on \W+, treating _ as a word char) produces
 * a non-zero overlap with the canonical key "editor".
 *
 * House pattern: mirrors server.integration.test.ts harness
 *   (createMnemeMcpServer + InMemoryTransport + client.callTool).
 *
 * Embedding strategy: prime jaccard singleton before any recall —
 * same _resetEmbeddingsForTest / initEmbeddings pattern as server.integration.test.ts.
 */
import { beforeAll, describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMnemeMcpServer } from "./server.js";
import { _resetEmbeddingsForTest, initEmbeddings } from "./embeddings.js";
import { openSession } from "../surface/index.js";

// ── Type aliases (mirror server.integration.test.ts) ──────────────────────────

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
beforeAll(async () => {
  _resetEmbeddingsForTest();
  await initEmbeddings(async () => { throw new Error("no model in CI"); });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), "mneme-km-int-"));
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

// ── Key-matching integration tests ────────────────────────────────────────────

describe("mneme MCP key-matching (detect → declare → contest loop)", () => {
  /**
   * Full scenario:
   *   1. remember(editor=vim, earlier) + remember(preferred-editor=emacs, later)
   *   2. key_census → candidates include {editor, preferred-editor} pair with score > 0
   *      (jaccard: both tokenize to include "editor")
   *   3. remember({ subject: "key:preferred-editor", key: "alias-of", value: "editor" })
   *   4. recall(key: "editor") → only emacs; recall(key: "preferred-editor") → only emacs
   *   5. key_census → alias present in resolved aliases
   *   6. remember self-alias (later) → census lists preferred-editor as un-ratified; both serve
   */

  it("pre-ratification: both drifted claims serve and census surfaces the scored pair", async () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "store.db");
    const { client } = await connected("editor-drift", dbPath);

    // Step 1: write vim first (earlier valid.from), emacs later
    const t1 = new Date(Date.now() - 5000).toISOString();
    const t2 = new Date(Date.now() - 1000).toISOString();

    await client.callTool({
      name: "remember",
      arguments: {
        subject: "user:default",
        key: "editor",
        value: "vim",
        corpus: "editor-drift",
        validFrom: t1,
      },
    });
    await client.callTool({
      name: "remember",
      arguments: {
        subject: "user:default",
        key: "preferred-editor",
        value: "emacs",
        corpus: "editor-drift",
        validFrom: t2,
      },
    });

    // Both claims serve (different keys — no resolution without alias)
    const rec = (await client.callTool({
      name: "recall",
      arguments: { about: "editor preference", corpus: "editor-drift" },
    })) as StructuredRecall;

    const matchKeys = rec.structuredContent?.matches.map((m) => m.key) ?? [];
    expect(matchKeys).toContain("editor");
    expect(matchKeys).toContain("preferred-editor");

    // key_census surfaces the editor/preferred-editor pair with non-zero score
    // (jaccard: "editor" is a shared token; editor ∩ {preferred, editor} = {editor})
    const census = (await client.callTool({
      name: "key_census",
      arguments: { corpus: "editor-drift" },
    })) as StructuredCensus;

    const candidatePairs = census.structuredContent?.candidates ?? [];
    const pair = candidatePairs.find(
      (c) =>
        (c.a === "editor" && c.b === "preferred-editor") ||
        (c.a === "preferred-editor" && c.b === "editor"),
    );
    expect(pair).toBeDefined();
    expect(pair!.score).toBeGreaterThan(0);

    await client.close();
  });

  it("post-ratification: both key directions retrieve only the winner (emacs)", async () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "store.db");
    const { client } = await connected("ratify-test", dbPath);

    const t1 = new Date(Date.now() - 5000).toISOString();
    const t2 = new Date(Date.now() - 1000).toISOString();

    // Step 1: vim (earlier) then emacs (later) on different keys
    await client.callTool({
      name: "remember",
      arguments: {
        subject: "user:default",
        key: "editor",
        value: "vim",
        corpus: "ratify-test",
        validFrom: t1,
      },
    });
    await client.callTool({
      name: "remember",
      arguments: {
        subject: "user:default",
        key: "preferred-editor",
        value: "emacs",
        corpus: "ratify-test",
        validFrom: t2,
      },
    });

    // Step 3: ratify preferred-editor as alias of editor
    await client.callTool({
      name: "remember",
      arguments: {
        subject: "key:preferred-editor",
        key: "alias-of",
        value: "editor",
        corpus: "ratify-test",
      },
    });

    // Step 4a: recall by canonical key "editor" → only emacs (newer claim wins under resolveDeprecateOlder)
    const recByCanonical = (await client.callTool({
      name: "recall",
      arguments: { about: "editor preference", key: "editor", corpus: "ratify-test" },
    })) as StructuredRecall;

    const canonicalValues = recByCanonical.structuredContent?.matches.map((m) => m.value) ?? [];
    expect(canonicalValues).toContain("emacs");
    expect(canonicalValues).not.toContain("vim");

    // Step 4b: recall by variant key "preferred-editor" → also only emacs (family expansion)
    const recByVariant = (await client.callTool({
      name: "recall",
      arguments: { about: "editor preference", key: "preferred-editor", corpus: "ratify-test" },
    })) as StructuredRecall;

    const variantValues = recByVariant.structuredContent?.matches.map((m) => m.value) ?? [];
    expect(variantValues).toContain("emacs");
    expect(variantValues).not.toContain("vim");

    await client.close();
  });

  it("ratification flips drift into supersession without deleting the loser", async () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "store.db");
    const { client } = await connected("no-delete-test", dbPath);

    const t1 = new Date(Date.now() - 5000).toISOString();
    const t2 = new Date(Date.now() - 1000).toISOString();

    // Step 1: vim (earlier) then emacs (later)
    await client.callTool({
      name: "remember",
      arguments: {
        subject: "user:default",
        key: "editor",
        value: "vim",
        corpus: "no-delete-test",
        validFrom: t1,
      },
    });
    await client.callTool({
      name: "remember",
      arguments: {
        subject: "user:default",
        key: "preferred-editor",
        value: "emacs",
        corpus: "no-delete-test",
        validFrom: t2,
      },
    });

    // Pre-ratification: 2 distinct content keys in census
    const preRatifyCensus = (await client.callTool({
      name: "key_census",
      arguments: { corpus: "no-delete-test" },
    })) as StructuredCensus;
    expect(preRatifyCensus.structuredContent?.keys.length).toBe(2);

    // Step 3: ratify preferred-editor → editor
    await client.callTool({
      name: "remember",
      arguments: {
        subject: "key:preferred-editor",
        key: "alias-of",
        value: "editor",
        corpus: "no-delete-test",
      },
    });

    // Step 4: recall by canonical key → only emacs
    const recAfter = (await client.callTool({
      name: "recall",
      arguments: { about: "editor preference", key: "editor", corpus: "no-delete-test" },
    })) as StructuredRecall;
    expect(recAfter.structuredContent?.matches.map((m) => m.value)).toContain("emacs");
    expect(recAfter.structuredContent?.matches.map((m) => m.value)).not.toContain("vim");

    // NON-DESTRUCTIVE CHECK:
    // The ledger is append-only; the store physically keeps both claims.
    // Open a raw session on the same dbPath and read all claims — the vim claim
    // must still be present. Deprecation is applied at READ time by the canonical
    // pipeline; the raw store record is never physically deleted.
    const rawSession = openSession({ dbPath, writer: "test-reader" });
    const allRawClaims = rawSession.mneme.read("no-delete-test", { corpusId: "no-delete-test" });
    const vimClaim = allRawClaims.find(
      (c) => c.key === "editor" && c.value === "vim",
    );
    // vim claim exists in raw store (non-destructive — the Mneme wedge)
    expect(vimClaim).toBeDefined();
    // Status in the raw store is its committed status (e.g. "validated") — NOT "deleted"
    // (deprecation is a read-time view, not a physical mutation of the store record)
    expect(vimClaim?.status).not.toBe("deleted");

    await client.close();
  });

  it("post-ratification census shows resolved alias", async () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "store.db");
    const { client } = await connected("alias-census-test", dbPath);

    const t1 = new Date(Date.now() - 5000).toISOString();
    const t2 = new Date(Date.now() - 1000).toISOString();

    await client.callTool({
      name: "remember",
      arguments: {
        subject: "user:default",
        key: "editor",
        value: "vim",
        corpus: "alias-census-test",
        validFrom: t1,
      },
    });
    await client.callTool({
      name: "remember",
      arguments: {
        subject: "user:default",
        key: "preferred-editor",
        value: "emacs",
        corpus: "alias-census-test",
        validFrom: t2,
      },
    });

    // Ratify preferred-editor → editor
    await client.callTool({
      name: "remember",
      arguments: {
        subject: "key:preferred-editor",
        key: "alias-of",
        value: "editor",
        corpus: "alias-census-test",
      },
    });

    // Step 5: census after ratification shows alias
    const census = (await client.callTool({
      name: "key_census",
      arguments: { corpus: "alias-census-test" },
    })) as StructuredCensus;

    const aliases = census.structuredContent?.aliases ?? {};
    expect(aliases["preferred-editor"]).toBe("editor");

    await client.close();
  });

  it("self-alias un-ratifies the alias and restores both-serve behavior", async () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "store.db");
    const { client } = await connected("unratify-test", dbPath);

    const t1 = new Date(Date.now() - 5000).toISOString();
    const t2 = new Date(Date.now() - 2000).toISOString();
    const t3 = new Date(Date.now() - 500).toISOString();

    // Step 1: write two drifted editor claims
    await client.callTool({
      name: "remember",
      arguments: {
        subject: "user:default",
        key: "editor",
        value: "vim",
        corpus: "unratify-test",
        validFrom: t1,
      },
    });
    await client.callTool({
      name: "remember",
      arguments: {
        subject: "user:default",
        key: "preferred-editor",
        value: "emacs",
        corpus: "unratify-test",
        validFrom: t2,
      },
    });

    // Step 3: ratify preferred-editor → editor (t2)
    await client.callTool({
      name: "remember",
      arguments: {
        subject: "key:preferred-editor",
        key: "alias-of",
        value: "editor",
        corpus: "unratify-test",
        validFrom: t2,
      },
    });

    // Confirm alias is in place after ratification
    const ratiCensus = (await client.callTool({
      name: "key_census",
      arguments: { corpus: "unratify-test" },
    })) as StructuredCensus;
    expect(ratiCensus.structuredContent?.aliases?.["preferred-editor"]).toBe("editor");

    // Step 6: un-ratify via self-alias written LATER (t3 > t2 → supersedes the real alias)
    await client.callTool({
      name: "remember",
      arguments: {
        subject: "key:preferred-editor",
        key: "alias-of",
        value: "preferred-editor", // self-alias: variant maps to itself
        corpus: "unratify-test",
        validFrom: t3,
      },
    });

    // Census now lists preferred-editor in unratified (self-alias, not a real mapping)
    const census = (await client.callTool({
      name: "key_census",
      arguments: { corpus: "unratify-test" },
    })) as StructuredCensus;

    const unratified = census.structuredContent?.unratified ?? [];
    expect(unratified).toContain("preferred-editor");

    // Resolved aliases should NOT contain preferred-editor anymore
    const aliases = census.structuredContent?.aliases ?? {};
    expect(aliases["preferred-editor"]).toBeUndefined();

    // Both-serve behavior restored: recall without key filter returns both values
    const rec = (await client.callTool({
      name: "recall",
      arguments: { about: "editor preference", corpus: "unratify-test" },
    })) as StructuredRecall;

    const matchValues = rec.structuredContent?.matches.map((m) => m.value) ?? [];
    expect(matchValues).toContain("vim");
    expect(matchValues).toContain("emacs");

    await client.close();
  });
});
