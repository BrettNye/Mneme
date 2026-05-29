/**
 * Mneme quickstart — service/host status monitoring.
 *
 * In a real project you would import from the published package:
 *     import { createMneme, createSqliteAdapter, pipe, leaf, sigma, rho, kappa, delta } from "mneme";
 * Here we import the package-root module directly so the example runs in-repo.
 */
import { fileURLToPath } from "node:url";
import {
  createMneme,
  createSqliteAdapter,
  pipe,
  leaf,
  sigma,
  rho,
  kappa,
  delta,
} from "../src/index.js";
// index.ts exports the catalog corpus as `CorpusDef` and the algebra corpus as `Corpus`.
import type { CorpusDef, ComposedContext, Corpus } from "../src/index.js";

export interface QuickstartResult {
  committedId: string;
  contextIncludesValue: boolean;
  supersededOldStatus: string;
  replacementValue: string;
  rawConfidence: number;
  effectiveAfterDecay: number;
  replayStatusOfPlainClaim: string;
}

const CORPUS = "infra:prod";

const corpusDef: CorpusDef = {
  id: CORPUS,
  displayName: "Production Infrastructure",
  schema: {
    version: "1",
    subjects: ["host:web-01", "host:web-02"],
    scopeFields: {},
    required: [],
    scalarPseudocount: {},
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

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function runQuickstart(): QuickstartResult {
  // 1. Construct: an in-memory store + a corpus (a namespaced claim store).
  const adapter = createSqliteAdapter(":memory:");
  const mneme = createMneme({ adapter, availableTiers: [{ kind: "core" }] });
  mneme.createCorpus(corpusDef);

  // 2. Commit a claim. confidence is a Beta distribution {alpha, beta}: 8 of 9
  //    recent probes saw host:web-01 healthy, so we have strong-but-not-certain evidence.
  const committed = mneme.commit(
    CORPUS,
    {
      profile: "ops",
      workspace: CORPUS,
      subject: "host:web-01",
      key: "status",
      scope: {},
      value: "healthy",
      confidence: { distribution: "beta", parameters: { alpha: 8, beta: 1 }, raw: 8 / 9 },
      valid: { from: 0, to: Infinity },
      source: "manual",
      provenance: {},
      evidence: [],
      tags: [],
      schema: `${CORPUS}@1`,
    } as never,
    { writer: "healthcheck" },
  );

  // 3. Query it back as an LLM/report-ready, token-bounded context (select → rank → compose).
  const ctx = mneme.query<ComposedContext>(
    CORPUS,
    pipe(
      leaf(CORPUS),
      sigma({ op: "subjectEq", value: "host:web-01" }),
      rho.jaccard("web-01 status"),
      kappa.markdown(2000),
    ),
  );
  const contextIncludesValue = ctx.content.includes("healthy");

  // 4. Contradiction → resolve. Fresh probes flip web-01 to "degraded". supersede deprecates
  //    the old claim and commits the replacement — belief change is explicit and auditable.
  const sup = mneme.supersede(
    CORPUS,
    committed.id,
    {
      profile: "ops",
      workspace: CORPUS,
      subject: "host:web-01",
      key: "status",
      scope: {},
      value: "degraded",
      confidence: { distribution: "beta", parameters: { alpha: 5, beta: 4 }, raw: 5 / 9 },
      valid: { from: 0, to: Infinity },
      source: "manual",
      provenance: {},
      evidence: [],
      tags: [],
      schema: `${CORPUS}@1`,
    } as never,
    { writer: "healthcheck" },
  );
  const oldClaim = mneme.readByIds(CORPUS, [committed.id as never])[0];
  const supersededOldStatus = oldClaim.status; // "deprecated"
  const replacement = mneme.readByIds(CORPUS, [sup.id as never])[0];
  const replacementValue = replacement.value as string; // "degraded"

  // 5. Decay over time. Commit a second host's status, then query it under an exponential
  //    decay policy at a clock 30 days after it was recorded — effective confidence drops as
  //    the reading goes stale. The pinned evaluationClock makes this deterministic.
  const c2 = mneme.commit(
    CORPUS,
    {
      profile: "ops",
      workspace: CORPUS,
      subject: "host:web-02",
      key: "status",
      scope: {},
      value: "healthy",
      confidence: { distribution: "beta", parameters: { alpha: 9, beta: 1 }, raw: 0.9 },
      valid: { from: 0, to: Infinity },
      source: "manual",
      provenance: {},
      evidence: [],
      tags: [],
      schema: `${CORPUS}@1`,
    } as never,
    { writer: "healthcheck" },
  );
  const web02 = mneme.readByIds(CORPUS, [c2.id as never])[0];
  const decayed = mneme.query<Corpus>(
    CORPUS,
    pipe(leaf(CORPUS), sigma({ op: "subjectEq", value: "host:web-02" }), delta.exponential(7)),
    { evaluationClock: web02.recorded + THIRTY_DAYS_MS },
  );
  const decayedClaim = decayed.claims[0];
  const rawConfidence = decayedClaim.confidence.raw;
  // effective is always populated by delta.exponential; the ?? rawConfidence guard only
  // matters if a future engine regression omits it — in which case the assertion below
  // (effective < raw) fails loudly rather than throwing on undefined.
  const effectiveAfterDecay = decayedClaim.confidence.effective ?? rawConfidence;

  // 6. Reproducibility / replay. A normal committed claim has no recorded query, so replay
  //    reports integrity_unknown. Claims DERIVED from a recorded query re-execute to
  //    exact / mismatch (see the replay-engine design doc).
  const replayStatusOfPlainClaim = mneme.replay(web02).status;

  return {
    committedId: committed.id,
    contextIncludesValue,
    supersededOldStatus,
    replacementValue,
    rawConfidence,
    effectiveAfterDecay,
    replayStatusOfPlainClaim,
  };
}

// Script entry: `npx tsx examples/quickstart.ts` (or `npm run example`).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = runQuickstart();
  console.log("Mneme quickstart — service/host status monitoring\n");
  console.log(`  committed web-01 status claim:        ${r.committedId}`);
  console.log(`  composed context mentions "healthy":  ${r.contextIncludesValue}`);
  console.log(`  old claim status after supersede:     ${r.supersededOldStatus}`);
  console.log(`  web-01 current status:                ${r.replacementValue}`);
  console.log(`  web-02 raw confidence:                ${r.rawConfidence.toFixed(4)}`);
  console.log(`  web-02 effective after 30d decay:     ${r.effectiveAfterDecay.toFixed(4)}`);
  console.log(`  replay(plain claim) status:           ${r.replayStatusOfPlainClaim}`);
}
