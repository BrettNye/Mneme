import type { Claim, CandidateClaim } from "../../core/claim.js";
import type { Instant } from "../../core/time.js";
import type { Episode, AppendOp } from "../types.js";
import { SUMMARY_WORKFLOW, type ProposedSummary } from "./summarize-types.js";
import { DEFAULT_BIO_POLICY } from "../policy.js";

export interface AdmitOpts {
  prior?: { alpha: number; beta: number };
  modelVersion?: string;
}

export function admitSummaries(
  proposals: ProposedSummary[],
  selected: Claim[],
  episode: Episode,
  now: Instant,
  opts: AdmitOpts = {}
): { ops: AppendOp[]; dropped: { key?: string; reason: string }[] } {
  const selectedIds = new Set(selected.map((c) => String(c.id)));
  const prior = opts.prior ?? DEFAULT_BIO_POLICY.summarize.prior;
  const runId = episode.runIds[0];
  const modelVersion = opts.modelVersion ?? "unknown";
  const ops: AppendOp[] = [];
  const dropped: { key?: string; reason: string }[] = [];

  for (const p of proposals) {
    if (!p.cites?.length || !p.cites.every((id) => selectedIds.has(String(id)))) {
      dropped.push({ key: String(p.key), reason: "cites not in selected set" });
      continue;
    }

    ops.push({ kind: "derive", claim: buildDigest(p, runId, prior, now, modelVersion, selected) });
  }

  return { ops, dropped };
}

function buildDigest(
  p: ProposedSummary,
  runId: string,
  prior: { alpha: number; beta: number },
  now: Instant,
  modelVersion: string,
  selected: Claim[]
): CandidateClaim {
  // Use the first cited claim as the representative for profile/workspace/valid/schema
  const byId = new Map(selected.map((c) => [String(c.id), c]));
  const rep = byId.get(String(p.cites[0]));

  return {
    profile: rep?.profile ?? ("" as any),
    workspace: rep?.workspace ?? ("" as any),
    subject: p.key as any,
    key: p.key,
    scope: p.scope ?? {},
    value: p.value,
    confidence: {
      distribution: "beta",
      parameters: { alpha: prior.alpha, beta: prior.beta },
      raw: prior.alpha / (prior.alpha + prior.beta),
    },
    valid: rep?.valid ?? ({ from: now } as any),
    status: "candidate",
    source: "llm",
    provenance: {
      workflow: SUMMARY_WORKFLOW,
      runId,
      derivedFrom: {
        queryExpression: "summary",
        corpusState: Number(now),
        combinationRule: `summary@${modelVersion}`,
        inputClaims: p.cites,
        similarityVersions: {},
        embeddingModelVersions: {},
        evaluationClock: Number(now),
      },
    },
    evidence: p.cites.map((claimId) => ({ kind: "claim" as const, claimId })),
    tags: [],
    schema: rep?.schema ?? "",
  };
}
