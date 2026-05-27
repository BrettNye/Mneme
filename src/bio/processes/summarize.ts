import type { MnemeGateway } from "../gateway.js";
import type { Claim } from "../../core/claim.js";
import type { Episode, AppendOp, BioQuery } from "../types.js";
import type { BioPolicy } from "../policy.js";
import { resolvePolicy } from "../policy.js";
import { now } from "../../core/time.js";
import { isSummary, type SummarizeFn, type SummarizeReport } from "./summarize-types.js";
import { selectSummarizeInput } from "./summarize-select.js";
import { admitSummaries } from "./summarize-admit.js";

export function createSummarizePass(
  gateway: MnemeGateway,
  summarizeFn: SummarizeFn,
  opts: { corpusId?: string; summarize?: BioPolicy["summarize"] } = {}
) {
  const inflight = new Set<string>();
  const corpusId = opts.corpusId ?? "bio";
  const pol = resolvePolicy({ summarize: opts.summarize }).summarize;

  return {
    async summarize(episode: Episode, run: { modelVersion: string }): Promise<SummarizeReport> {
      const empty: SummarizeReport = { proposed: 0, admitted: 0, dropped: [], errors: [] };
      if (inflight.has(episode.id)) {
        return { ...empty, errors: ["summarize already in flight for episode"] };
      }
      if (episode.runIds.length === 0) return empty;
      inflight.add(episode.id);
      try {
        const selected = selectSummarizeInput(gateway.read, episode, {
          corpusId,
          maxInputClaims: pol.maxInputClaims,
        });
        if (selected.length === 0) return empty;
        const proposals = await summarizeFn({ episode, claims: selected });
        const { ops, dropped } = admitSummaries(proposals, selected, episode, now(), {
          prior: pol.prior,
          modelVersion: run.modelVersion,
        });
        if (ops.length === 0) return { ...empty, proposed: proposals.length, dropped };
        const res = gateway.apply(ops, (op, i) => opKeyFor(episode.id, op, i));
        // summarize emits only `derive` ops, so res.applied is exactly the count of
        // digests that actually persisted (rejected/duplicate ops are not counted).
        return { proposed: proposals.length, admitted: res.applied, dropped, errors: [] };
      } catch (e) {
        return { ...empty, errors: [String(e)] };
      } finally {
        inflight.delete(episode.id);
      }
    },

    getDigest(episode: Episode): Claim[] {
      if (episode.runIds.length === 0) return [];
      return gateway.read({ corpusId, runIds: episode.runIds } as BioQuery).filter(isSummary);
    },
  };
}

function opKeyFor(episodeId: string, op: AppendOp, i: number): string {
  if (op.kind === "derive") {
    const cites = [...(op.claim.provenance?.derivedFrom?.inputClaims ?? [])].map(String).sort().join(",");
    if (cites) {
      return `${episodeId}:summarize:derive:${cites}`;
    }
  }
  return `${episodeId}:summarize:${op.kind}:${i}`;
}
