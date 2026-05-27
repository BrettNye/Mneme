import type { DreamReport } from "./processes/dreaming-types.js";
import type { CycleReport, EpisodeId } from "./types.js";

interface CycleDriver { runCycle(episode: EpisodeId): CycleReport; }
interface DreamDriver { dream(episode: EpisodeId, run: { modelVersion: string }): Promise<DreamReport>; }
interface ConsolidateDriver { consolidate(episode: EpisodeId): unknown; }
interface SummarizeDriver { summarize(episode: EpisodeId, run: { modelVersion: string }): Promise<unknown>; }

export function createRunner(memory: CycleDriver & Partial<DreamDriver> & Partial<ConsolidateDriver> & Partial<SummarizeDriver>, episode: EpisodeId) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let dreamTimer: ReturnType<typeof setInterval> | undefined;
  let consolidateTimer: ReturnType<typeof setInterval> | undefined;
  let summarizeTimer: ReturnType<typeof setInterval> | undefined;
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
      if (consolidateTimer) {
        clearInterval(consolidateTimer);
        consolidateTimer = undefined;
      }
      if (summarizeTimer) {
        clearInterval(summarizeTimer);
        summarizeTimer = undefined;
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
    // Consolidation is registered like dreaming (so stop() halts it and a re-call
    // never leaks the prior interval) AND returns a caller-owned stop fn per spec.
    startConsolidating(opts: { intervalMs: number }, consolidateEpisode: EpisodeId): () => void {
      if (consolidateTimer) { clearInterval(consolidateTimer); consolidateTimer = undefined; } // never leak a prior interval
      if (typeof memory.consolidate !== "function") return () => {};           // no consolidate capability → no-op
      if (!(opts.intervalMs > 0)) return () => {};                             // non-positive interval → no-op (mirror start/startDreaming)
      const h = setInterval(
        () => { try { memory.consolidate!(consolidateEpisode); } catch { /* fail-safe: swallow throws so interval survives */ } },
        opts.intervalMs,
      );
      consolidateTimer = h;
      return () => { clearInterval(h); if (consolidateTimer === h) consolidateTimer = undefined; };
    },
    startSummarizing(opts: { intervalMs: number; episode: EpisodeId; modelVersion: string }): void {
      if (summarizeTimer) { clearInterval(summarizeTimer); summarizeTimer = undefined; } // never leak a prior interval
      if (typeof memory.summarize !== "function") return;                               // no summarize capability → no-op
      if (!(opts.intervalMs > 0)) return;                                               // non-positive interval → no-op
      summarizeTimer = setInterval(
        () => { memory.summarize!(opts.episode, { modelVersion: opts.modelVersion }).catch(() => {}); }, // fail-safe
        opts.intervalMs,
      );
    },
  };
}
