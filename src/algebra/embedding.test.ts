import {
  EmbeddingAdapter,
  EmbeddingCache,
  warmEmbeddings,
  cosineOver,
  registerEmbeddingAdapter,
  embeddingAdapter,
} from "./embedding.js";

// ── FakeEmbeddingAdapter — zero network ─────────────────────────────────────

const fake: EmbeddingAdapter = {
  id: "fake-model",
  version: "v1",
  dim: 2,
  embed: async (texts) =>
    texts.map((t) => (t.includes("york") || t === "nyc" ? [1, 0] : [0, 1])),
};

// ── EmbeddingCache ───────────────────────────────────────────────────────────

it("EmbeddingCache: hit returns the stored vector", () => {
  const cache = new EmbeddingCache();
  const vec = new Float32Array([0.5, 0.5]);
  cache.set(fake, "hello", vec);
  expect(cache.get(fake, "hello")).toBe(vec);
});

it("EmbeddingCache: miss returns undefined", () => {
  const cache = new EmbeddingCache();
  expect(cache.get(fake, "not-there")).toBeUndefined();
});

it("EmbeddingCache: different adapter version is a distinct key", () => {
  const cache = new EmbeddingCache();
  const adapterV1 = { id: "m", version: "v1" };
  const adapterV2 = { id: "m", version: "v2" };
  const vec1 = new Float32Array([1, 0]);
  const vec2 = new Float32Array([0, 1]);
  cache.set(adapterV1, "text", vec1);
  cache.set(adapterV2, "text", vec2);
  expect(cache.get(adapterV1, "text")).toBe(vec1);
  expect(cache.get(adapterV2, "text")).toBe(vec2);
});

// ── warmEmbeddings ───────────────────────────────────────────────────────────

it("warmEmbeddings: embeds only cache misses (call-count assertion)", async () => {
  const cache = new EmbeddingCache();
  let callCount = 0;
  const countingAdapter: EmbeddingAdapter = {
    id: "counting-model",
    version: "v1",
    dim: 2,
    embed: async (texts) => {
      callCount += texts.length;
      return texts.map(() => [0.5, 0.5]);
    },
  };

  // First warm — all 3 texts are misses
  await warmEmbeddings(countingAdapter, cache, ["a", "b", "c"]);
  expect(callCount).toBe(3);

  // Second warm — "a" and "b" are now cached, only "d" is a miss
  await warmEmbeddings(countingAdapter, cache, ["a", "b", "d"]);
  expect(callCount).toBe(4); // only "d" was embedded
});

it("warmEmbeddings: idempotent on re-run (no re-embedding)", async () => {
  const cache = new EmbeddingCache();
  let embedCallCount = 0;
  const adapter: EmbeddingAdapter = {
    id: "idem-model",
    version: "v1",
    dim: 2,
    embed: async (texts) => {
      embedCallCount++;
      return texts.map(() => [1, 0]);
    },
  };

  await warmEmbeddings(adapter, cache, ["x", "y"]);
  const callsAfterFirst = embedCallCount;
  await warmEmbeddings(adapter, cache, ["x", "y"]);
  expect(embedCallCount).toBe(callsAfterFirst); // no additional calls
});

it("warmEmbeddings: throws on wrong-length vector (dim mismatch)", async () => {
  const cache = new EmbeddingCache();
  const wrongDimAdapter: EmbeddingAdapter = {
    id: "bad-dim-model",
    version: "v1",
    dim: 3,
    embed: async (texts) => texts.map(() => [1, 0]), // returns dim=2 but adapter.dim=3
  };

  await expect(warmEmbeddings(wrongDimAdapter, cache, ["test"])).rejects.toThrow(/dim/);
});

it("warmEmbeddings: throws on non-finite values in vectors", async () => {
  const cache = new EmbeddingCache();
  const nanAdapter: EmbeddingAdapter = {
    id: "nan-model",
    version: "v1",
    dim: 2,
    embed: async (texts) => texts.map(() => [NaN, 0]),
  };

  await expect(warmEmbeddings(nanAdapter, cache, ["test"])).rejects.toThrow(/finite/i);
});

it("warmEmbeddings: throws on Infinity in vectors", async () => {
  const cache = new EmbeddingCache();
  const infAdapter: EmbeddingAdapter = {
    id: "inf-model",
    version: "v1",
    dim: 2,
    embed: async (texts) => texts.map(() => [Infinity, 0]),
  };

  await expect(warmEmbeddings(infAdapter, cache, ["test"])).rejects.toThrow(/finite/i);
});

// ── cosineOver ───────────────────────────────────────────────────────────────

it("cosineOver scores cached texts and throws on a miss", async () => {
  const cache = new EmbeddingCache();
  await warmEmbeddings(fake, cache, ["nyc", "new york city"]);
  const sim = cosineOver(fake, cache);
  expect(sim.scoreOne("nyc", "new york city")).toBeCloseTo(1); // same direction → cos 1 → 1.0
  expect(() => sim.scoreOne("unwarmed", "nyc")).toThrow(/warmEmbeddings/);
});

