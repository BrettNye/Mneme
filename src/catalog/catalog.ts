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
}
