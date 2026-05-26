import { createMneme, type Mneme } from "../mneme.js";
import { createSqliteAdapter } from "../adapters/sqlite.js";
import type { Corpus as CorpusDef } from "../catalog/corpus.js";
import type { ClaimSchema } from "../catalog/schema.js";

const bioSchema: ClaimSchema = {
  version: "1",
  subjects: [],
  scopeFields: {},
  required: [],
  scalarPseudocount: { manual: 2, llm: 2, heuristic: 2, verification: 2, workflow: 2, imported: 2 },
};

const bioCorpusDef: CorpusDef = {
  id: "bio-test",
  displayName: "Bio Test Corpus",
  schema: bioSchema,
  defaults: {
    decayPolicy: { kind: "none" },
    confidenceThreshold: 0.0,
    contradictionPolicy: { kind: "always_accept" },
    defaultStatus: ["validated"],
  },
  requiredTiers: [{ kind: "core" }],
  metadata: {},
  createdAt: 0,
  updatedAt: 0,
};

/**
 * Builds a Mneme with a permissive registered corpus for bio tests.
 * Use this as the single DRY source of truth for obtaining a Mneme-backed
 * gateway/facade — avoids repeating createMneme/createCorpus boilerplate
 * across bio test files.
 */
export function makeBioMneme(): { mneme: Mneme; corpusId: string } {
  const mneme = createMneme({
    adapter: createSqliteAdapter(),
    availableTiers: [{ kind: "core" }],
  });
  const corpusId = bioCorpusDef.id;
  mneme.createCorpus(bioCorpusDef);
  return { mneme, corpusId };
}
