import { createHash } from "node:crypto";

export interface Scope {
  [field: string]: string | undefined;
}

export function canonicalScope(scope: Scope): string {
  const entries = Object.entries(scope)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "";
  return JSON.stringify(Object.fromEntries(entries));
}

export function scopeHash(scope: Scope): string {
  const canon = canonicalScope(scope);
  if (canon === "") return "_";
  return createHash("sha256").update(canon).digest("hex").slice(0, 16);
}
