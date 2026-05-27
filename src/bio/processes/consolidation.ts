import type { MnemeGateway } from "../gateway.js";
import type { Episode, AppendOp, AppendResult } from "../types.js";
import type { BioPolicy } from "../policy.js";
import { resolvePolicy } from "../policy.js";
import { planConsolidation } from "./consolidation-plan.js";
import { now } from "../../core/time.js";

export interface ConsolidationReport {
  promoted: number;
  folded: number;
  deprecated: number;
  dropped: { key?: string; reason: string }[];
  errors: string[];
}

/** Default corpus to read episode claims from when the caller does not specify one. */
export const DEFAULT_CORPUS_ID = "bio";

/**
 * Creates a consolidation pass orchestrator.
 *
 * @param gateway - The MnemeGateway to read from and apply ops to.
 * @param policy  - Optional BioPolicy; defaults are used for any omitted fields.
 * @param corpusId - The corpus to query when reading episode claims. Defaults to "bio".
 */
export function createConsolidatePass(
  gateway: MnemeGateway,
  policy?: BioPolicy,
  corpusId = DEFAULT_CORPUS_ID
) {
  const inflight = new Set<string>();
  const pol = resolvePolicy(policy).consolidation;

  return {
    consolidate(
      episode: Episode,
      opts?: { consolidation?: BioPolicy["consolidation"] }
    ): ConsolidationReport {
      const empty: ConsolidationReport = {
        promoted: 0,
        folded: 0,
        deprecated: 0,
        dropped: [],
        errors: [],
      };

      if (inflight.has(episode.id)) {
        return { ...empty, errors: ["consolidate already in flight for episode"] };
      }
      // No runIds → the episode produced no claims. Guard BEFORE reading: a read with
      // an empty runIds array is unfiltered and would return the ENTIRE corpus, causing
      // a corpus-wide fold/promote. Mirror Dreaming's selectDreamInput empty-runIds guard.
      if (episode.runIds.length === 0) return empty;
      inflight.add(episode.id);

      try {
        // Merge construction-time policy with per-call override
        const effective = {
          ...pol,
          ...opts?.consolidation,
          promoteThresholds: {
            ...pol.promoteThresholds,
            ...opts?.consolidation?.promoteThresholds,
          },
        };

        // Read fresh, post-reinforcement claims for this episode's runIds
        const claims = gateway.read({ corpusId, runIds: episode.runIds });

        // Pure planning: compute ops
        const ops = planConsolidation(claims, effective, now());

        if (ops.length === 0) return empty;

        // Apply ops. NOTE: gateway.apply is per-op atomic, NOT one batch transaction —
        // a mid-batch failure can leave earlier ops applied. Recovery is by idempotent
        // retry (identity-based opKeys below) + soft-deprecate (nothing is ever lost).
        // True batch atomicity is tracked as a follow-up (design §8 deferred).
        // opKeys encode op IDENTITY (input set for a fold, target+status for a promote),
        // NOT a positional index, so a later pass over a CHANGED claim set applies its
        // genuinely-new ops instead of colliding with a prior pass's index-keyed records.
        const res = gateway.apply(ops, (op) => opKeyFor(episode.id, op));

        return buildReport(ops, res);
      } catch (e) {
        return { ...empty, errors: [String(e)] };
      } finally {
        inflight.delete(episode.id);
      }
    },
  };
}

const APPLIED = new Set(["committed", "superseded", "promoted"]);

/**
 * Idempotency key encoding op IDENTITY, not a positional index.
 * - derive  → the sorted input-claim set (a re-fold over different inputs gets a new key)
 * - promote → target id + destination status (distinguishes targets and tiers)
 * Identical re-runs produce identical keys (correctly deduped); genuinely different
 * ops in a later pass get new keys and apply.
 */
function opKeyFor(episodeId: string, op: AppendOp): string {
  if (op.kind === "derive") {
    const inputs = [...(op.claim.provenance?.derivedFrom?.inputClaims ?? [])]
      .map(String)
      .sort()
      .join(",");
    return `${episodeId}:consolidate:derive:${inputs}`;
  }
  if (op.kind === "promote") {
    return `${episodeId}:consolidate:promote:${op.target}:${op.to}`;
  }
  return `${episodeId}:consolidate:supersede:${op.deprecate}`;
}

/**
 * Build a ConsolidationReport from the planned ops and the apply result.
 *
 * Counts reflect what ACTUALLY persisted: when the gateway returns per-op `results`,
 * an op is tallied by kind only if its status is applied (committed/superseded/promoted).
 * Rejected ops are surfaced in `dropped` and never counted as a success. (When `results`
 * is absent — e.g. a minimal mock — fall back to counting planned ops.)
 */
function buildReport(ops: AppendOp[], res: AppendResult): ConsolidationReport {
  let folded = 0;
  let deprecated = 0;
  let promoted = 0;

  for (let i = 0; i < ops.length; i++) {
    const applied = res.results ? APPLIED.has(res.results[i]?.status ?? "") : true;
    if (!applied) continue;
    const op = ops[i];
    if (op.kind === "derive") {
      folded++;
    } else if (op.kind === "promote") {
      if (op.to === "deprecated") deprecated++;
      else promoted++;
    }
  }

  const dropped: { key?: string; reason: string }[] = (res.rejected ?? []).map((r) => ({
    key: r.key,
    reason: r.status,
  }));

  return { promoted, folded, deprecated, dropped, errors: [] };
}
