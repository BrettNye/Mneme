import { createHash } from "node:crypto";

export type Value = null | boolean | number | string | Value[] | { [k: string]: Value };

export function canonicalizeValue(v: Value): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalizeValue).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalizeValue(v[k])}`).join(",")}}`;
}

export const valueHash = (v: Value): string =>
  createHash("sha256").update(canonicalizeValue(v)).digest("hex").slice(0, 16);
