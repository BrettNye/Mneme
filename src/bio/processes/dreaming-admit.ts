import type { Claim, CandidateClaim } from "../../core/claim.js";
import { subjectOf } from "../../core/key.js";
import { validateScope, type ClaimSchema } from "../../catalog/schema.js";
import type { AppendOp } from "../types.js";
import { DREAM_WORKFLOW, DREAM_PRIOR, depthOf, depthTag, type ProposedInsight } from "./dreaming-types.js";

export interface AdmitResult {
  ops: AppendOp[];
  dropped: { key?: string; reason: string }[];
}

export function admitInsights(
  insights: ProposedInsight[],
  selected: Claim[],
  nowMs: number,
  modelVersion: string,
  schema?: ClaimSchema,
  prior: { alpha: number; beta: number } = DREAM_PRIOR
): AdmitResult {
  const byId = new Map(selected.map((c) => [String(c.id), c]));
  const ops: AppendOp[] = [];
  const dropped: AdmitResult["dropped"] = [];

  for (const ins of insights) {
    // Validate: cites must be non-empty and all IDs must exist in selected
    if (ins.cites.length === 0 || !ins.cites.every((id) => byId.has(String(id)))) {
      dropped.push({ key: ins.key, reason: "cites not in selected set" });
      continue;
    }

    // Validate: key must be parseable by subjectOf
    let subject: string;
    try {
      subject = subjectOf(ins.key);
    } catch {
      dropped.push({ key: ins.key, reason: "invalid key" });
      continue;
    }

    // Carry profile/workspace/valid/schema from the first cited claim
    const rep = byId.get(String(ins.cites[0]))!;

    // Compute depth: max depth of cited claims + 1
    const depth = Math.max(...ins.cites.map((id) => depthOf(byId.get(String(id))!))) + 1;

    const claim: CandidateClaim = {
      profile: rep.profile,
      workspace: rep.workspace,
      subject,
      key: ins.key,
      scope: ins.scope ?? {},
      value: ins.value,
      confidence: {
        distribution: "beta",
        parameters: { alpha: prior.alpha, beta: prior.beta },
        raw: prior.alpha / (prior.alpha + prior.beta),
      },
      valid: rep.valid,
      status: "candidate",
      source: "llm",
      provenance: {
        workflow: DREAM_WORKFLOW,
        derivedFrom: {
          queryExpression: "dream",
          corpusState: nowMs,
          combinationRule: `dream@${modelVersion}`,
          inputClaims: ins.cites,
          similarityVersions: {},
          embeddingModelVersions: {},
          evaluationClock: nowMs,
        },
      },
      evidence: ins.cites.map((claimId) => ({ kind: "claim" as const, claimId })),
      tags: [depthTag(depth)],
      schema: rep.schema,
    };

    // Validate scope against schema if provided
    if (schema) {
      try {
        validateScope(claim.scope, schema);
      } catch (e) {
        dropped.push({ key: ins.key, reason: `scope: ${e}` });
        continue;
      }
    }

    ops.push({ kind: "derive", claim });
  }

  return { ops, dropped };
}
