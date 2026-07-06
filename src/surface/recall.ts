/**
 * recall / keyCensus — pure operations over the `Session` facade.
 *
 * Invariant: these functions perform NO filesystem side effects (no recall-log
 * writes, no file I/O). `recall` is `async` solely so it can `await` embedding
 * warm-up (`warmValues`) before scoring; it does not await anything else.
 * Logging (e.g. appending to the recall-log) is the server's responsibility,
 * not this module's — keep it that way so these ops stay testable in isolation
 * and reusable outside the MCP transport.
 */
import type { Predicate, RankedCorpus } from "../index.js";
import { pipe, leaf } from "../mneme.js";
import { sigma as sigmaOp } from "../algebra/selection.js";
import { rho as rhoOp } from "../algebra/similarity.js";
import { rankBlend } from "../algebra/ranking.js";
import { leafHintsOf, type LeafHints } from "../algebra/pushdown.js";
import { kappa as kappaOp } from "../algebra/composition.js";
import type { Stage } from "../algebra/expression.js";
import { fromCorpus } from "../algebra/expression.js";
import type { Corpus } from "../algebra/types.js";
import type { Session, ReadDeps } from "./types.js";
import type { Claim } from "../core/claim.js";
import type { ExecutionPlan } from "../adapters/adapter-types.js";
import { pointEstimate } from "../core/confidence.js";
import { canonicalReadStages } from "../retrieval/read-pipeline.js";
import { RULE } from "../distribution/rules.js";
import { resolveKeyCardinality, cardinalitySafetyWarnings } from "./cardinality.js";

/**
 * MCP corpora carry SCALAR confidences (remember writes scalarConfidence), and
 * the scalar binding rejects EVIDENCE_POOLED until pseudocount promotion lands
 * (C7 / bio slice). With a ratified alias map, ⊥'s canonical grouping can
 * co-locate same-value claims from drifted keys (⊕_dedupe is alias-blind) and
 * the pooling fold would crash recall/census. MAX_MEAN is the conservative
 * scalar choice: agreement never decreases confidence, never invents evidence.
 * Discovered by the key-matching oracle sweep, 2026-06-06.
 */
export const MCP_EVIDENCE_POOLING_RULE = RULE.MAX_MEAN;
import { abstainBelowTop, relevanceFloor } from "../algebra/similarity.js";
import { warmValues } from "../algebra/embedding.js";
import type { EmbeddingAdapter, EmbeddingCache } from "../algebra/embedding.js";
import { KEY_ALIAS_KEY, aliasMapOf, keyFamilyOf } from "../retrieval/key-alias.js";
import type { KeyAliasMap } from "../retrieval/key-alias.js";
import { entityTokensOf, coverageOf } from "../retrieval/coverage.js";
import type { CoverageReport } from "../retrieval/coverage.js";

export interface EmbeddingState {
  rankFn: "hybrid" | "jaccard";
  adapter?: EmbeddingAdapter;
  cache?: EmbeddingCache;
}

/** @deprecated prefer ReadDeps; retained as a byte-compatible alias. */
export type RecallDeps = ReadDeps;

/** The shape recall needs from a corpus def — structurally satisfied by CorpusDef. */
export type CorpusDefLike = {
  id: string;
  schema?: { keyCardinality?: Record<string, "single" | "multi"> };
};

/**
 * Minimal read seam recall needs. Satisfied structurally by BOTH the sync `Mneme`
 * facade (via `session.mneme`) and a future async facade — `read` may return its
 * rows synchronously or via a Promise; callers `await` it either way.
 */
export interface RecallSource {
  listCorpora(filter?: (c: CorpusDefLike) => boolean): CorpusDefLike[];
  read(corpusId: string, plan: ExecutionPlan): Claim[] | Promise<Claim[]>;
}

// ── Shared private helper: alias-load + variant-cardinality warnings ──────────

export interface AliasLoadContext {
  aliasMap: KeyAliasMap;
  selfAliases: string[];
  warnings: string[];
}

