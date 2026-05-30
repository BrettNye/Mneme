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
});
