import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CorpusDef } from "../index.js";

const sidecarFor = (dbPath: string): string => `${dbPath}.corpora.json`;

/**
 * Ensure the parent directory for a db file exists. better-sqlite3 won't create
 * a missing parent directory, so a nested dbPath (e.g. "./.mneme/store.db")
 * would otherwise fail with SQLITE_CANTOPEN. No-op for the ":memory:" db.
 */
export function ensureDir(dbPath: string): void {
  if (dbPath === ":memory:") return;
  mkdirSync(dirname(dbPath), { recursive: true });
}

/** Load persisted corpus defs for a db; empty array if the sidecar is absent. */
export function loadCorpora(dbPath: string): CorpusDef[] {
  if (dbPath === ":memory:") return []; // ephemeral DB: nothing persisted
  const p = sidecarFor(dbPath);
  if (!existsSync(p)) return [];
  const raw = readFileSync(p, "utf8");
  try {
    return JSON.parse(raw) as CorpusDef[];
  } catch {
    throw new Error(
      `corpus sidecar at "${p}" is not valid JSON — delete it to reset`,
    );
  }
}

/** Persist the full set of corpus defs for a db atomically. */
export function saveCorpora(dbPath: string, defs: CorpusDef[]): void {
  if (dbPath === ":memory:") return; // ephemeral DB: do not write a sidecar
  const sidecar = sidecarFor(dbPath);
  const tmp = `${sidecar}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(defs, null, 2), "utf8");
    renameSync(tmp, sidecar);
  } catch (err) {
    if (existsSync(tmp)) {
      try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    }
    throw err;
  }
}
