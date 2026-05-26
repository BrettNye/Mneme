import type { MnemeGateway } from "./gateway.js";
import type { SignalBuffer } from "./signals.js";
import { now } from "../core/time.js";
import type { CognitiveProcess, CycleReport, Episode } from "./types.js";

export function createCycle(gateway: MnemeGateway, processes: CognitiveProcess[]) {
  let running = false;
  let cycleN = 0;
  return {
    run(episode: Episode, buffer: SignalBuffer): CycleReport {
      if (running) {
        return {
          opsApplied: 0,
          claimsSuperseded: 0,
          errors: ["cycle already running (single-flight)"],
        };
      }
      running = true;
      const cid = ++cycleN;
      try {
        const ops = processes.flatMap((p) =>
          p.run({
            read: gateway.read,
            readByIds: gateway.readByIds,
            episode,
            signals: buffer,
            now: now(),
          })
        );
        const res = gateway.apply(ops, (op, i) => `${episode.id}:${cid}:${i}:${op.kind}`);
        buffer.flush(episode.id);
        return {
          opsApplied: res.applied,
          claimsSuperseded: ops.filter((o) => o.kind === "supersede").length,
          errors: [],
        };
      } catch (e) {
        // fail-safe: nothing applied, signals retained
        return { opsApplied: 0, claimsSuperseded: 0, errors: [String(e)] };
      } finally {
        running = false;
      }
    },
  };
}
