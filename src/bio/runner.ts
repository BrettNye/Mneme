import type { CycleReport, EpisodeId } from "./types.js";

interface CycleDriver { runCycle(episode: EpisodeId): CycleReport; }

export function createRunner(memory: CycleDriver, episode: EpisodeId) {
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    start(opts: { intervalMs?: number } = {}) {
      if (timer) { clearInterval(timer); timer = undefined; }   // never leak a prior interval
      if (opts.intervalMs && opts.intervalMs > 0) {
        timer = setInterval(() => memory.runCycle(episode), opts.intervalMs);
      }
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    runNow(): CycleReport {
      return memory.runCycle(episode);
    },
  };
}
