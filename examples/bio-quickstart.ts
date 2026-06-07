/**
 * Mneme bio-layer quickstart — an AI agent's episodic memory.
 *
 * In a real project you would import from the published package:
 *     import { createMneme, createSqliteAdapter, createBioMemory } from "mneme";
 * Here we import the package-root module directly so the example runs in-repo.
 *
 * The bio layer is a cognitive overlay on the claim store: it recalls relevant
 * memories for a task (an "episode"), reinforces the ones that led to success,
 * and consolidates. It does not replace claims — it learns which ones matter.
 */
import { fileURLToPath } from "node:url";
import { createMneme, createSqliteAdapter, createBioMemory, DEFAULT_SCALAR_PSEUDOCOUNT } from "../src/index.js";
import type { CorpusDef, RetrievalContext, Claim } from "../src/index.js";

export interface BioQuickstartResult {
  recalledCount: number;
  cycleErrors: number;
  opsApplied: number;
  seededAlpha: number;
  reinforcedAlpha: number;
  consolidationErrors: number;
}

const CORPUS = "agent:memory";
const SEEDED_ALPHA = 3;

const corpusDef: CorpusDef = {
  id: CORPUS,
  displayName: "Agent Memory",
  schema: {
    version: "1",
    subjects: ["project"],
    scopeFields: {},
    required: [],
    scalarPseudocount: { ...DEFAULT_SCALAR_PSEUDOCOUNT },
  },
  defaults: {
    decayPolicy: { kind: "none" },
    confidenceThreshold: 0,
    contradictionPolicy: { kind: "always_accept" },
    defaultStatus: ["validated"],
  },
  requiredTiers: [{ kind: "core" }],
  metadata: {},
  createdAt: 0,
  updatedAt: 0,
};

// A memory the agent has learned about the project. Beta {alpha:3, beta:1} = some evidence.
function memory(key: string, value: string) {
  return {
    profile: "agent",
    workspace: CORPUS,
    subject: "project",
    key,
    scope: {},
    value,
    confidence: {
      distribution: "beta",
      parameters: { alpha: SEEDED_ALPHA, beta: 1 },
      raw: SEEDED_ALPHA / (SEEDED_ALPHA + 1),
    },
    valid: { from: 0, to: Infinity },
    source: "manual",
    provenance: {},
    evidence: [],
    tags: [],
    schema: `${CORPUS}@1`,
  } as never;
}

export function runBioQuickstart(): BioQuickstartResult {
  // 1. Construct the claim store, then the bio (cognitive) layer over it.
  const adapter = createSqliteAdapter(":memory:");
  const mneme = createMneme({ adapter, availableTiers: [{ kind: "core" }] });
  mneme.createCorpus(corpusDef);
  const bio = createBioMemory({ mneme, corpusId: CORPUS });

  // 2. Seed memories the agent already knows.
  mneme.commit(CORPUS, memory("build.cmd", "npm run build"), { writer: "agent" });
  mneme.commit(CORPUS, memory("tests.dir", "src/"), { writer: "agent" });

  // 3. Open an episode (one task / session).
  const ep = bio.openEpisode();

  // 4. Recall memories into the episode — passing ep.id records them as "surfaced".
  const ctx: RetrievalContext = { now: Date.now(), decay: () => 1 };
  const recalled = bio.recall({ corpusId: CORPUS } as never, [], ctx, ep.id);

  // 5. Report a successful outcome. The inline cognitive cycle (evidence-update) gives
  //    credit only to the surfaced memories, superseding each with a higher-alpha Beta.
  const report = bio.recordOutcome(ep.id, "success");

  // 6. Observe reinforcement: the seeded memory was superseded; read the active replacement
  //    and check its alpha rose above the seeded value.
  //    mneme.read with no `status` filter returns ALL claims (including the deprecated
  //    originals), so we exclude `deprecated` to find the live, reinforced replacement.
  const active = mneme
    .read(CORPUS, { corpusId: CORPUS })
    .filter(
      (c: Claim) => c.subject === "project" && c.key === "build.cmd" && c.status !== "deprecated",
    );
  const reinforcedAlpha =
    (active[0]?.confidence as { parameters?: { alpha: number } })?.parameters?.alpha ?? SEEDED_ALPHA;

  // 7. Consolidate the episode (model-free: fold/promote/deprecate per policy). In this
  //    minimal scenario consolidation is a no-op; see BioPolicy for promotion/fold rules.
  const consolidation = bio.consolidate(ep.id);

  return {
    recalledCount: recalled.length,
    cycleErrors: report.errors.length,
    opsApplied: report.opsApplied,
    seededAlpha: SEEDED_ALPHA,
    reinforcedAlpha,
    consolidationErrors: consolidation.errors.length,
  };
}

// Script entry: `npx tsx examples/bio-quickstart.ts` (or `npm run example:bio`).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = runBioQuickstart();
  console.log("Mneme bio-layer quickstart — an AI agent's episodic memory\n");
  console.log(`  memories recalled into the episode:   ${r.recalledCount}`);
  console.log(`  cognitive cycle errors:               ${r.cycleErrors}`);
  console.log(`  reinforcement ops applied:            ${r.opsApplied}`);
  console.log(`  seeded memory alpha:                  ${r.seededAlpha}`);
  console.log(`  reinforced memory alpha (after win):  ${r.reinforcedAlpha}`);
  console.log(`  consolidation errors:                 ${r.consolidationErrors}`);
}
