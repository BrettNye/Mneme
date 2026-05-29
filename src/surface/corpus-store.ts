import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import type { CorpusDef } from "../index.js";

const sidecarFor = (dbPath: string): string => `${dbPath}.corpora.json`;

/** Load persisted corpus defs for a db; empty array if the sidecar is absent. */
export function loadCorpora(dbPath: string): CorpusDef[] {
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
