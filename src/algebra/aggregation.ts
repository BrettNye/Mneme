import type { Corpus } from "./types.js";
import { partitionBy } from "./types.js";
import type { Claim } from "../core/claim.js";
import { DEFAULT_PRIOR } from "../core/confidence.js";
import { getPath } from "./value-predicate.js";
import { matches, type Predicate } from "./predicate.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GroupKey =
  | { kind: "scalar"; value: unknown }
  | { kind: "tuple"; values: unknown[] }
  | { kind: "none" };

export type AggValue =
  | { kind: "count"; n: number }
  | { kind: "sum"; value: number }
  | { kind: "avg"; value: number }
  | { kind: "min"; value: unknown }
  | { kind: "max"; value: unknown }
  | { kind: "rate"; beta: { alpha: number; beta: number } };

export interface AggregateResult {
  groups: Map<string, { key: GroupKey; value: AggValue }>;
}

// ---------------------------------------------------------------------------
// claimPath resolver
// scope.<f>  → claim.scope[f]
// "value"    → claim.value
// value.<...>→ getPath(claim.value, rest)
// bare       → top-level claim field
// ---------------------------------------------------------------------------

export function claimPath(claim: Claim, path: string): unknown {
  if (path.startsWith("scope.")) return claim.scope[path.slice(6)];
  if (path === "value") return claim.value;
  if (path.startsWith("value.")) return getPath(claim.value, path.slice(6));
  return (claim as unknown as Record<string, unknown>)[path];
}

// ---------------------------------------------------------------------------
// Core aggregators: (Claim[]) => AggValue
// ---------------------------------------------------------------------------

export const countCore = (claims: Claim[]): AggValue => ({
  kind: "count",
  n: claims.length,
});

export const sumCore =
  (valuePath: string) =>
  (claims: Claim[]): AggValue => {
    let acc = 0;
    for (const c of claims) {
      const n = Number(claimPath(c, valuePath));
      if (Number.isFinite(n)) acc += n;
    }
    return { kind: "sum", value: acc };
  };

export const avgCore =
  (valuePath: string) =>
  (claims: Claim[]): AggValue => {
    if (claims.length === 0) return { kind: "avg", value: 0 };
    let acc = 0;
    let count = 0;
    for (const c of claims) {
      const n = Number(claimPath(c, valuePath));
      if (Number.isFinite(n)) { acc += n; count++; }
    }
    return { kind: "avg", value: count === 0 ? 0 : acc / count };
  };

export const minCore =
  (valuePath: string) =>
  (claims: Claim[]): AggValue => {
    const values = claims.map((c) => claimPath(c, valuePath));
    const min = values.reduce(
      (m, v) => (m === undefined || (v !== undefined && (v as number) < (m as number)) ? v : m),
      undefined as unknown
    );
    return { kind: "min", value: min };
  };

export const maxCore =
  (valuePath: string) =>
  (claims: Claim[]): AggValue => {
    const values = claims.map((c) => claimPath(c, valuePath));
    const max = values.reduce(
      (m, v) => (m === undefined || (v !== undefined && (v as number) > (m as number)) ? v : m),
      undefined as unknown
    );
    return { kind: "max", value: max };
  };

// rateCore: num matches numP; denom matches denomP but NOT numP
// Uses DEFAULT_PRIOR (W=2, a=0.5); §0.3: α = r + a·W, β = s + (1−a)·W
export const rateCore =
  (numP: Predicate, denomP: Predicate) =>
  (claims: Claim[]): AggValue => {
    const { W, a } = DEFAULT_PRIOR;
    const r = claims.filter((c) => matches(c, numP)).length;
    const s = claims.filter((c) => matches(c, denomP) && !matches(c, numP)).length;
    return { kind: "rate", beta: { alpha: r + a * W, beta: s + (1 - a) * W } };
  };

// binaryRateCore: num = value at valuePath === true; denom = true OR false (null/undefined excluded)
// Implemented with local predicate functions since the Predicate union has no value-path-equals op.
export const binaryRateCore =
  (valuePath: string) =>
  (claims: Claim[]): AggValue => {
    const { W, a } = DEFAULT_PRIOR;
    const isTrue = (c: Claim): boolean => claimPath(c, valuePath) === true;
    const isFalse = (c: Claim): boolean => claimPath(c, valuePath) === false;
    const r = claims.filter(isTrue).length;
    const s = claims.filter(isFalse).length;
    return { kind: "rate", beta: { alpha: r + a * W, beta: s + (1 - a) * W } };
  };

// ---------------------------------------------------------------------------
// Wrap a single AggValue in an AggregateResult with GroupKey.none
// ---------------------------------------------------------------------------

const wrapNone = (v: AggValue): AggregateResult => ({
  groups: new Map([["__none__", { key: { kind: "none" } as GroupKey, value: v }]]),
});

// ---------------------------------------------------------------------------
// α operators — top-level corpus → AggregateResult
// ---------------------------------------------------------------------------

export const alphaCount = (c: Corpus): AggregateResult =>
  wrapNone(countCore([...c.claims]));

export const alphaCountWhere =
  (p: Predicate) =>
  (c: Corpus): AggregateResult =>
    wrapNone(countCore(c.claims.filter((cl) => matches(cl, p))));

export const alphaSum =
  (path: string) =>
  (c: Corpus): AggregateResult =>
    wrapNone(sumCore(path)([...c.claims]));

export const alphaAvg =
  (path: string) =>
  (c: Corpus): AggregateResult =>
    wrapNone(avgCore(path)([...c.claims]));

export const alphaMin =
  (path: string) =>
  (c: Corpus): AggregateResult =>
    wrapNone(minCore(path)([...c.claims]));

export const alphaMax =
  (path: string) =>
  (c: Corpus): AggregateResult =>
    wrapNone(maxCore(path)([...c.claims]));

export const alphaRate =
  (numP: Predicate, denomP: Predicate) =>
  (c: Corpus): AggregateResult =>
    wrapNone(rateCore(numP, denomP)([...c.claims]));

export const alphaBinaryRate =
  (valuePath: string) =>
  (c: Corpus): AggregateResult =>
    wrapNone(binaryRateCore(valuePath)([...c.claims]));

// ---------------------------------------------------------------------------
// alphaGroupBy<group-field, core>
// ---------------------------------------------------------------------------

export const alphaGroupBy =
  (groupField: string, core: (claims: Claim[]) => AggValue) =>
  (c: Corpus): AggregateResult => {
    const keyed = c.claims.filter((cl) => {
      const raw = claimPath(cl, groupField);
      return raw !== undefined && raw !== null;
    }) as Claim[];
    const buckets = partitionBy(keyed, (cl) => String(claimPath(cl, groupField)));
    const groups = new Map<string, { key: GroupKey; value: AggValue }>();
    for (const [k, claims] of buckets) {
      groups.set(k, { key: { kind: "scalar", value: k }, value: core(claims) });
    }
    return { groups };
  };
