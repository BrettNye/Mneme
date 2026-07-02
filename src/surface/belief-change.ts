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
import { pairsOf } from "../algebra/contradiction.js";
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

/** What did the just-written claim `claimId` do to its (subject,key) group? Embeddings-free:
 *  reads the group, applies τ_valid + ⊕_dedupe + ⊥(effective cardinality) and attributes the
 *  new claim. Reuses dedupeGroups (merge map) + pairsOf (deprecations). */
export function supersessionOutcome(session: Session, corpus: string, claimId: string): SupersessionOutcome {
  const now = Date.now();
  const keyCardinality = resolveKeyCardinality(session, corpus, undefined);
  const { aliasMap } = loadAliasContext(session, corpus, now, keyCardinality);
  const written = session.mneme.read(corpus, { corpusId: corpus }).find((c) => c.id === claimId);
  if (!written) return { action: "committed", deprecatedIds: [] };
  const group = tauValid(now)(
    corpusOf(
      session.mneme.read(corpus, { corpusId: corpus, subject: written.subject, key: written.key }) as Claim[],
    ),
  );
  const { mergedInto } = dedupeGroups(DEDUPE_DEFAULTS.rule, undefined, {
    similarity: { fn: DEDUPE_DEFAULTS.fn, cutoff: DEDUPE_DEFAULTS.cutoff },
  })(group);
  if (mergedInto.has(claimId)) {
    const target = mergedInto.get(claimId)!;
    const targetClaim = group.claims.find((c) => c.id === target);
    const action = targetClaim && targetClaim.valueHash === written.valueHash ? "duplicate" : "merged";
    return { action, deprecatedIds: [], mergedInto: target, reason: { kind: "merged-into", targetId: target } };
  }
  const pairs = pairsOf(group, 0, {
    keyCardinality,
    keyAliases: aliasMap,
    evidencePoolingRule: MCP_EVIDENCE_POOLING_RULE,
  });
  const deprecatedIds: string[] = [];
  for (const p of pairs) {
    if (p.left.valid.from === p.right.valid.from) continue;
    const [older, newer] = p.left.valid.from < p.right.valid.from ? [p.left, p.right] : [p.right, p.left];
    if (newer.id === claimId) deprecatedIds.push(older.id);
  }
  if (deprecatedIds.length)
    return {
      action: "superseded",
      deprecatedIds,
      reason: { kind: "deprecated-by", byId: claimId, via: "single-cardinality" },
    };
  return { action: "committed", deprecatedIds: [] };
}
