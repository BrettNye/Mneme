import { Catalog } from "./catalog.js";
import { StagingBuffer, type StagedEntry } from "../write/staging.js";
import type { Corpus as CorpusDef } from "./corpus.js";
import type { CandidateClaim } from "../core/claim.js";

/**
 * Backend-agnostic corpus-catalog + staging methods, shared between the sync `createMneme`
 * (src/mneme.ts) and a future async surface. Method bodies mirror the corresponding
 * `createMneme` methods exactly — see src/mneme.ts for the source of truth.
 */
export interface CatalogFacade {
  createCorpus(corpus: CorpusDef): CorpusDef;
  /** Remove a corpus from the catalog registry (§6.1). Throws for an unknown corpus. */
  deleteCorpus(corpusId: string): void;
  /** List registered corpora (§6.2), optionally narrowed by a predicate. */
  listCorpora(filter?: (c: CorpusDef) => boolean): CorpusDef[];
  /** §7.1 Stage a candidate without committing it. Throws for an unknown corpus. */
  emitCandidate(corpusId: string, candidate: CandidateClaim, opts?: { idempotencyKey?: string }): { stagingId: string };
  /** §7.1 List staged entries, optionally filtered by corpusId. */
  listStaged(corpusId?: string): { stagingId: string; corpusId: string }[];
  /** §7.1 Discard a staged entry without committing. Returns true if found, false if absent. */
  discardStaged(stagingId: string): boolean;
  /**
   * Removes and returns the full staged entry (candidate + idempotencyKey) for a given
   * stagingId. The promote glue (a future async surface's `promoteStaged`) uses this to
   * hand the entry off to the commit pipeline. Returns undefined for an unknown stagingId.
   */
  takeStaged(stagingId: string): StagedEntry | undefined;
  /**
   * Removes and returns all staged entries for a corpus. The promote glue (a future async
   * surface's `promoteAllStaged`) uses this to hand the batch off to commitBatch.
   */
  takeAllStaged(corpusId: string): StagedEntry[];
}

export function createCatalogFacade(catalog: Catalog, staging: StagingBuffer): CatalogFacade {
  return {
    createCorpus(corpus: CorpusDef): CorpusDef {
      return catalog.createCorpus(corpus);
    },

    deleteCorpus(corpusId: string): void {
      catalog.deleteCorpus(corpusId); // throws for unknown corpus
    },

    listCorpora(filter?: (c: CorpusDef) => boolean): CorpusDef[] {
      return catalog.listCorpora(filter);
    },

    emitCandidate(corpusId: string, candidate: CandidateClaim, opts?: { idempotencyKey?: string }): { stagingId: string } {
      catalog.getCorpus(corpusId); // throws for unknown corpus
      return { stagingId: staging.emit(corpusId, candidate, opts?.idempotencyKey) };
    },

    listStaged(corpusId?: string) {
      return staging.list(corpusId);
    },

    discardStaged(stagingId: string): boolean {
      return staging.discard(stagingId);
    },

    takeStaged(stagingId: string): StagedEntry | undefined {
      return staging.take(stagingId);
    },

    takeAllStaged(corpusId: string): StagedEntry[] {
      return staging.takeAll(corpusId);
    },
  };
}
