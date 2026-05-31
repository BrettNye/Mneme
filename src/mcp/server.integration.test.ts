import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMnemeMcpServer } from "./server.js";

type TextContent = { content: { type: string; text: string }[] };

async function connected(corpus = "dev") {
  const dbPath = join(mkdtempSync(join(tmpdir(), "mneme-mcp-int-")), "store.db");
  const { server } = createMnemeMcpServer({ dbPath, defaultCorpus: corpus });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("mneme MCP server (protocol)", () => {
  it("advertises remember / recall / list_corpora over MCP", async () => {
    const client = await connected();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["list_corpora", "recall", "remember"]);
    await client.close();
  });

  it("remember then recall round-trips through tool calls", async () => {
    const client = await connected();

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
    const client = await connected("A");
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
});
