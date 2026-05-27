import type { Claim, CandidateClaim } from "../../core/claim.js";
import type { ClaimId } from "../../core/ids.js";
import type { AppendOp, CognitiveProcess, ProcessInput } from "../types.js";
import type { BioPolicy } from "../policy.js";
import { DEFAULT_BIO_POLICY } from "../policy.js";

export function evidenceUpdate(evidence?: BioPolicy["evidence"]): CognitiveProcess {
  const usageWeight = evidence?.usageWeight ?? DEFAULT_BIO_POLICY.evidence.usageWeight;
  const outcomeWeight = evidence?.outcomeWeight ?? DEFAULT_BIO_POLICY.evidence.outcomeWeight;

  // Explicit bio-layer reinforcement evidence weight for promoting a scalar belief to Beta.
  // This is a documented wave-1 choice: total pseudocount = 2 produces a weak but mean-preserving
  // prior so that a scalar claim with p=0.9 promotes to Beta(1.8, 0.2), mean = 0.9 exactly.
  // NOT a silent default — see design doc docs/superpowers/specs/2026-05-26-bio-layer-design.md.
  const scalarPseudocount = evidence?.scalarPseudocount ?? DEFAULT_BIO_POLICY.evidence.scalarPseudocount;

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
        bump(String(id), usageWeight, 0);
      }

      // Outcome signals → credit only for surfaced claims (bounded credit assignment)
      const surfaced = new Set(signals.surfacedFor(episode.id).map(String));
      for (const o of signals.outcomesFor(episode.id)) {
        const w = (o.weight ?? 1) * outcomeWeight;
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
          with: reweighted(c, d, episode.id, input.now, scalarPseudocount),
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
  now: ProcessInput["now"],
  scalarPseudocount: number,
): CandidateClaim {
  // Promote scalar confidence to beta preserving its mean exactly.
  // For a scalar claim with mean p: alpha = p * scalarPseudocount, beta = (1-p) * scalarPseudocount
  // so that mean = alpha/(alpha+beta) = p. The scalar already represents a belief, not raw counts.
  const p =
    c.confidence.distribution === "beta"
      ? c.confidence.parameters
      : (() => {
          const scalarP = c.confidence.parameters.p;
          return {
            alpha: scalarP * scalarPseudocount,
            beta: (1 - scalarP) * scalarPseudocount,
          };
        })();

  const params = {
    alpha: p.alpha + d.dAlpha,
    beta: p.beta + d.dBeta,
  };

  // Strip fields that CandidateClaim omits
  const { id, recorded, recordedSeq, scopeHash, valueHash, status, ...rest } = c;
  // Use input.now for provenance timestamps so they reflect evaluation time, not claim-creation time
  const evalTime = now as unknown as number;

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
        corpusState: evalTime,
        inputClaims: [c.id],
        similarityVersions: {},
        embeddingModelVersions: {},
        evaluationClock: evalTime,
        combinationRule: `episode:${episodeId}`,
      },
    },
  };
}
