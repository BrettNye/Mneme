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

        // Atomic batch apply
        const res = gateway.apply(ops, (op, i) => `${episode.id}:consolidate:${i}`);

        return buildReport(ops, res);
      } catch (e) {
        return { ...empty, errors: [String(e)] };
      } finally {
        inflight.delete(episode.id);
      }
    },
  };
}

/**
 * Build a ConsolidationReport from the planned ops and the apply result.
 *
 * Counts are based on planned ops by kind (acceptable for this slice — noted in spec).
 * If `res.rejected` is populated, rejected items surface in `dropped`.
 * We do NOT double-count: we count all planned ops optimistically, which matches
 * the applied effect on the happy path; rejections are surfaced separately in `dropped`.
 */
function buildReport(ops: AppendOp[], res: AppendResult): ConsolidationReport {
  // Count by kind
  let folded = 0;
  let deprecated = 0;
  let promoted = 0;

  for (const op of ops) {
    if (op.kind === "derive") {
      folded++;
    } else if (op.kind === "promote") {
      if (op.to === "deprecated") {
        deprecated++;
      } else {
        promoted++;
      }
    }
  }

  // Surface any rejections into dropped
  const dropped: { key?: string; reason: string }[] = (res.rejected ?? []).map((r) => ({
    key: r.key,
    reason: r.status,
  }));

  return { promoted, folded, deprecated, dropped, errors: [] };
}
