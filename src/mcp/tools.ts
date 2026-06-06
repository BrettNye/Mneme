/**
 * Mneme MCP tool handlers — pure functions over a `Session`, independent of the
 * MCP SDK so they are unit-testable. `recall` deliberately runs the algebra
 * (σ filter → canonicalReadStages → ρ similarity-rank → κ compose) and surfaces
 * confidence + topScore + abstained, because that composable, principled retrieval
 * is the thing dogfooding is meant to test.
 *
 * Tools stay PURE over the Session: NO fs side effects (no recall-log import — the
 * server appends the log). recall is async so it can await warm-up when hybrid
 * embeddings are active.
 */
import type { Predicate, RankedCorpus } from "../index.js";
import { pipe, leaf, sigma, rho, kappa } from "../surface/index.js";
import { kappa as kappaOp } from "../algebra/composition.js";
import type { Session } from "../surface/index.js";
import { pointEstimate } from "../surface/index.js";
import { canonicalReadStages } from "../retrieval/read-pipeline.js";
import { abstainBelowTop, relevanceFloor } from "../algebra/similarity.js";
import { warmValues } from "../algebra/embedding.js";
import type { EmbeddingState } from "./embeddings.js";

export interface RecallDeps {
  embeddings: EmbeddingState;
  keyCardinality?: Record<string, "single" | "multi">;
  // NOTE: arrives PRE-LOADED from the server; tools never import config.ts or MCP internals.
}

/** Create the corpus if it doesn't already exist (idempotent). */
export function ensureCorpus(session: Session, corpusId: string): void {
  if (!session.listCorpora().some((c) => c.id === corpusId)) {
    session.createCorpus({
      id: corpusId,
      scopeFields: { project: "string", person: "string", context: "string" },
    });
  }
}

export interface RememberArgs {
  subject: string;
  key: string;
  value: string;
  corpus: string;
  confidence?: number;
  tags?: string[];
  /** Optional scope fields for this claim, e.g. { project: "mneme" }. */
  scope?: Record<string, string>;
  /**
   * Optional ISO-8601 date-time string for the start of the validity interval.
   * e.g. "2026-01-01T00:00:00Z". Invalid ISO → throws a descriptive Error.
   * When omitted: valid from epoch 0 (always valid).
   */
  validFrom?: string;
}
export interface RememberResult {
  id: string;
  status: string;
  corpus: string;
}

export function remember(session: Session, args: RememberArgs): RememberResult {
  ensureCorpus(session, args.corpus);

  let validFrom: number | undefined;
  if (args.validFrom !== undefined) {
    const t = Date.parse(args.validFrom);
    if (!Number.isFinite(t)) {
      throw new Error(
        `remember: validFrom "${args.validFrom}" is not a valid ISO-8601 date string`,
      );
    }
    validFrom = t;
  }

  const out = session.write(args.corpus, {
    subject: args.subject,
    key: args.key,
    value: args.value,
    confidence: args.confidence,
    tags: args.tags,
    scope: args.scope,
    valid: validFrom !== undefined
      ? { from: validFrom, to: Infinity }
      : undefined,
  });
  return { id: out.id, status: out.status, corpus: args.corpus };
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
}
export interface RecallMatch {
  subject: string;
  key: string;
  value: unknown;
  confidence: number;
  score: number;
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
}

export async function recall(
  session: Session,
  args: RecallArgs,
  deps: RecallDeps | EmbeddingState,
): Promise<RecallResult> {
  // Normalise: accept either RecallDeps (with .embeddings) or a bare EmbeddingState.
  const embeddings: EmbeddingState = "rankFn" in deps ? deps : (deps as RecallDeps).embeddings;
  const keyCardinality = "keyCardinality" in deps ? (deps as RecallDeps).keyCardinality : undefined;

  const maxTokens = args.maxTokens ?? 2000;
  const limit = args.limit ?? 5;
  const emptyResult: RecallResult = {
    corpus: args.corpus,
    content: "",
    matches: [],
    abstained: false,
    rankFn: embeddings.rankFn,
  };

  // Read-only: a recall against an unknown corpus returns empty — it MUST NOT create the
  // corpus (so the tool can honestly advertise readOnlyHint). remember() still ensures-on-write.
  if (!session.listCorpora().some((c) => c.id === args.corpus)) {
    return emptyResult;
  }

  // If hybrid embeddings active: warm all claim values + the query before the single query.
  if (embeddings.rankFn !== "jaccard" && embeddings.adapter && embeddings.cache) {
    // Read claim values for warm-up via mneme.read (leaf-only, no filters).
    const rawClaims = session.mneme.read(args.corpus, { corpusId: args.corpus });
    const claimValues = rawClaims.map((c) => c.value);
    await warmValues(embeddings.adapter, embeddings.cache, claimValues, [args.about]);
  }

  // Build filter stages (σ).
  const filters: Predicate[] = [];
  if (args.subject) filters.push({ op: "subjectEq", value: args.subject });
  if (args.key) filters.push({ op: "keyEq", value: args.key });
  const sigmas = filters.map((p) => sigma(p));

  // SINGLE query execution:
  // leaf → σ(s) → canonicalReadStages (τ_valid + ⊕_dedupe + ⊥ + drop) → ρ.by(rankFn, query)
  const now = Date.now();
  const ranked = session.mneme.query<RankedCorpus>(
    args.corpus,
    pipe(
      leaf(args.corpus),
      ...sigmas,
      ...canonicalReadStages({ evaluationInstant: now, keyCardinality }),
      rho.by(embeddings.rankFn, args.about),
    ),
    { evaluationClock: now },
  );

  // topScore: pre-knob, extracted immediately after canonical resolution + ranking.
  const topScore = ranked.scored[0]?.score;

  // In-memory knobs (pure RankedCorpus fns — NO second query):
  const abstainThreshold = args.abstainBelowTop ?? 0;
  const floorThreshold = args.relevanceFloor ?? 0;

  const afterAbstain = abstainBelowTop(abstainThreshold)(ranked);
  // abstained = abstain stage emptied a non-empty ranked corpus
  const abstained =
    ranked.scored.length > 0 && afterAbstain.scored.length === 0 && abstainThreshold > 0;

  const afterFloor = relevanceFloor(floorThreshold)(afterAbstain);
  const knobbed = afterFloor;

  const matches: RecallMatch[] = knobbed.scored.slice(0, limit).map((s) => ({
    subject: s.claim.subject,
    key: s.claim.key,
    value: s.claim.value,
    confidence: pointEstimate(s.claim.confidence),
    score: s.score,
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
  };
}

export interface ListResult {
  corpora: { id: string; displayName: string }[];
}
export function listCorpora(session: Session): ListResult {
  return { corpora: session.listCorpora() };
}
