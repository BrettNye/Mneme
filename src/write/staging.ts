import type { CandidateClaim } from "../core/claim.js";
import { newClaimId } from "../core/ids.js";

export interface StagedEntry {
  stagingId: string;
  corpusId: string;
  candidate: CandidateClaim;
  idempotencyKey?: string;
}

export class StagingBuffer {
  private readonly entries = new Map<string, StagedEntry>();

  emit(corpusId: string, candidate: CandidateClaim, idempotencyKey?: string): string {
    const stagingId = newClaimId() as string;            // UUID staging handle, distinct from a committed claim id
    this.entries.set(stagingId, { stagingId, corpusId, candidate, idempotencyKey });
    return stagingId;
  }

  take(stagingId: string): StagedEntry | undefined {
    const e = this.entries.get(stagingId);
    if (e) this.entries.delete(stagingId);
    return e;
  }

  takeAll(corpusId: string): StagedEntry[] {
    const out = [...this.entries.values()].filter((e) => e.corpusId === corpusId);
    for (const e of out) this.entries.delete(e.stagingId);
    return out;
  }

  list(corpusId?: string): { stagingId: string; corpusId: string }[] {
    return [...this.entries.values()]
      .filter((e) => corpusId === undefined || e.corpusId === corpusId)
      .map(({ stagingId, corpusId }) => ({ stagingId, corpusId }));
  }

  discard(stagingId: string): boolean {
    return this.entries.delete(stagingId);
  }
}
