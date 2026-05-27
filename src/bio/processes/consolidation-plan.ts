import type { Claim, CandidateClaim } from "../../core/claim.js";
import type { Instant } from "../../core/time.js";
import type { AppendOp } from "../types.js";
import type { resolvePolicy } from "../policy.js";
import { lowerBound, tierFor, rankOf, type PromoteTier } from "./consolidation-confidence.js";
import { oplusSynthesizeAs } from "../../algebra/combination.js";
import { corpusOf } from "../../algebra/types.js";

export const CONSOLIDATE_WORKFLOW = "consolidate";

/**
 * A fully-resolved consolidation policy (all fields present, no optionals).
 * Callers obtain this via resolvePolicy(p).consolidation.
 */
type ConsPolicy = ReturnType<typeof resolvePolicy>["consolidation"];

/**
 * Pure planning core: given active claims and a fully-resolved consolidation policy,
 * emit AppendOp[] representing folds and individual promotions.
 *
 * Groups claims by (subject, key, scopeHash, valueHash). Groups of size >= max(2, foldThreshold)
 * are folded: one `derive` of the ⊕-combined claim at its earned tier + one `promote(→deprecated)`
 * per input. Every other active claim is evaluated individually for a forward tier promotion.
 * Fold xor promote — a claim is never both.
 */
export function planConsolidation(
  claims: Claim[],
  pol: ConsPolicy,
  now: Instant
): AppendOp[] {
  const active = claims.filter((c) => c.status !== "deprecated");
  const K = Math.max(2, pol.foldThreshold);

  // Group active claims by (subject, key, scopeHash, valueHash)
  const groups = new Map<string, Claim[]>();
  for (const c of active) {
    const key = `${c.subject}\x00${c.key}\x00${c.scopeHash}\x00${c.valueHash}`;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(c);
    } else {
      groups.set(key, [c]);
    }
  }

  const ops: AppendOp[] = [];
  const folded = new Set<string>();

  // First pass: fold eligible groups
  for (const group of groups.values()) {
    if (group.length < K) continue;

    const synth = oplusSynthesizeAs(group[0].subject, group[0].key, pol.foldRule)(corpusOf(group));
    const lb = lowerBound(synth.confidence, pol.lowerBoundK);
    const tier = tierFor(lb, pol.promoteThresholds);

    const consolidated = buildConsolidated(synth, group, tier, pol.foldRule, now);
    ops.push({ kind: "derive", claim: consolidated });

    for (const c of group) {
      ops.push({
        kind: "promote",
        target: c.id,
        to: "deprecated",
        reason: `folded into ${group[0].key}`,
      });
      folded.add(String(c.id));
    }
  }

  // Second pass: individual promotion for non-folded claims
  for (const c of active) {
    if (folded.has(String(c.id))) continue;

    const lb = lowerBound(c.confidence, pol.lowerBoundK);
    const tier = tierFor(lb, pol.promoteThresholds);

    // Active claims are non-deprecated, so their status is in PromoteTier
    const currentTier = c.status as PromoteTier;
    if (rankOf(tier) > rankOf(currentTier)) {
      ops.push({
        kind: "promote",
        target: c.id,
        to: tier,
        reason: `consolidation: lowerBound>=${tier}`,
      });
    }
  }

  return ops;
}

/**
 * Build a CandidateClaim for the consolidated (folded) result.
 * Carries value/scope/evidence from the synthesized claim, sets source="workflow",
 * provenance.workflow=CONSOLIDATE_WORKFLOW, and full derivedFrom provenance.
 */
function buildConsolidated(
  synth: Claim,
  group: Claim[],
  tier: PromoteTier,
  foldRule: string,
  now: Instant
): CandidateClaim {
  const rep = group[0];
  return {
    profile: rep.profile,
    workspace: rep.workspace,
    subject: synth.subject,
    key: synth.key,
    scope: synth.scope,
    value: synth.value,
    confidence: synth.confidence,
    valid: rep.valid,
    status: tier,
    source: "workflow",
    provenance: {
      workflow: CONSOLIDATE_WORKFLOW,
      derivedFrom: {
        queryExpression: "consolidate",
        corpusState: Number(now),
        combinationRule: foldRule,
        inputClaims: group.map((c) => c.id),
        similarityVersions: {},
        embeddingModelVersions: {},
        evaluationClock: Number(now),
      },
    },
    evidence: synth.evidence,
    tags: [],
    schema: rep.schema,
  };
}
