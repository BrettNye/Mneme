import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMnemeMcpServer } from "./server.js";

describe("createMnemeMcpServer", () => {
  it("builds a server bound to the given db + corpus without connecting", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "mneme-mcp-srv-")), "store.db");
    const { server, defaultCorpus, dbPath: usedPath } = createMnemeMcpServer({ dbPath, defaultCorpus: "dev" });
    expect(server).toBeDefined();
    expect(typeof server.connect).toBe("function");
    expect(defaultCorpus).toBe("dev");
    expect(usedPath).toBe(dbPath);
  });
});
