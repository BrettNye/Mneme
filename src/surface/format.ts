import type { QueryResult } from "./types.js";
import type { Claim } from "../core/claim.js";
import type { AggValue } from "../algebra/aggregation.js";
import { pointEstimate } from "../core/confidence.js";

/** Render any QueryResult arm to a human-readable string. */
export function formatQueryResult(r: QueryResult): string {
  if ("content" in r) return r.content;                                                       // ComposedContext
  if ("groups" in r) return formatAggregate(r as { groups: Map<string, { key: unknown; value: AggValue }> }); // AggregateResult
  if ("scored" in r) return r.scored.map((s) => formatClaim(s.claim)).join("\n");             // RankedCorpus
  if ("claims" in r) return r.claims.map(formatClaim).join("\n");                             // Corpus
  return JSON.stringify(r, null, 2);
}

export function formatClaim(c: Claim): string {
  const conf = pointEstimate(c.confidence).toFixed(3);
  return `${c.subject} ${c.key} = ${JSON.stringify(c.value)}  [${c.status} p=${conf}]`;
}

function formatAggValue(v: AggValue): string {
  switch (v.kind) {
    case "count": return String(v.n);
    case "sum":   return String(v.value);
    case "avg":   return String(v.value);
    case "min":   return JSON.stringify(v.value);
    case "max":   return JSON.stringify(v.value);
    case "rate":  return `alpha=${v.beta.alpha} beta=${v.beta.beta}`;
  }
}

function formatAggregate(r: { groups: Map<string, { key: unknown; value: AggValue }> }): string {
  return [...r.groups.entries()]
    .map(([k, g]) => `${k}: ${formatAggValue(g.value)}`)
    .join("\n");
}
