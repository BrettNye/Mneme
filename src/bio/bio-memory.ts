import { createMnemeGateway, type MnemeGateway } from "./gateway.js";
import { createEpisodeRegistry } from "./episode.js";
import { createSignalBuffer } from "./signals.js";
import { createCycle } from "./cycle.js";
import { evidenceUpdate } from "./processes/evidence-update.js";
import { compose } from "./policies/suppression.js";
import { createDreamPass, type DreamPassOpts } from "./processes/dreaming.js";
import type { DreamFn, DreamReport } from "./processes/dreaming-types.js";
import type { BioQuery, CycleReport, EpisodeId, RetrievalContext, RetrievalPolicy } from "./types.js";
import type { ClaimId } from "../core/ids.js";

const UNKNOWN_EPISODE_ERROR = "unknown episode";

export interface BioMemoryOpts {
  gateway?: MnemeGateway;
  dreamFn?: DreamFn;
  dream?: DreamPassOpts;
}

function isGateway(arg: MnemeGateway | BioMemoryOpts): arg is MnemeGateway {
  return typeof (arg as MnemeGateway).read === "function";
}

export function createBioMemory(
  gatewayOrOpts?: MnemeGateway | BioMemoryOpts
) {
  let gateway: MnemeGateway;
  let dreamFn: DreamFn | undefined;
  let dreamOpts: DreamPassOpts | undefined;

  if (!gatewayOrOpts) {
    gateway = createMnemeGateway();
  } else if (isGateway(gatewayOrOpts)) {
    // Existing callers: createBioMemory(gateway)
    gateway = gatewayOrOpts;
  } else {
    // New callers: createBioMemory({ dreamFn, gateway?, dream? })
    gateway = gatewayOrOpts.gateway ?? createMnemeGateway();
    dreamFn = gatewayOrOpts.dreamFn;
    dreamOpts = gatewayOrOpts.dream;
  }

  const dreamPass = dreamFn ? createDreamPass(gateway, dreamFn, dreamOpts) : undefined;

  const episodes = createEpisodeRegistry();
  const buffer = createSignalBuffer();
  const cycle = createCycle(gateway, [evidenceUpdate()]);
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
  };
}
