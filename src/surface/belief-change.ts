/**
 * belief-change — shared vocabulary + attribution for what a write did to belief state.
 *
 * `DispositionReason` lives here (charter vocabulary home); explain.ts re-exports it for
 * back-compat. `supersessionOutcome` is a focused, embeddings-free attribution of what a
 * just-written claim did to its (subject,key) group — reuses dedupeGroups (⊕_dedupe) and
 * pairsOf/resolveDeprecateOlder (⊥) exactly as recall/explain do, so its verdict is always
 * consistent with what recall would serve.
 */
import type { Session } from "./types.js";
import type { Claim } from "../core/claim.js";
import { corpusOf } from "../algebra/types.js";
import { tauValid } from "../algebra/temporal.js";
import { dedupeGroups } from "../algebra/combination.js";
import { pairsOf, type KeyAliasMap } from "../algebra/contradiction.js";
import { resolveKeyCardinality } from "./cardinality.js";
import { loadAliasContext, MCP_EVIDENCE_POOLING_RULE } from "./recall.js";
import { DEDUPE_DEFAULTS } from "../retrieval/read-pipeline.js";

// MOVED from explain.ts (charter vocabulary home). explain.ts now re-exports this.
export type DispositionReason =
  | { kind: "served" }
  | { kind: "merged-into"; targetId: string }
  | { kind: "deprecated-by"; byId: string; via: "single-cardinality" }
  | { kind: "tau-invalid" }
  | { kind: "below-floor"; score: number; floor: number }
  | { kind: "abstained"; topScore: number; threshold: number }
  | { kind: "over-limit"; rank: number; limit: number }
  | { kind: "alias-or-flag" };

export interface SupersessionOutcome {
  action: "committed" | "superseded" | "merged" | "duplicate";
  deprecatedIds: string[]; // live claims this write deprecated (action="superseded")
  mergedInto?: string; // action="merged"/"duplicate": the surviving claim it was absorbed into
  reason?: DispositionReason; // vocabulary-aligned (deprecated-by / merged-into)
}

export type GroupDisposition = "served" | "deprecated" | "merged" | "tau-invalid";

/** Disposition of EVERY claim in a (subject,key) group at `now`, via the read pipeline's
 *  precedence τ_valid → ⊕_dedupe → ⊥. `claims` are RAW group claims (pre-τ). */
export function groupDispositions(
  claims: Claim[],
  keyCardinality: Record<string, "single" | "multi"> | undefined,
  aliasMap: KeyAliasMap,
  now: number,
): Map<string, { disposition: GroupDisposition; reason: DispositionReason }> {
  const out = new Map<string, { disposition: GroupDisposition; reason: DispositionReason }>();
  const tau = tauValid(now)(corpusOf(claims));
  const tauIds = new Set(tau.claims.map((c) => c.id));
  for (const c of claims)
    if (!tauIds.has(c.id)) out.set(c.id, { disposition: "tau-invalid", reason: { kind: "tau-invalid" } });
  const { survivors, mergedInto } = dedupeGroups(DEDUPE_DEFAULTS.rule, undefined, {
    similarity: { fn: DEDUPE_DEFAULTS.fn, cutoff: DEDUPE_DEFAULTS.cutoff },
  })(tau);
  for (const [lost, target] of mergedInto)
    out.set(lost, { disposition: "merged", reason: { kind: "merged-into", targetId: target } });
  const pairs = pairsOf(survivors, 0, {
    keyCardinality,
    keyAliases: aliasMap,
    evidencePoolingRule: MCP_EVIDENCE_POOLING_RULE,
  });
  // deprecated-by.byId reports the NEWEST deprecator (the ultimate survivor), not the first pair
  // seen — meaningful for lineage and required so a full deprecatedIds chain can be recovered by
  // scanning for the survivor's id (see supersessionOutcome).
  const byId = new Map<string, Claim>();
  for (const c of survivors.claims) byId.set(c.id, c);
  const deprecatedBy = new Map<string, string>();
  for (const p of pairs) {
    if (p.left.valid.from === p.right.valid.from) continue;
    const [older, newer] = p.left.valid.from < p.right.valid.from ? [p.left, p.right] : [p.right, p.left];
    const cur = deprecatedBy.get(older.id);
    if (cur === undefined) {
      deprecatedBy.set(older.id, newer.id);
      continue;
    }
    const curClaim = byId.get(cur);
    const curFrom = curClaim ? curClaim.valid.from : -Infinity;
    if (newer.valid.from > curFrom || (newer.valid.from === curFrom && newer.id < cur)) deprecatedBy.set(older.id, newer.id);
  }
  for (const [id, byId] of deprecatedBy)
    out.set(id, { disposition: "deprecated", reason: { kind: "deprecated-by", byId, via: "single-cardinality" } });
  for (const c of survivors.claims) if (!out.has(c.id)) out.set(c.id, { disposition: "served", reason: { kind: "served" } });
  return out;
}

/** What did the just-written claim `claimId` do to its (subject,key) group? Embeddings-free:
 *  reads the group, applies τ_valid + ⊕_dedupe + ⊥(effective cardinality) and attributes the
 *  new claim. Reuses dedupeGroups (merge map) + pairsOf (deprecations). */
export function supersessionOutcome(session: Session, corpus: string, claimId: string): SupersessionOutcome {
  const now = Date.now();
  const keyCardinality = resolveKeyCardinality(session, corpus, undefined);
  const { aliasMap } = loadAliasContext(session, corpus, now, keyCardinality);
  const written = session.mneme.read(corpus, { corpusId: corpus }).find((c) => c.id === claimId);
  // written-not-found: e.g. a stale/foreign id. No group to attribute against — "committed" by
  // design (this also covers the OLDER member of a ⊥ pair, which is dead-on-arrival and never
  // itself the "newer" side below, so it naturally falls through to "committed" too).
  if (!written) return { action: "committed", deprecatedIds: [] };
  // Scoped to the exact (subject, key) of `written`; alias-family expansion across related keys
  // is a documented v1 limitation (not handled here).
  const group = session.mneme.read(corpus, {
    corpusId: corpus,
    subject: written.subject,
    key: written.key,
  }) as Claim[];
  const dispositions = groupDispositions(group, keyCardinality, aliasMap, now);
  const own = dispositions.get(claimId);
  if (own?.disposition === "merged") {
    const reason = own.reason as Extract<DispositionReason, { kind: "merged-into" }>;
    const target = reason.targetId;
    const targetClaim = group.find((c) => c.id === target);
    const action = targetClaim && targetClaim.valueHash === written.valueHash ? "duplicate" : "merged";
    return { action, deprecatedIds: [], mergedInto: target, reason };
  }
  if (own?.disposition === "served") {
    // Within written's (subject,key,scopeHash) single-cardinality cluster, a "served" claim is
    // the sole newest survivor — so it deprecated every OTHER "deprecated" claim sharing its
    // scopeHash, regardless of which one directly attributed deprecated-by.byId to it (the
    // deprecatedBy map only records the ultimate-survivor edge per older claim, not a full chain).
    const groupById = new Map<string, Claim>();
    for (const c of group) groupById.set(c.id, c);
    const deprecatedIds = [...dispositions.entries()]
      .filter(([id, d]) => d.disposition === "deprecated" && groupById.get(id)?.scopeHash === written.scopeHash)
      .map(([id]) => id);
    if (deprecatedIds.length)
      return {
        action: "superseded",
        deprecatedIds,
        reason: { kind: "deprecated-by", byId: claimId, via: "single-cardinality" },
      };
  }
  return { action: "committed", deprecatedIds: [] };
}
