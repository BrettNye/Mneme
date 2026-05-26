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
            // Bound arrow functions guard against `this`-context loss if gateway
            // is later refactored to a class instance.
            read: (q) => gateway.read(q),
            readByIds: (ids) => gateway.readByIds(ids),
            episode,
            signals: buffer,
            now: now(),
          })
        );
        const res = gateway.apply(ops, (op, i) => `${episode.id}:${cid}:${i}:${op.kind}`);
        buffer.flush(episode.id);
        return {
          opsApplied: res.applied,
          // NOTE: claimsSuperseded counts supersede ops *emitted* this cycle
          // (attempted, pre-idempotency), whereas opsApplied is the gateway's
          // *committed* count (post-idempotency dedup via res.applied). On a
          // retry of the same episode these two values intentionally diverge —
          // claimsSuperseded overcounts relative to what the gateway actually
          // wrote. Exact committed-per-kind counts await an AppendResult
          // enhancement (deferred).
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
