import type { StorageAdapter } from "../adapters/adapter.js";
import type { AsyncStorageAdapter } from "../adapters/async-adapter.js";

export const WINDOW_MS = 24 * 60 * 60 * 1000;

export const idempotencyScope = (corpus: string, writer: string, key: string): string =>
  JSON.stringify([corpus, writer, key]);

export function checkIdempotent(
  adapter: StorageAdapter,
  scope: string,
  idemKey: string,
  nowMs: number
): string | undefined {
  const rec = adapter.getIdempotencyRecord(scope, idemKey);
  return rec && nowMs - rec.createdAt < WINDOW_MS ? rec.result : undefined;
}

export function recordIdempotent(
  adapter: StorageAdapter,
  scope: string,
  idemKey: string,
  result: string,
  nowMs: number
): void {
  adapter.putIdempotencyRecord(scope, idemKey, { result, createdAt: nowMs });
}

export async function checkIdempotentAsync(
  adapter: AsyncStorageAdapter,
  scope: string,
  idemKey: string,
  nowMs: number
): Promise<string | undefined> {
  const rec = await adapter.getIdempotencyRecord(scope, idemKey);
  return rec && nowMs - rec.createdAt < WINDOW_MS ? rec.result : undefined;
}

export async function recordIdempotentAsync(
  adapter: AsyncStorageAdapter,
  scope: string,
  idemKey: string,
  result: string,
  nowMs: number
): Promise<void> {
  await adapter.putIdempotencyRecord(scope, idemKey, { result, createdAt: nowMs });
}
