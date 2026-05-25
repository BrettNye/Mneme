import { checkIdempotent, recordIdempotent, idempotencyScope, WINDOW_MS } from "./idempotency.js";

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
