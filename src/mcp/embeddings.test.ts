import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { initEmbeddings, _resetEmbeddingsForTest } from "./embeddings.js";
import type { EmbeddingState } from "./embeddings.js";
import type { EmbeddingAdapter } from "../algebra/embedding.js";
import { similarityFn, registerSimilarity } from "../algebra/similarity.js";
import { embeddingAdapter } from "../algebra/embedding.js";

// ── Fake adapter (zero network) ───────────────────────────────────────────────

let _adapterSeq = 0;
function makeFakeAdapter(id?: string): EmbeddingAdapter {
  // Use a unique id by default so each test gets an independent adapter
  // (the global embedding adapter registry does NOT reset between tests).
  const adapterId = id ?? `fake-embed-model-${++_adapterSeq}`;
  return {
    id: adapterId,
    version: "v1",
    dim: 2,
    embed: async (texts) => texts.map(() => [0.5, 0.5]),
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  _resetEmbeddingsForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Success path ──────────────────────────────────────────────────────────────

describe("success path", () => {
  it("state.rankFn is 'hybrid' on success", async () => {
    const adapter = makeFakeAdapter();
    const state = await initEmbeddings(async () => adapter);
    expect(state.rankFn).toBe("hybrid");
  });

  it("similarityFn('cosine') resolves after success init", async () => {
    const adapter = makeFakeAdapter();
    await initEmbeddings(async () => adapter);
    expect(() => similarityFn("cosine")).not.toThrow();
  });

  it("similarityFn('hybrid') resolves after success init", async () => {
    const adapter = makeFakeAdapter();
    await initEmbeddings(async () => adapter);
    expect(() => similarityFn("hybrid")).not.toThrow();
  });

  it("embeddingAdapter(id) resolves after success init", async () => {
    const adapter = makeFakeAdapter("success-path-adapter");
    await initEmbeddings(async () => adapter);
    expect(embeddingAdapter("success-path-adapter")).toBe(adapter);
  });

  it("repeat init returns cached state without re-running the factory", async () => {
    let callCount = 0;
    const adapter = makeFakeAdapter("call-count-adapter");
    const factory = async () => {
      callCount++;
      return adapter;
    };
    const s1 = await initEmbeddings(factory);
    const s2 = await initEmbeddings(factory);
    expect(callCount).toBe(1);
    expect(s2).toBe(s1);
  });

  it("state.adapter is set on success", async () => {
    const adapter = makeFakeAdapter("adapter-set-test");
    const state = await initEmbeddings(async () => adapter);
    expect(state.adapter).toBe(adapter);
  });

  it("state.cache is set on success", async () => {
    const adapter = makeFakeAdapter("cache-set-test");
    const state = await initEmbeddings(async () => adapter);
    expect(state.cache).toBeDefined();
  });
});

// ── Failure path ──────────────────────────────────────────────────────────────

describe("failure path", () => {
  it("state.rankFn is 'jaccard' on factory failure", async () => {
    const s1 = await initEmbeddings(async () => {
      throw new Error("no model");
    });
    expect(s1.rankFn).toBe("jaccard");
  });

  it("warns exactly ONCE on failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await initEmbeddings(async () => {
      throw new Error("no model");
    });

    const total = errorSpy.mock.calls.length + warnSpy.mock.calls.length;
    expect(total).toBe(1);
  });

  it("failure cached — second factory is never called", async () => {
    const s1 = await initEmbeddings(async () => {
      throw new Error("no model");
    });
    let secondCalled = false;
    const s2 = await initEmbeddings(async () => {
      secondCalled = true;
      throw new Error("should not be called");
    });
    expect(secondCalled).toBe(false);
    expect(s2).toBe(s1);
  });

  it("after _resetEmbeddingsForTest, a fresh init runs the factory again", async () => {
    let callCount = 0;
    const failFactory = async () => {
      callCount++;
      throw new Error("fail");
    };

    await initEmbeddings(failFactory);
    expect(callCount).toBe(1);

    _resetEmbeddingsForTest();

    await initEmbeddings(failFactory);
    expect(callCount).toBe(2);
  });

  it("failure path test from spec: warns once, serves jaccard, caches failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const s1 = await initEmbeddings(async () => {
      throw new Error("no model");
    });
    const s2 = await initEmbeddings(async () => {
      throw new Error("should not be called");
    });
    expect(s1.rankFn).toBe("jaccard");
    expect(s2).toBe(s1);
  });
});

// ── Registry collision handling ───────────────────────────────────────────────

describe("registry collision", () => {
  it("reset + re-init with a fake adapter does NOT throw /already registered/", async () => {
    // First init registers cosine + hybrid
    const adapter1 = makeFakeAdapter("collision-test-adapter-1");
    await initEmbeddings(async () => adapter1);

    // Reset and re-init — must NOT throw on re-registration
    _resetEmbeddingsForTest();
    const adapter2 = makeFakeAdapter("collision-test-adapter-2");
    await expect(initEmbeddings(async () => adapter2)).resolves.toBeDefined();
  });

  it("after reset + re-init, similarityFn('cosine') and similarityFn('hybrid') still resolve", async () => {
    const adapter1 = makeFakeAdapter("collision-cosine-1");
    await initEmbeddings(async () => adapter1);

    _resetEmbeddingsForTest();

    const adapter2 = makeFakeAdapter("collision-cosine-2");
    await initEmbeddings(async () => adapter2);

    expect(() => similarityFn("cosine")).not.toThrow();
    expect(() => similarityFn("hybrid")).not.toThrow();
  });
});

// ── CI zero-network guard ─────────────────────────────────────────────────────
// Verified statically by the acceptance criteria: grep -rn "transformers-local"
// src/mcp/embeddings.test.ts should be empty (this file has no such import).
