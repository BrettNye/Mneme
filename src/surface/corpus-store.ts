import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import type { CorpusDef } from "../index.js";

const sidecarFor = (dbPath: string): string => `${dbPath}.corpora.json`;

/** Load persisted corpus defs for a db; empty array if the sidecar is absent. */
export function loadCorpora(dbPath: string): CorpusDef[] {
  const p = sidecarFor(dbPath);
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, "utf8")) as CorpusDef[];
}

/** Persist the full set of corpus defs for a db atomically. */
export function saveCorpora(dbPath: string, defs: CorpusDef[]): void {
  const sidecar = sidecarFor(dbPath);
  const tmp = `${sidecar}.tmp`;
  writeFileSync(tmp, JSON.stringify(defs, null, 2), "utf8");
  renameSync(tmp, sidecar);
}
