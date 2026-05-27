import { createMnemeGateway } from "./gateway.js";
import { createEpisodeRegistry } from "./episode.js";
import { createSignalBuffer } from "./signals.js";
import { createCycle } from "./cycle.js";
import { evidenceUpdate } from "./processes/evidence-update.js";
import { compose } from "./policies/suppression.js";
import { createDreamPass } from "./processes/dreaming.js";
import type { DreamFn, DreamReport } from "./processes/dreaming-types.js";
import { createSummarizePass } from "./processes/summarize.js";
import type { SummarizeFn, SummarizeReport } from "./processes/summarize-types.js";
import type { BioQuery, CycleReport, EpisodeId, RetrievalContext, RetrievalPolicy } from "./types.js";
import type { ClaimId } from "../core/ids.js";
import type { Claim } from "../core/claim.js";
import type { Mneme } from "../mneme.js";
import type { BioPolicy } from "./policy.js";
import { resolvePolicy } from "./policy.js";
import { createConsolidatePass, type ConsolidationReport } from "./processes/consolidation.js";

const UNKNOWN_EPISODE_ERROR = "unknown episode";

export interface BioMemoryOpts {
  mneme: Mneme;
  corpusId: string;
  dreamFn?: DreamFn;
  summarizeFn?: SummarizeFn;
  policy?: BioPolicy;
}

export function createBioMemory(opts: BioMemoryOpts) {
  const pol = resolvePolicy(opts.policy);
  const gateway = createMnemeGateway(opts.mneme, opts.corpusId);
  const dreamFn = opts.dreamFn;

  const dreamPass = dreamFn
    ? createDreamPass(gateway, dreamFn, { ...pol.dreaming, corpusId: opts.corpusId })
    : undefined;

  const summarizePass = opts.summarizeFn
    ? createSummarizePass(gateway, opts.summarizeFn, { corpusId: opts.corpusId, summarize: pol.summarize })
    : undefined;

  const consolidatePass = createConsolidatePass(gateway, opts.policy, opts.corpusId);

  const episodes = createEpisodeRegistry();
  const buffer = createSignalBuffer();
  const cycle = createCycle(gateway, [evidenceUpdate(pol.evidence)]);
  return {
    openEpisode: episodes.openEpisode.bind(episodes),
    closeEpisode: episodes.closeEpisode.bind(episodes),
    recall(q: BioQuery, policies: RetrievalPolicy[], ctx: RetrievalContext, episode?: EpisodeId) {
      const claims = compose(policies).apply(gateway.read(q), ctx);
      if (episode) buffer.recordSurfaced(episode, claims.map((c) => c.id));
      return claims;
    },
    recordUsage(claimIds: ClaimId[], episode: EpisodeId) {
      buffer.record({ kind: "usage", claimIds, episode });
    },
    recordOutcome(episode: EpisodeId, result: "success" | "failure", weight?: number): CycleReport {
      const ep = episodes.get(episode);
      if (!ep) return { opsApplied: 0, claimsSuperseded: 0, errors: [UNKNOWN_EPISODE_ERROR] };
      buffer.record({ kind: "outcome", episode, result, weight });
      return cycle.run(ep, buffer);
    },
    runCycle(episode: EpisodeId): CycleReport {
      const ep = episodes.get(episode);
      return ep
        ? cycle.run(ep, buffer)
        : { opsApplied: 0, claimsSuperseded: 0, errors: [UNKNOWN_EPISODE_ERROR] };
    },
    async dream(
      episode: EpisodeId,
      run: { modelVersion: string; maxInsights?: number }
    ): Promise<DreamReport> {
      const ep = episodes.get(episode);
      if (!ep) return { proposed: 0, admitted: 0, dropped: [], errors: [UNKNOWN_EPISODE_ERROR] };
      if (!dreamPass) return { proposed: 0, admitted: 0, dropped: [], errors: ["no dreamFn configured"] };
      return dreamPass.dream(ep, run);
    },
    consolidate(
      episode: EpisodeId,
      opts2?: { consolidation?: BioPolicy["consolidation"] }
    ): ConsolidationReport {
      const ep = episodes.get(episode);
      if (!ep) {
        return { promoted: 0, folded: 0, deprecated: 0, dropped: [], errors: [UNKNOWN_EPISODE_ERROR] };
      }
      return consolidatePass.consolidate(ep, opts2);
    },
    async summarize(
      episode: EpisodeId,
      run: { modelVersion: string }
    ): Promise<SummarizeReport> {
      const ep = episodes.get(episode);
      if (!ep) return { proposed: 0, admitted: 0, dropped: [], errors: [UNKNOWN_EPISODE_ERROR] };
      if (!summarizePass) return { proposed: 0, admitted: 0, dropped: [], errors: ["no summarizeFn configured"] };
      return summarizePass.summarize(ep, run);
    },
    getDigest(episode: EpisodeId): Claim[] {
      const ep = episodes.get(episode);
      return ep && summarizePass ? summarizePass.getDigest(ep) : [];
    },
  };
}
