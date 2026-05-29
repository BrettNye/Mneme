import type { Corpus } from "./corpus.js";
import type { ClaimSchema } from "./schema.js";
import { validateRequiredTiers, type TierRequirement } from "./tiers.js";

export class Catalog {
  private readonly corpora = new Map<string, Corpus>();

  constructor(private readonly availableTiers: TierRequirement[]) {}

  createCorpus(c: Corpus): Corpus {
    validateRequiredTiers(c.requiredTiers, this.availableTiers);
    this.corpora.set(c.id, c);
    return c;
  }

  getCorpus(id: string): Corpus {
    const c = this.corpora.get(id);
    if (!c) throw new Error(`unknown corpus "${id}"`);
    return c;
  }

  getCorpusSchema(id: string): ClaimSchema {
    return this.getCorpus(id).schema;
  }

  deleteCorpus(id: string): void {
    if (!this.corpora.has(id)) throw new Error(`unknown corpus "${id}"`);
    this.corpora.delete(id);
  }

  listCorpora(filter?: (c: Corpus) => boolean): Corpus[] {
    const all = [...this.corpora.values()];
    return filter ? all.filter(filter) : all;
  }
}
