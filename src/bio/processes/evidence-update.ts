import type { Claim, CandidateClaim } from "../../core/claim.js";
import type { ClaimId } from "../../core/ids.js";
import { DEFAULT_PRIOR } from "../../core/confidence.js";
import type { AppendOp, CognitiveProcess, ProcessInput } from "../types.js";

const USAGE_WEIGHT = 0.5;
const OUTCOME_WEIGHT = 2.0;

export function evidenceUpdate(): CognitiveProcess {
  return {
    name: "evidence-update",
    run(input: ProcessInput): AppendOp[] {
      const { episode, signals } = input;

      // Accumulate deltas keyed by claim id string
      const delta = new Map<string, { dAlpha: number; dBeta: number }>();
      const bump = (id: string, a: number, b: number): void => {
        const d = delta.get(id) ?? { dAlpha: 0, dBeta: 0 };
        delta.set(id, { dAlpha: d.dAlpha + a, dBeta: d.dBeta + b });
      };

      // Usage signals → weak positive (alpha only)
      for (const id of signals.usageFor(episode.id)) {
        bump(String(id), USAGE_WEIGHT, 0);
      }

      // Outcome signals → credit only for surfaced claims (bounded credit assignment)
      const surfaced = new Set(signals.surfacedFor(episode.id).map(String));
      for (const o of signals.outcomesFor(episode.id)) {
        const w = (o.weight ?? 1) * OUTCOME_WEIGHT;
        for (const id of surfaced) {
          if (o.result === "success") {
            bump(id, w, 0);
          } else {
            bump(id, 0, w);
          }
        }
      }

      // Resolve affected claim ids and fetch their current state
      const affectedIds = [...delta.keys()] as unknown as ClaimId[];
      const claims = input.readByIds(affectedIds);

      // Emit exactly one supersede per affected claim (batched)
      const ops: AppendOp[] = claims.map((c): AppendOp => {
        const d = delta.get(String(c.id))!;
        return {
          kind: "supersede",
          deprecate: c.id,
          with: reweighted(c, d, episode.id),
          reason: "evidence-update",
        };
      });

      return ops;
    },
  };
}

function reweighted(
  c: Claim,
  d: { dAlpha: number; dBeta: number },
  episodeId: string,
): CandidateClaim {
  // Promote scalar confidence to beta using DEFAULT_PRIOR if needed
  const p =
    c.confidence.distribution === "beta"
      ? c.confidence.parameters
      : { alpha: DEFAULT_PRIOR.W / 2, beta: DEFAULT_PRIOR.W / 2 };

  const params = {
    alpha: p.alpha + d.dAlpha,
    beta: p.beta + d.dBeta,
  };

  // Strip fields that CandidateClaim omits
  const { id, recorded, recordedSeq, scopeHash, valueHash, status, ...rest } = c;

  return {
    ...rest,
    confidence: {
      distribution: "beta",
      parameters: params,
      raw: params.alpha / (params.alpha + params.beta),
    },
    provenance: {
      ...c.provenance,
      derivedFrom: {
        queryExpression: "evidence-update",
        corpusState: recorded as unknown as number,
        inputClaims: [c.id],
        similarityVersions: {},
        embeddingModelVersions: {},
        evaluationClock: recorded as unknown as number,
        combinationRule: `episode:${episodeId}`,
      },
    },
  };
}
