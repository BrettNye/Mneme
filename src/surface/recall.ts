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
import { pipe, leaf, sigma, rho } from "../mneme.js";
import { kappa as kappaOp } from "../algebra/composition.js";
import type { Stage } from "../algebra/expression.js";
import type { Corpus } from "../algebra/types.js";
import type { Session } from "./types.js";
import { pointEstimate } from "../core/confidence.js";
import { canonicalReadStages } from "../retrieval/read-pipeline.js";
import { RULE } from "../distribution/rules.js";

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
import { abstainBelowTop, relevanceFloor, similarityFn } from "../algebra/similarity.js";
import { warmValues } from "../algebra/embedding.js";
import type { EmbeddingAdapter, EmbeddingCache } from "../algebra/embedding.js";
import { KEY_ALIAS_KEY, aliasMapOf, keyFamilyOf } from "../retrieval/key-alias.js";
import type { KeyAliasMap } from "../retrieval/key-alias.js";
import { entityTokensOf, coverageOf } from "../retrieval/coverage.js";
import type { CoverageReport } from "../retrieval/coverage.js";
import type { Corpus as AlgebraCorpus } from "../algebra/types.js";
import type { EvalContext } from "../algebra/expression.js";

export interface EmbeddingState {
  rankFn: "hybrid" | "jaccard";
  adapter?: EmbeddingAdapter;
  cache?: EmbeddingCache;
}

export interface RecallDeps {
  embeddings: EmbeddingState;
  keyCardinality?: Record<string, "single" | "multi">;
  // NOTE: arrives PRE-LOADED from the server; tools never import config.ts or MCP internals.
}

// ── Shared private helper: alias-load + variant-cardinality warnings ──────────

export interface AliasLoadContext {
  aliasMap: KeyAliasMap;
  selfAliases: string[];
  warnings: string[];
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
  const warnings: string[] = [];
  let aliasMap: KeyAliasMap = {};
  let selfAliases: string[] = [];

  try {
    const aliasClaims = session.mneme.read(corpus, {
      corpusId: corpus,
      key: KEY_ALIAS_KEY,
    });
    const { map, selfAliases: sa, warnings: loaderWarnings } = aliasMapOf(aliasClaims, { evaluationInstant: now });
    aliasMap = map;
    selfAliases = sa;
    warnings.push(...loaderWarnings);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`alias load failed — proceeding without alias expansion: ${msg}`);
  }

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

/** σ filter stages for recall: subject eq + key family (keyIn) / single key eq.
 *  Mirrors the family-vs-single logic used by both recall() and explainRecall(). */
export function buildFilterSigmas(args: RecallArgs, family?: string[]): Stage<Corpus, Corpus>[] {
  const filters: Predicate[] = [];
  if (args.subject) filters.push({ op: "subjectEq", value: args.subject });
  if (family && family.length > 1) filters.push({ op: "keyIn", values: family });
  else if (args.key) filters.push({ op: "keyEq", value: args.key });
  return filters.map((p) => sigma(p));
}

/** The recall ranker: pure rho.by when recencyAlpha===1, else rho.blend (default alpha .5 / 90d). */
export function buildRecallRanker(args: RecallArgs, rankFn: string): Stage<Corpus, RankedCorpus> {
  return args.recencyAlpha === 1
    ? rho.by(rankFn, args.about)
    : rho.blend(rankFn, args.about, {
        alpha: args.recencyAlpha ?? 0.5,
        halfLifeDays: args.recencyHalfLifeDays ?? 90,
      });
}

/** Warm embedding values for the σ-scoped claims (family-expanded), so hybrid scoring
 *  uses cosine not jaccard-fallback. No-op unless hybrid + adapter + cache present. */
export async function warmRecallValues(
  session: Session, args: RecallArgs, embeddings: EmbeddingState, family?: string[],
): Promise<void> {
  if (embeddings.rankFn === "jaccard" || !embeddings.adapter || !embeddings.cache) return;
  const seenIds = new Set<string>();
  const rawClaims: import("../core/claim.js").Claim[] = [];
  if (family && family.length > 1) {
    for (const k of family) {
      for (const c of session.mneme.read(args.corpus, { corpusId: args.corpus, subject: args.subject, key: k })) {
        if (!seenIds.has(c.id)) { seenIds.add(c.id); rawClaims.push(c); }
      }
    }
  } else {
    rawClaims.push(...session.mneme.read(args.corpus, { corpusId: args.corpus, subject: args.subject, key: args.key }));
  }
  await warmValues(embeddings.adapter, embeddings.cache, rawClaims.map((c) => c.value), [args.about]);
}

