import type { RankedCorpus, ScoredClaim } from "./types.js";
import type { Claim } from "../core/claim.js";
import type { ClaimId } from "../core/ids.js";

export type ClaimLookup = (id: ClaimId) => Claim | undefined;

/** Async twin of ClaimLookup (see AsyncStorageAdapter.getClaim). */
export type AsyncClaimLookup = (id: ClaimId) => Promise<Claim | undefined>;

/**
 * γ operator (§4.7): for each claim in the ranked corpus, follow `claim`-kind
 * evidence edges to the given depth, fetching cited claims via the injected
 * lookup. Returns the closure with no duplicate claims. Original scored claims
 * keep their scores; appended evidence claims are scored at 0.
 */
export const gamma =
  (depth: number, lookup: ClaimLookup) =>
  (rc: RankedCorpus): RankedCorpus => {
    // Build a mutable map keyed by claim id; initialise from the ranked corpus.
    const byId = new Map<string, ScoredClaim>(
      rc.scored.map((s) => [s.claim.id, s]),
    );

    // BFS frontier starts with every claim already in the corpus.
    let frontier: Claim[] = rc.scored.map((s) => s.claim);

    for (let d = 0; d < depth; d++) {
      const next: Claim[] = [];
      for (const cl of frontier) {
        for (const e of cl.evidence) {
          if (e.kind === "claim" && !byId.has(e.claimId)) {
            const cited = lookup(e.claimId);
            if (cited) {
              byId.set(cited.id, { claim: cited, score: 0 });
              next.push(cited);
            }
          }
        }
      }
      frontier = next;
    }

    return { scored: [...byId.values()] };
  };

/**
 * Async twin of γ (see `gamma` above) — SAME BFS shape, but the citation
 * lookup is awaited (the seam through which an AsyncStorageAdapter's
 * getClaim is threaded). Kept as a standalone async function (not curried)
 * to match the async Stage builder's calling convention in
 * async-expression.ts.
 */
export async function gammaAsyncTraverse(
  rc: RankedCorpus,
  depth: number,
  lookup: AsyncClaimLookup,
): Promise<RankedCorpus> {
  const byId = new Map<string, ScoredClaim>(
    rc.scored.map((s) => [s.claim.id, s]),
  );

  let frontier: Claim[] = rc.scored.map((s) => s.claim);

  for (let d = 0; d < depth; d++) {
    const next: Claim[] = [];
    for (const cl of frontier) {
      for (const e of cl.evidence) {
        if (e.kind === "claim" && !byId.has(e.claimId)) {
          const cited = await lookup(e.claimId);
          if (cited) {
            byId.set(cited.id, { claim: cited, score: 0 });
            next.push(cited);
          }
        }
      }
    }
    frontier = next;
  }

  return { scored: [...byId.values()] };
}
