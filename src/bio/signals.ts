import type { ClaimId } from "../core/ids.js";
import type { EpisodeId, Signal, SignalView } from "./types.js";

export interface SignalBuffer extends SignalView {
  record(sig: Signal): void;
  recordSurfaced(episode: EpisodeId, claimIds: ClaimId[]): void;
  flush(episode: EpisodeId): void;
}

export function createSignalBuffer(cap = 10_000): SignalBuffer {
  const usage = new Map<EpisodeId, ClaimId[]>();
  const outcomes = new Map<EpisodeId, { result: "success" | "failure"; weight?: number }[]>();
  const surfaced = new Map<EpisodeId, ClaimId[]>();
  let count = 0;
  const perEpisode = new Map<EpisodeId, number>();

  const guard = () => {
    if (count >= cap) throw new Error(`SignalBuffer cap ${cap} exceeded — run a cycle to drain`);
  };

  return {
    record(sig) {
      guard();
      count++;
      perEpisode.set(sig.episode, (perEpisode.get(sig.episode) ?? 0) + 1);
      if (sig.kind === "usage") {
        usage.set(sig.episode, [...(usage.get(sig.episode) ?? []), ...sig.claimIds]);
      } else {
        outcomes.set(sig.episode, [
          ...(outcomes.get(sig.episode) ?? []),
          { result: sig.result, weight: sig.weight },
        ]);
      }
    },
    recordSurfaced(e, ids) {
      surfaced.set(e, [...(surfaced.get(e) ?? []), ...ids]);
    },
    usageFor: (e) => [...(usage.get(e) ?? [])],
    outcomesFor: (e) => [...(outcomes.get(e) ?? [])],
    surfacedFor: (e) => [...(surfaced.get(e) ?? [])],
    flush(e) {
      count -= perEpisode.get(e) ?? 0;
      perEpisode.delete(e);
      usage.delete(e);
      outcomes.delete(e);
      surfaced.delete(e);
    },
  };
}
