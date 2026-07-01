import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMnemeEngine } from "mneme/mcp";
import plugin from "./index.js";

// Prime the jaccard-fallback embedding singleton (see src/mcp/engine.test.ts) so the
// first recall in these tests is fast/deterministic instead of loading a real model.
// `initEmbeddings` is a module-level singleton shared by every engine instance, so
// priming it once here — via the publicly exported openMnemeEngine — is enough for
// every plugin.register() call in this file to reuse the cached jaccard fallback.
beforeAll(async () => {
  const primingDbPath = join(mkdtempSync(join(tmpdir(), "memory-mneme-priming-")), "store.db");
  const primingEngine = openMnemeEngine({ dbPath: primingDbPath, corpus: "priming" });
  await primingEngine.initEmbeddings(async () => {
    throw new Error("no model in CI");
  });
});

function makeApi(pluginConfig: any) {
  const tools: Record<string, any> = {};
  const handlers: { event: string; handler: any }[] = [];
  const api = {
    pluginConfig,
    registerTool(def: any, _meta?: any) {
      tools[def.name] = def;
    },
    registerCli() {},
    on(event: string, handler: any) {
      handlers.push({ event, handler });
    },
  };
  return { api, tools, handlers };
}

describe("memory-mneme plugin", () => {
  it("registers the four memory tools and one before_agent_start handler, never agent_end", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "memory-mneme-")), "store.db");
    const { api, tools, handlers } = makeApi({ dbPath, corpus: "test" });
    plugin.register(api);

    expect(Object.keys(tools).sort()).toEqual(
      ["memory_corpora", "memory_key_census", "memory_recall", "memory_remember"].sort(),
    );
    expect(handlers.filter((h) => h.event === "before_agent_start")).toHaveLength(1);
    expect(handlers.some((h) => h.event === "agent_end")).toBe(false);
  });

  it("does not register a before_agent_start handler when autoRecall is false", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "memory-mneme-")), "store.db");
    const { api, handlers } = makeApi({ dbPath, corpus: "test", autoRecall: false });
    plugin.register(api);

    expect(handlers.filter((h) => h.event === "before_agent_start")).toHaveLength(0);
    expect(handlers.some((h) => h.event === "agent_end")).toBe(false);
  });

  it("remember then recall round-trips through the mneme engine", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "memory-mneme-")), "store.db");
    const { api, tools } = makeApi({ dbPath, corpus: "test" });
    plugin.register(api);

    await tools["memory_remember"].execute("1", {
      subject: "project:mneme",
      key: "status",
      value: "green",
      confidence: 0.8,
    });
    const out = await tools["memory_recall"].execute("2", { about: "mneme status" });
    expect(out.content[0].text).toContain("green");
  });

  it("memory_corpora lists the configured corpus after a write", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "memory-mneme-")), "store.db");
    const { api, tools } = makeApi({ dbPath, corpus: "test" });
    plugin.register(api);

    await tools["memory_remember"].execute("1", { subject: "s", key: "k", value: "v" });
    const out = await tools["memory_corpora"].execute("2", {});
    expect(out.content[0].text).toContain("test");
  });

  it("memory_key_census reports the written key", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "memory-mneme-")), "store.db");
    const { api, tools } = makeApi({ dbPath, corpus: "test" });
    plugin.register(api);

    await tools["memory_remember"].execute("1", { subject: "s", key: "some-key", value: "v" });
    const out = await tools["memory_key_census"].execute("2", {});
    expect(out.content[0].text).toContain("some-key");
  });

  it("passes mergeScope(defaultScope, params.scope) as the claim scope (write keys win)", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "memory-mneme-")), "store.db");
    const { api, tools } = makeApi({
      dbPath,
      corpus: "test",
      defaultScope: { project: "mneme", context: "default-ctx" },
    });
    plugin.register(api);

    await tools["memory_remember"].execute("1", {
      subject: "scope:subject",
      key: "scope-key",
      value: "v",
      scope: { context: "write-ctx" },
    });

    const eng = openMnemeEngine({ dbPath, corpus: "test" });
    const claims = eng.session.mneme.read("test", {
      corpusId: "test",
      subject: "scope:subject",
      key: "scope-key",
    });
    expect(claims).toHaveLength(1);
    expect(claims[0].scope).toEqual({ project: "mneme", context: "write-ctx" });
  });

  describe("before_agent_start auto-recall hook", () => {
    it("returns undefined when recall content is blank", async () => {
      const dbPath = join(mkdtempSync(join(tmpdir(), "memory-mneme-")), "store.db");
      const { api, handlers } = makeApi({ dbPath, corpus: "test" });
      plugin.register(api);

      const hook = handlers.find((h) => h.event === "before_agent_start")!.handler;
      const result = await hook({ prompt: "nothing has ever been recorded about this" });
      expect(result).toBeUndefined();
    });

    it("returns undefined for a blank prompt without querying recall", async () => {
      const dbPath = join(mkdtempSync(join(tmpdir(), "memory-mneme-")), "store.db");
      const { api, handlers } = makeApi({ dbPath, corpus: "test" });
      plugin.register(api);

      const hook = handlers.find((h) => h.event === "before_agent_start")!.handler;
      const result = await hook({ prompt: "   " });
      expect(result).toBeUndefined();
    });

    it("returns { prependContext } wrapping recall content via wrapMemories when non-empty", async () => {
      const dbPath = join(mkdtempSync(join(tmpdir(), "memory-mneme-")), "store.db");
      const { api, tools, handlers } = makeApi({ dbPath, corpus: "test" });
      plugin.register(api);

      await tools["memory_remember"].execute("1", {
        subject: "project:mneme",
        key: "status",
        value: "green",
        confidence: 0.8,
      });

      const hook = handlers.find((h) => h.event === "before_agent_start")!.handler;
      const result = await hook({ prompt: "what is the mneme status" });
      expect(result).toBeDefined();
      expect(result.prependContext.startsWith("<relevant-memories>")).toBe(true);
      expect(result.prependContext.trim().endsWith("</relevant-memories>")).toBe(true);
      expect(result.prependContext).toContain("green");
    });
  });
});
