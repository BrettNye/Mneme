import { createMnemeGateway, type MnemeGateway } from "./gateway.js";
import { createEpisodeRegistry } from "./episode.js";
import { createSignalBuffer } from "./signals.js";
import { createCycle } from "./cycle.js";
import { evidenceUpdate } from "./processes/evidence-update.js";
import { compose } from "./policies/suppression.js";
import type { BioQuery, CycleReport, EpisodeId, RetrievalContext, RetrievalPolicy } from "./types.js";
import type { ClaimId } from "../core/ids.js";

export function createBioMemory(gateway: MnemeGateway = createMnemeGateway()) {
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
      buffer.record({ kind: "outcome", episode, result, weight });
      const ep = episodes.get(episode);
      return ep
        ? cycle.run(ep, buffer)
        : { opsApplied: 0, claimsSuperseded: 0, errors: ["unknown episode"] };
    },
    runCycle(episode: EpisodeId): CycleReport {
      const ep = episodes.get(episode);
      return ep
        ? cycle.run(ep, buffer)
        : { opsApplied: 0, claimsSuperseded: 0, errors: ["unknown episode"] };
    },
  };
}