/**
 * The pure post-read part of loadAliasContext (task-pure-helpers): builds the alias
 * map + variant-cardinality warnings from already-fetched alias claims. No I/O — safe
 * to call outside the read/try-catch boundary.
 */
export function aliasContextFrom(
  aliasClaims: readonly Claim[],
  now: number,
  keyCardinality?: Record<string, "single" | "multi">,
): AliasLoadContext {
  const { map: aliasMap, selfAliases, warnings } = aliasMapOf(aliasClaims, { evaluationInstant: now });

  // Variant-cardinality warnings
  if (keyCardinality) {
    for (const variant of Object.keys(aliasMap)) {
      if (keyCardinality[variant] !== undefined) {
        warnings.push(
          `variant key "${variant}" (alias of "${aliasMap[variant]}") has a cardinality declaration (${keyCardinality[variant]}) — alias may shadow the override`,
        );
      }
    }
  }

  return { aliasMap, selfAliases, warnings };
}

/**
 * Loads alias claims from the corpus and builds the alias map + variant-cardinality warnings.
 * On failure: degrades gracefully — returns empty alias map with a warning.
 * Shared by both recall() and keyCensus() to avoid duplication.
 */
export function loadAliasContext(
  session: Session,
  corpus: string,
  now: number,
  keyCardinality?: Record<string, "single" | "multi">,
): AliasLoadContext {
  try {
    const aliasClaims = session.mneme.read(corpus, {
      corpusId: corpus,
      key: KEY_ALIAS_KEY,
    });
    return aliasContextFrom(aliasClaims, now, keyCardinality);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      aliasMap: {},
      selfAliases: [],
      warnings: [`alias load failed — proceeding without alias expansion: ${msg}`],
    };
  }
}

/** Parse an asOf temporal scope (epoch ms number or ISO-8601 string) to epoch ms.
 *  Returns undefined when not supplied; throws on an unparseable string/number.
 *  Note: 0 is a valid instant (1970-01-01), NOT "now" — omit asOf to mean now. */
export function parseAsOf(asOf?: string | number): number | undefined {
  if (asOf === undefined) return undefined;
  const ms = typeof asOf === "number" ? asOf : Date.parse(asOf);
  if (!Number.isFinite(ms)) {
    throw new Error(`recall: asOf is not a valid date (epoch ms or ISO-8601): ${String(asOf)}`);
  }
  return ms;
}

export interface RecallArgs {
  about: string;
  corpus: string;
  subject?: string;
  key?: string;
  maxTokens?: number;
  limit?: number;
  /** Abstention threshold: if top score STRICTLY below this, the entire result is
   *  empty and abstained=true. Default 0 = off. */
  abstainBelowTop?: number;
  /** Per-entry precision floor: entries with score below this are dropped.
   *  Default 0 = off. abstained stays false even if floor empties the result. */
  relevanceFloor?: number;
  /** Relevance↔recency blend weight in [0,1]. Default 0.5. `1` = pure similarity
   *  (recency off, exact current behavior); `0` = pure recency. */
  recencyAlpha?: number;
  /** Exponential recency half-life in days (> 0). Default 90. */
  recencyHalfLifeDays?: number;
  /** Temporal scope: ISO-8601 string or epoch ms. Anchors BOTH tauValid (which
   *  claims are valid) and the recency term (age measured from this instant).
   *  Default = now. */
  asOf?: string | number;
}
export interface RecallMatch {
  subject: string;
  key: string;
  value: unknown;
  confidence: number;
  score: number;
  /** Claim id — provenance handle so agents can cite the exact claim. */
  id: string;
  /** Claim tags (e.g. session:...) — attribution handle. */
  tags: string[];
}
export interface RecallResult {
  corpus: string;
  content: string;
  matches: RecallMatch[];
  /** Pre-knob top score (before abstain/floor). Present when the corpus exists
   *  and at least one claim was scored; undefined when corpus is empty or unknown. */
  topScore?: number;
  /** True when abstainBelowTop was applied and the top score was strictly below
   *  the threshold (entire result suppressed). The floor emptying everything is
   *  NOT "abstained" — it is precision filtering. */
  abstained: boolean;
  /** The similarity fn name used for ranking (from deps.embeddings.rankFn). */
  rankFn: string;
  /** Non-fatal warnings surfaced during alias loading or cardinality checking.
   *  Present only when there is at least one warning; undefined otherwise.
   *  The server layer is responsible for surfacing these to the caller. */
  warnings?: string[];
  /** Entity-coverage facts over the PRE-knob ranked survivors ("available to
   *  this recall"). Always present; agent-in-the-loop refusal input. */
  coverage: CoverageReport;
}

