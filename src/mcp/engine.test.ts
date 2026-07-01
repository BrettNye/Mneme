import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMnemeEngine } from "./engine.js";
import { remember, recall } from "../surface/index.js";
import { _resetEmbeddingsForTest, initEmbeddings } from "../surface/embeddings.js";

// Prime the jaccard fallback singleton before any test triggers recall, so
// eng.initEmbeddings() (a bare call to the shared singleton) resolves instantly
// instead of attempting a real (slow) model load. See server.integration.test.ts.
beforeAll(async () => {
  _resetEmbeddingsForTest();
  await initEmbeddings(async () => { throw new Error("no model in CI"); });
});

describe("openMnemeEngine", () => {
  it("round-trips a claim (embeddings loaded lazily on recall)", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "mneme-engine-")), "store.db");
    const eng = openMnemeEngine({ dbPath, corpus: "test" });
    remember(eng.session, { subject: "project:mneme", key: "status", value: "green", corpus: "test" });
    const r = await recall(
      eng.session,
      { about: "mneme status", corpus: "test" },
      { embeddings: await eng.initEmbeddings(), keyCardinality: eng.keyCardinality },
    );
    expect(r.content).toContain("green");
  });

  it("returns dbPath and defaultCorpus reflecting the passed options", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "mneme-engine-")), "store.db");
    const eng = openMnemeEngine({ dbPath, corpus: "myco" });
    expect(eng.dbPath).toBe(dbPath);
    expect(eng.defaultCorpus).toBe("myco");
  });
});
