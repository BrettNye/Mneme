import type { DreamReport } from "./processes/dreaming-types.js";
import type { CycleReport, EpisodeId } from "./types.js";

interface CycleDriver { runCycle(episode: EpisodeId): CycleReport; }
interface DreamDriver { dream(episode: EpisodeId, run: { modelVersion: string }): Promise<DreamReport>; }

export function createRunner(memory: CycleDriver & Partial<DreamDriver>, episode: EpisodeId) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let dreamTimer: ReturnType<typeof setInterval> | undefined;
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
      if (dreamTimer) {
        clearInterval(dreamTimer);
        dreamTimer = undefined;
      }
    },
    runNow(): CycleReport {
      return memory.runCycle(episode);
    },
    startDreaming(opts: { intervalMs?: number; episode: EpisodeId; modelVersion: string }) {
      if (dreamTimer) { clearInterval(dreamTimer); dreamTimer = undefined; }   // never leak a prior interval
      if (typeof memory.dream !== "function") return;                          // no dream capability → no-op
      if (opts.intervalMs && opts.intervalMs > 0) {
        dreamTimer = setInterval(
          () => { memory.dream!(opts.episode, { modelVersion: opts.modelVersion }).catch(() => {}); },
          opts.intervalMs,
        );
      }
    },
  };
}