export interface FilterPlan {
  sigmas: Stage<Corpus, Corpus>[];
  hints: LeafHints;
}

/** σ stages + leaf hints derived from ONE predicate list — the sealed pair (spec §4
 *  amendment A1): a hint narrower than σ is unrepresentable by construction, since both
 *  are folds over the same `preds` array. Mirrors the family-vs-single logic used by
 *  both recall() and explainRecall(). */
/** σ stages + leaf hints derived from ONE predicate list — the sealed pair (spec §4
 *  amendment A1): a hint narrower than σ is unrepresentable by construction, since both
 *  are folds over the same `preds` array. Mirrors the family-vs-single logic used by
 *  both recall() and explainRecall().
 *
 *  Sigmas are the PURE `sigmaOp(p)` stages (task-pure-helpers B4): value-predicate
 *  routing (routeValuePredicates, from mneme.js's ctx-aware `sigma`) is a no-op for
 *  subjectEq/keyEq/keyIn (they are never value predicates), so this is byte-safe —
 *  and an arity-1 `(c: Corpus) => Corpus` stays assignable to `Stage<Corpus, Corpus>`. */
export function buildFilterPlan(args: RecallArgs, family?: string[]): FilterPlan {
  const preds: Predicate[] = [];
  if (args.subject) preds.push({ op: "subjectEq", value: args.subject });
  if (family && family.length > 1) preds.push({ op: "keyIn", values: family });
  else if (args.key) preds.push({ op: "keyEq", value: args.key });
  return { sigmas: preds.map((p) => sigmaOp(p)), hints: leafHintsOf(preds) };
}

/** The ONE home for the alpha/half-life dials (task-pure-helpers B10): pure rho when
 *  recencyAlpha===1, else rankBlend (default alpha .5 / 90d). Clock-free — `now` is a
 *  parameter, not read from ctx. */
export function buildRecallRankerPure(
  args: RecallArgs,
  rankFn: string,
  now: number,
): (c: Corpus) => RankedCorpus {
  return args.recencyAlpha === 1
    ? rhoOp(rankFn, args.about)
    : rankBlend(
        rankFn,
        args.about,
        { alpha: args.recencyAlpha ?? 0.5, halfLifeDays: args.recencyHalfLifeDays ?? 90 },
        now,
      );
}

/** Stage wrapper — a one-line ctx adapter over buildRecallRankerPure. explain.ts and
 *  recall() keep consuming this unchanged. */
export function buildRecallRanker(args: RecallArgs, rankFn: string): Stage<Corpus, RankedCorpus> {
  return (c, ctx) => buildRecallRankerPure(args, rankFn, ctx.evaluationClock ?? Date.now())(c);
}

/** Warm embedding values for the σ-scoped claims (family-expanded), so hybrid scoring
 *  uses cosine not jaccard-fallback. No-op unless hybrid + adapter + cache present.
 *  Single read (amendment A9): a family expands to `keys: family` in ONE adapter plan
 *  instead of one read per family member — the adapter's own key-set match replaces the
 *  per-key loop + manual id-dedup (a family is a set; the adapter already dedupes rows).
 *  Takes any `RecallSource` (task-pure-helpers): `warmRecallValues` delegates with
 *  `session.mneme`. */
