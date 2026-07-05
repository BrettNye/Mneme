import {
  checkIdempotent,
  recordIdempotent,
  idempotencyScope,
  WINDOW_MS,
  checkIdempotentAsync,
  recordIdempotentAsync,
} from "./idempotency.js";
import type { AsyncStorageAdapter } from "../adapters/async-adapter.js";

it("returns the original result within the window, not after", () => {
  const store = new Map<string, any>();
  const adapter = {
    getIdempotencyRecord: (s: string, k: string) => store.get(`${s}|${k}`),
    putIdempotencyRecord: (s: string, k: string, r: any) => store.set(`${s}|${k}`, r),
  } as any;

  recordIdempotent(adapter, "scopeA", "k1", "claim-1", 0);
  expect(checkIdempotent(adapter, "scopeA", "k1", 1000)).toBe("claim-1");
  expect(checkIdempotent(adapter, "scopeA", "k1", WINDOW_MS + 1)).toBeUndefined();
});

it("returns undefined if no record exists", () => {
  const store = new Map<string, any>();
  const adapter = {
    getIdempotencyRecord: (s: string, k: string) => store.get(`${s}|${k}`),
    putIdempotencyRecord: (s: string, k: string, r: any) => store.set(`${s}|${k}`, r),
  } as any;

  expect(checkIdempotent(adapter, "scopeA", "k1", 1000)).toBeUndefined();
});

it("returns undefined exactly at window boundary (>= WINDOW_MS excluded)", () => {
  const store = new Map<string, any>();
  const adapter = {
    getIdempotencyRecord: (s: string, k: string) => store.get(`${s}|${k}`),
    putIdempotencyRecord: (s: string, k: string, r: any) => store.set(`${s}|${k}`, r),
  } as any;

  recordIdempotent(adapter, "scopeA", "k2", "claim-2", 0);
  // Exactly at WINDOW_MS: nowMs - createdAt === WINDOW_MS, which is NOT < WINDOW_MS
  expect(checkIdempotent(adapter, "scopeA", "k2", WINDOW_MS)).toBeUndefined();
});

it("idempotencyScope separates different corpus/writer/key tuples (no collision)", () => {
  const scope1 = idempotencyScope("corpusA", "writerX", "key1");
  const scope2 = idempotencyScope("corpusB", "writerX", "key1");
  const scope3 = idempotencyScope("corpusA", "writerY", "key1");
  const scope4 = idempotencyScope("corpusA", "writerX", "key2");

  // All scopes must be distinct
  const scopes = [scope1, scope2, scope3, scope4];
  const unique = new Set(scopes);
  expect(unique.size).toBe(4);
});

it("idempotencyScope is unambiguous when components contain spaces (no collision on space-boundary)", () => {
  // ("a b", "c", "d") vs ("a", "b c", "d") — plain-space join would make both "a b c d"
  expect(idempotencyScope("a b", "c", "d")).not.toBe(idempotencyScope("a", "b c", "d"));
});

it("does not collide across different scopes in the store", () => {
  const store = new Map<string, any>();
  const adapter = {
    getIdempotencyRecord: (s: string, k: string) => store.get(`${s}|${k}`),
    putIdempotencyRecord: (s: string, k: string, r: any) => store.set(`${s}|${k}`, r),
  } as any;

  const scopeA = idempotencyScope("corpusA", "writerX", "key1");
  const scopeB = idempotencyScope("corpusB", "writerX", "key1");

  recordIdempotent(adapter, scopeA, "k1", "result-A", 0);
  recordIdempotent(adapter, scopeB, "k1", "result-B", 0);

  expect(checkIdempotent(adapter, scopeA, "k1", 1000)).toBe("result-A");
  expect(checkIdempotent(adapter, scopeB, "k1", 1000)).toBe("result-B");
});

it("checkIdempotentAsync returns the prior result inside the window and undefined after it", async () => {
  const rec = { result: "id-1", createdAt: 1000 };
  const a = { getIdempotencyRecord: async () => rec } as unknown as AsyncStorageAdapter;
  expect(await checkIdempotentAsync(a, "s", "k", 1000 + WINDOW_MS - 1)).toBe("id-1");
  expect(await checkIdempotentAsync(a, "s", "k", 1000 + WINDOW_MS + 1)).toBeUndefined();
});

it("checkIdempotentAsync returns undefined when no async record exists", async () => {
  const a = { getIdempotencyRecord: async () => undefined } as unknown as AsyncStorageAdapter;
  expect(await checkIdempotentAsync(a, "s", "k", 1000)).toBeUndefined();
});

it("recordIdempotentAsync stores a record that checkIdempotentAsync can retrieve via a real async adapter", async () => {
  const store = new Map<string, any>();
  const a = {
    getIdempotencyRecord: async (s: string, k: string) => store.get(`${s}|${k}`),
    putIdempotencyRecord: async (s: string, k: string, r: any) => {
      store.set(`${s}|${k}`, r);
    },
  } as unknown as AsyncStorageAdapter;

  await recordIdempotentAsync(a, "scopeA", "k1", "claim-async-1", 0);
  expect(await checkIdempotentAsync(a, "scopeA", "k1", 1000)).toBe("claim-async-1");
  expect(await checkIdempotentAsync(a, "scopeA", "k1", WINDOW_MS + 1)).toBeUndefined();
});
