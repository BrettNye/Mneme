import type { MnemeGateway } from "../gateway.js";
import type { Episode } from "../types.js";
import type { ClaimSchema } from "../../catalog/schema.js";
import { now } from "../../core/time.js";
import { selectDreamInput } from "./dreaming-select.js";
import { admitInsights } from "./dreaming-admit.js";
import type { DreamFn, DreamReport } from "./dreaming-types.js";

export interface DreamPassOpts {
  schema?: ClaimSchema;
  corpusId?: string;
  maxInputClaims?: number;
}

export function createDreamPass(
  gateway: MnemeGateway,
  dreamFn: DreamFn,
  opts: DreamPassOpts = {}
) {
  const running = new Set<string>();
  return {
    async dream(
      episode: Episode,
      run: { modelVersion: string; maxInsights?: number }
    ): Promise<DreamReport> {
      if (running.has(episode.id)) {
        return {
          proposed: 0,
          admitted: 0,
          dropped: [],
          errors: ["dream already running for episode (single-flight)"],
        };
      }
      running.add(episode.id);
      try {
        const selected = selectDreamInput(gateway.read, episode, opts);
        if (selected.length === 0) {
          return { proposed: 0, admitted: 0, dropped: [], errors: [] };
        }
        let insights;
        try {
          insights = await dreamFn({
            episode,
            claims: selected,
            maxInsights: run.maxInsights,
          });
        } catch (e) {
          return { proposed: 0, admitted: 0, dropped: [], errors: [String(e)] };
        }
        try {
          const { ops, dropped } = admitInsights(
            insights,
            selected,
            now(),
            run.modelVersion,
            opts.schema
          );
          const res = gateway.apply(
            ops,
            (_op, i) => `dream:${episode.id}:${i}`
          );
          return {
            proposed: insights.length,
            admitted: res.applied,
            dropped,
            errors: [],
          };
        } catch (e) {
          return { proposed: insights.length, admitted: 0, dropped: [], errors: [String(e)] };
        }
      } finally {
        running.delete(episode.id);
      }
    },
  };
}