export async function warmRecallValuesOver(
  source: RecallSource, args: RecallArgs, embeddings: EmbeddingState, family?: string[],
): Promise<void> {
  if (embeddings.rankFn === "jaccard" || !embeddings.adapter || !embeddings.cache) return;
  const plan = family && family.length > 1
    ? { corpusId: args.corpus, subject: args.subject, keys: family }
    : { corpusId: args.corpus, subject: args.subject, key: args.key };
  const rawClaims = await source.read(args.corpus, plan);
  await warmValues(embeddings.adapter, embeddings.cache, rawClaims.map((c) => c.value), [args.about]);
}

/** Sync wrapper — exact signature preserved; delegates with `session.mneme`. */
export async function warmRecallValues(
  session: Session, args: RecallArgs, embeddings: EmbeddingState, family?: string[],
): Promise<void> {
  return warmRecallValuesOver(session.mneme, args, embeddings, family);
}

export async function recall(
  session: Session,
  args: RecallArgs,
  deps: RecallDeps,
): Promise<RecallResult> {
  const embeddings: EmbeddingState = deps.embeddings;
  const keyCardinality = resolveKeyCardinality(session, args.corpus, deps.keyCardinality);

  const maxTokens = args.maxTokens ?? 2000;
  const limit = args.limit ?? 5;
  const emptyResult = {
    corpus: args.corpus,
    content: "",
    matches: [] as RecallMatch[],
    abstained: false,
    rankFn: embeddings.rankFn,
  };

  // Entity tokens computed once — used by the unknown-corpus early return AND
  // the post-pipeline coverage computation.
  const entities = entityTokensOf(args.about);
  const coverageWarning = (missing: string[]): string =>
    `question entities with no claim available to this recall: ${missing.map((m) => `'${m}'`).join(", ")}`;

  // Read-only: a recall against an unknown corpus returns empty — it MUST NOT create the
  // corpus (so the tool can honestly advertise readOnlyHint). remember() still ensures-on-write.
  if (!session.listCorpora().some((c) => c.id === args.corpus)) {
    const coverage = coverageOf(entities, []); // unknown corpus: nothing available
    return {
      ...emptyResult,
      coverage,
      warnings: coverage.missing.length > 0 ? [coverageWarning(coverage.missing)] : undefined,
    };
  }

  // ── Alias map loading ────────────────────────────────────────────────────────
  // Fetch alias claims (index-backed: adapter pushdown via key predicate).
  // On failure: degrade gracefully — recall proceeds alias-less with a warning.
  const now = parseAsOf(args.asOf) ?? Date.now();
  // selfAliases is keyCensus-only; recall only needs aliasMap + warnings.
  const { aliasMap, warnings: aliasWarnings } = loadAliasContext(session, args.corpus, now, keyCardinality);
  const allWarnings: string[] = [...aliasWarnings];

  // ── Key family expansion ─────────────────────────────────────────────────────
  // Expand the requested key to the full family (canonical + all variants).
  // For a single unmapped key, keyFamilyOf returns [key] — no behavioral change.
  const family: string[] | undefined = args.key ? keyFamilyOf(args.key, aliasMap) : undefined;

  // ── Warm-up (hybrid only) ────────────────────────────────────────────────────
  // Warm claim values scoped to the same subject/key predicates as the σ stages,
  // using the FAMILY-expanded key set so variant-key claims are cosine-scored, not
  // jaccard-fallback (which would happen if they were not in the warm-up cache).
  await warmRecallValues(session, args, embeddings, family);

  // ── σ filter stages + leaf hints (sealed pair, spec §4 A1) ───────────────────
  // Build filter predicates. When the key has a multi-key alias family, use keyIn
  // so all family members (canonical + variants) are included in a single pass.
  // hints are derived from the SAME preds as sigmas — a hint narrower than σ is
  // unrepresentable by construction.
  const { sigmas, hints } = buildFilterPlan(args, family);

  // Recency-aware ranking (on by default at alpha=0.5/90d). alpha=1 ⇒ pure rho.by,
  // byte-identical to prior behavior. `now` (asOf or Date.now) anchors both tauValid
  // (canonicalReadStages.evaluationInstant) and the recency term (ctx.evaluationClock).
  const ranker = buildRecallRanker(args, embeddings.rankFn);

  // canon = [τ_valid, ⊕_dedupe, ⊥/resolve, drop] — captured so the τ_valid+dedupe prefix
  // (canon[0], canon[1]) can be reused by the cardinality safety check below.
  const canon = canonicalReadStages({
    evaluationInstant: now,
    keyCardinality,
    keyAliases: aliasMap,
    evidencePoolingRule: MCP_EVIDENCE_POOLING_RULE,
  });

  // ── Shared prefix (Phase 2, spec §5): ONE I/O pass ──────────────────────────
  // leaf → σ(s) → τ_valid → ⊕_dedupe evaluated ONCE. `preContra` (pre-⊥/resolve)
  // feeds BOTH the cardinality-safety check below AND the ranked main query
  // (via fromCorpus, zero further adapter I/O) — replacing the former two
  // racing adapter reads with a single shared read. Snapshot consistency is an
  // intended improvement: warnings and the ranked result now derive from the
  // same read instead of two separate ones.
  const preContra = session.mneme.query<Corpus>(
    args.corpus,
    pipe(leaf(args.corpus, hints), ...sigmas, canon[0], canon[1]),
    { evaluationClock: now },
  );

  // ── Cardinality safety check (best-effort; never throws into recall) ────────
  // Computed FIRST from the shared preContra, but BUFFERED — appended to
  // allWarnings only after the coverage warning below, preserving today's
  // alias → coverage → cardinality order byte-identically.
  let safetyWarnings: string[];
  try {
    safetyWarnings = cardinalitySafetyWarnings(preContra, keyCardinality, aliasMap);
  } catch (e) {
    safetyWarnings = [`cardinality-safety check failed: ${e instanceof Error ? e.message : String(e)}`];
  }

  // Main result: fromCorpus(preContra) → ⊥/resolve → drop → ranker. No adapter
  // I/O here — leaf() has already run as part of the shared prefix above.
  const ranked = session.mneme.query<RankedCorpus>(
    args.corpus,
    pipe(fromCorpus(preContra), canon[2], canon[3], ranker),
    { evaluationClock: now },
  );

  // topScore: pre-knob, extracted immediately after canonical resolution + ranking.
  const topScore = ranked.scored[0]?.score;

  // Entity coverage over the PRE-knob survivor set (the bench-validated basis;
  // knobs affect what is returned, not what was available).
  const coverage = coverageOf(entities, ranked.scored.map((s) => s.claim));
  if (coverage.missing.length > 0) {
    allWarnings.push(coverageWarning(coverage.missing));
  }

  // Buffered cardinality-safety warnings, appended AFTER coverage (today's order).
  allWarnings.push(...safetyWarnings);

  // In-memory knobs (pure RankedCorpus fns — NO second query):
  const abstainThreshold = args.abstainBelowTop ?? 0;
  const floorThreshold = args.relevanceFloor ?? 0;

  const afterAbstain = abstainBelowTop(abstainThreshold)(ranked);
  // abstained = abstain stage emptied a non-empty ranked corpus
  const abstained =
    ranked.scored.length > 0 && afterAbstain.scored.length === 0 && abstainThreshold > 0;

  const afterFloor = relevanceFloor(floorThreshold)(afterAbstain);
  const knobbed = afterFloor;

  // matches = raw ranked candidates (sliced to limit); κ content applies its own
  // dedupContent internally — intentional divergence between matches list and composed text.
  const matches: RecallMatch[] = knobbed.scored.slice(0, limit).map((s) => ({
    subject: s.claim.subject,
    key: s.claim.key,
    value: s.claim.value,
    confidence: pointEstimate(s.claim.confidence),
    score: s.score,
    id: s.claim.id,
    tags: [...s.claim.tags],
  }));

  // In-memory κ compose (pure — no second query).
  const composed = kappaOp("markdown", maxTokens)(knobbed);
  const content = abstained ? "" : composed.content;

  return {
    corpus: args.corpus,
    content,
    matches: abstained ? [] : matches,
    topScore,
    abstained,
    rankFn: embeddings.rankFn,
    coverage,
    warnings: allWarnings.length > 0 ? allWarnings : undefined,
  };
}