export async function recall(
  session: Session,
  args: RecallArgs,
  deps: RecallDeps,
): Promise<RecallResult> {
  const embeddings: EmbeddingState = deps.embeddings;
  const keyCardinality = deps.keyCardinality;

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

  // ── σ filter stages ──────────────────────────────────────────────────────────
  // Build filter predicates. When the key has a multi-key alias family, use keyIn
  // so all family members (canonical + variants) are included in a single pass.
  const sigmas = buildFilterSigmas(args, family);

  // Recency-aware ranking (on by default at alpha=0.5/90d). alpha=1 ⇒ pure rho.by,
  // byte-identical to prior behavior. `now` (asOf or Date.now) anchors both tauValid
  // (canonicalReadStages.evaluationInstant) and the recency term (ctx.evaluationClock).
  const ranker = buildRecallRanker(args, embeddings.rankFn);

  // SINGLE query execution:
  // leaf → σ(s) → canonicalReadStages (τ_valid + ⊕_dedupe + ⊥(keyAliases) + drop) → ranker
  const ranked = session.mneme.query<RankedCorpus>(
    args.corpus,
    pipe(
      leaf(args.corpus),
      ...sigmas,
      ...canonicalReadStages({
        evaluationInstant: now,
        keyCardinality,
        keyAliases: aliasMap,
        evidencePoolingRule: MCP_EVIDENCE_POOLING_RULE,
      }),
      ranker,
    ),
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

// ── keyCensus ─────────────────────────────────────────────────────────────────

export interface CensusArgs {
  corpus?: string;
  limit?: number;
  // corpus defaults at server layer
}

export interface CensusResult {
  corpus: string;
  keys: { key: string; claims: number }[];
  candidates: { a: string; b: string; score: number }[]; // sorted desc, truncated to limit
  aliases: Record<string, string>;
  unratified: string[];
  warnings: string[];
  rankFn: string;
  content: string; // composed text incl. remember-shape ratification affordance
}

/**
 * Read-only census over the corpus. Returns:
 *  - Distinct keys + per-key claim counts (non-deprecated, valid at evaluationInstant;
 *    alias-shaped claims and flag artifacts excluded).
 *  - All key pairs scored by the registered rank fn, sorted desc, truncated to limit.
 *  - Resolved alias map, un-ratified self-aliases, and warnings.
 *  - Composed content with ready-to-paste remember ratification shape.
 *
 * Census never writes and never logs to the recall-log.
 */
export async function keyCensus(
  session: Session,
  args: CensusArgs & { corpus: string },
  deps: RecallDeps,
): Promise<CensusResult> {
  const corpus = args.corpus;
  const limit = args.limit ?? 20;
  const embeddings: EmbeddingState = deps.embeddings;

  const emptyResult: CensusResult = {
    corpus,
    keys: [],
    candidates: [],
    aliases: {},
    unratified: [],
    warnings: [],
    rankFn: embeddings.rankFn,
    content: "",
  };

  // Read-only: unknown corpus → empty report, no corpus created
  if (!session.listCorpora().some((c) => c.id === corpus)) {
    return emptyResult;
  }

  const now = Date.now();

  // ── Alias loading (shared helper) ────────────────────────────────────────────
  const { aliasMap, selfAliases, warnings } = loadAliasContext(session, corpus, now, deps.keyCardinality);

  // ── Census population: read all raw claims, run canonical pipeline ────────────
  // Read all raw claims from corpus (no key/subject filter — full scan)
  const rawClaims = session.mneme.read(corpus, { corpusId: corpus });

  // Apply canonical pipeline to determine live (non-deprecated) claims at evaluationInstant.
  // canonicalReadStages: τ_valid → ⊕_dedupe → ⊥/resolveDeprecateOlder → drop deprecated+flags+aliases
  // This naturally satisfies the census population filter:
  //   - non-deprecated (resolveDeprecateOlder + drop)
  //   - valid at evaluationInstant (tauValid)
  //   - excluding isKeyAliasShaped and CONTRADICTION_FLAG_KEY (drop stage)
  const stages = canonicalReadStages({
    evaluationInstant: now,
    keyCardinality: deps.keyCardinality,
    keyAliases: aliasMap,
    evidencePoolingRule: MCP_EVIDENCE_POOLING_RULE,
  });

  // Apply pipeline stages manually over the raw corpus (no query needed, we already have rawClaims)
  // Build a minimal Corpus structure consistent with how algebra stages expect it
  let liveCorpus: AlgebraCorpus = { claims: rawClaims };
  for (const stage of stages) {
    liveCorpus = stage(liveCorpus, {} as EvalContext) as AlgebraCorpus;
  }

  // Count distinct keys
  const keyCounts = new Map<string, number>();
  for (const claim of liveCorpus.claims) {
    keyCounts.set(claim.key, (keyCounts.get(claim.key) ?? 0) + 1);
  }

  const keys = [...keyCounts.entries()].map(([key, claims]) => ({ key, claims }));

  // ── Key pair scoring ─────────────────────────────────────────────────────────
  const keyStrings = [...keyCounts.keys()];

  // Warm key strings when hybrid; degrade gracefully on failure (mirrors loadAliasContext pattern).
  let effectiveRankFn = embeddings.rankFn;
  let scorerFn = similarityFn(embeddings.rankFn);
  if (embeddings.rankFn !== "jaccard" && embeddings.adapter && embeddings.cache) {
    try {
      await warmValues(embeddings.adapter, embeddings.cache, keyStrings as unknown[], []);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`key-pair warm-up failed — scoring with jaccard fallback: ${msg}`);
      scorerFn = similarityFn("jaccard");
      effectiveRankFn = "jaccard";
    }
  }

  // Score all O(K²) pairs
  const allPairs: { a: string; b: string; score: number }[] = [];
  for (let i = 0; i < keyStrings.length; i++) {
    for (let j = i + 1; j < keyStrings.length; j++) {
      const a = keyStrings[i];
      const b = keyStrings[j];
      const score = scorerFn.scoreOne(a, b);
      allPairs.push({ a, b, score });
    }
  }

  // Sort descending by score; tiebreaker by key names for full determinism.
  allPairs.sort((x, y) => y.score - x.score || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));

  // Truncate to limit
  const candidates = allPairs.slice(0, limit);

  // ── Composed content ──────────────────────────────────────────────────────────
  const lines: string[] = [
    `## Key Census: corpus "${corpus}"`,
    "",
    `**Keys (${keys.length}):**`,
  ];

  for (const { key, claims } of keys) {
    lines.push(`- \`${key}\`: ${claims} claim${claims !== 1 ? "s" : ""}`);
  }

  if (candidates.length > 0) {
    lines.push("", `**Top key-pair candidates (${candidates.length}):**`);
    for (const { a, b, score } of candidates) {
      lines.push(`- \`${a}\` ↔ \`${b}\`: ${score.toFixed(3)}`);
    }
  }

  if (Object.keys(aliasMap).length > 0) {
    lines.push("", "**Resolved aliases:**");
    for (const [variant, canonical] of Object.entries(aliasMap)) {
      lines.push(`- \`${variant}\` → \`${canonical}\``);
    }
  }

  if (selfAliases.length > 0) {
    lines.push("", `**Un-ratified self-aliases (${selfAliases.length}):** ${selfAliases.map((s) => `\`${s}\``).join(", ")}`);
  }

  // Ratification shape: paste-ready remember calls for top candidates
  if (candidates.length > 0) {
    lines.push("", "**Ratification shape** (paste into `remember` to confirm an alias):");
    const topCandidates = candidates.slice(0, 3);
    for (const { a, b } of topCandidates) {
      lines.push(`\`remember({ subject: "key:${a}", key: "alias-of", value: "${b}", corpus: "${corpus}" })\``);
    }
  }

  const content = lines.join("\n");

  return {
    corpus,
    keys,
    candidates,
    aliases: aliasMap,
    unratified: selfAliases,
    warnings,
    rankFn: effectiveRankFn,
    content,
  };
}