it("cosineOver: version === 'cosine@1'", () => {
  const sim = cosineOver(fake, new EmbeddingCache());
  expect(sim.version).toBe("cosine@1");
});

it("cosineOver: embeddingVersions equals { [adapter.id]: adapter.version }", () => {
  const sim = cosineOver(fake, new EmbeddingCache());
  expect(sim.embeddingVersions).toEqual({ "fake-model": "v1" });
});

it("cosineOver: isPure === true", () => {
  const sim = cosineOver(fake, new EmbeddingCache());
  expect(sim.isPure).toBe(true);
});

it("cosineOver: identical-direction vectors score 1", async () => {
  const cache = new EmbeddingCache();
  await warmEmbeddings(fake, cache, ["nyc", "new york city"]);
  const sim = cosineOver(fake, cache);
  // both map to [1, 0] — identical direction → (1+1)/2 = 1.0
  expect(sim.scoreOne("nyc", "new york city")).toBeCloseTo(1);
});

it("cosineOver: opposite vectors score 0", async () => {
  const oppositeAdapter: EmbeddingAdapter = {
    id: "opposite-model",
    version: "v1",
    dim: 2,
    embed: async (texts) =>
      texts.map((t) => (t === "a" ? [1, 0] : [-1, 0])),
  };
  const cache = new EmbeddingCache();
  await warmEmbeddings(oppositeAdapter, cache, ["a", "b"]);
  const sim = cosineOver(oppositeAdapter, cache);
  // cos = -1 → (1 + (-1))/2 = 0
  expect(sim.scoreOne("a", "b")).toBeCloseTo(0);
});

it("cosineOver: non-string values canonicalized via canonicalizeValue before lookup", async () => {
  const objectAdapter: EmbeddingAdapter = {
    id: "obj-model",
    version: "v1",
    dim: 2,
    embed: async (texts) => texts.map(() => [1, 0]),
  };
  const cache = new EmbeddingCache();
  // Warm with canonicalized form of the object
  const objValue = { city: "nyc" };
  await warmEmbeddings(objectAdapter, cache, [JSON.stringify({ city: "nyc" })]);
  // Wait — canonicalizeValue({ city: "nyc" }) = '{"city":"nyc"}' — but we need to warm with the same key
  // Reset and warm with the canonical string directly
  const { canonicalizeValue } = await import("../core/value.js");
  const canonical = canonicalizeValue(objValue);
  const cache2 = new EmbeddingCache();
  await warmEmbeddings(objectAdapter, cache2, [canonical, canonical]);
  const sim = cosineOver(objectAdapter, cache2);
  // Both values are the same object — should score 1
  expect(sim.scoreOne(objValue, objValue)).toBeCloseTo(1);
});

it("cosineOver: cache miss throws matching /warmEmbeddings/", async () => {
  const cache = new EmbeddingCache();
  const sim = cosineOver(fake, cache);
  expect(() => sim.scoreOne("missing", "nyc")).toThrow(/warmEmbeddings/);
});

// ── Registry ─────────────────────────────────────────────────────────────────

it("registerEmbeddingAdapter + embeddingAdapter round-trip", () => {
  const adapter: EmbeddingAdapter = {
    id: "registry-test-model",
    version: "v1",
    dim: 384,
    embed: async () => [],
  };
  registerEmbeddingAdapter(adapter);
  expect(embeddingAdapter("registry-test-model")).toBe(adapter);
});

it("embeddingAdapter throws /no embedding adapter/ for unknown id", () => {
  expect(() => embeddingAdapter("nonexistent-model-xyz")).toThrow(
    /no embedding adapter "nonexistent-model-xyz"/
  );
});

it("registerEmbeddingAdapter: re-registering the same object is a no-op", () => {
  const adapter: EmbeddingAdapter = {
    id: "noop-adapter-test",
    version: "v1",
    dim: 128,
    embed: async () => [],
  };
  registerEmbeddingAdapter(adapter);
  expect(() => registerEmbeddingAdapter(adapter)).not.toThrow();
  expect(embeddingAdapter("noop-adapter-test")).toBe(adapter);
});

it("registerEmbeddingAdapter: collision with different object throws", () => {
  const adapter1: EmbeddingAdapter = {
    id: "collision-adapter-test",
    version: "v1",
    dim: 128,
    embed: async () => [],
  };
  const adapter2: EmbeddingAdapter = {
    id: "collision-adapter-test",
    version: "v2",
    dim: 128,
    embed: async () => [],
  };
  registerEmbeddingAdapter(adapter1);
  expect(() => registerEmbeddingAdapter(adapter2)).toThrow();
});
