import { now } from "../core/time.js";
import type { Episode, EpisodeId } from "./types.js";

export function createEpisodeRegistry() {
  const open = new Map<EpisodeId, Episode>();
  let n = 0;
  return {
    openEpisode(runId?: string): Episode {
      const ep: Episode = { id: `ep-${++n}`, runIds: runId ? [runId] : [], startedAt: now() };
      open.set(ep.id, ep);
      return ep;
    },
    attachRun(id: EpisodeId, runId: string): boolean {
      const ep = open.get(id);
      if (!ep) return false;
      ep.runIds.push(runId);
      return true;
    },
    closeEpisode(id: EpisodeId): Episode | undefined {
      const ep = open.get(id);
      if (!ep) return undefined;
      ep.endedAt = now();
      open.delete(id);
      return ep;
    },
    get(id: EpisodeId) { return open.get(id); },
  };
}
