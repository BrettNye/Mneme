/**
 * reconcile.ts — the recall-before-write primitive (differentiated slice).
 *
 * Scores candidate subjects/keys against the corpus's LIVE distinct entities
 * (via distinctEntities/entityScorer from entities.ts) and assigns a
 * reuse | uncertain | new disposition per thresholds. Never mutates, never
 * force-merges — the caller decides what to do with the suggestions.
 */
import { distinctEntities, entityScorer, type EntityAxis } from "./entities.js";
import { loadAliasContext } from "./recall.js";
import type { Session, ReadDeps } from "./types.js";
import type { KeyAliasMap } from "../retrieval/key-alias.js";

export interface ReconcileArgs {
  corpus: string;
  subjects?: string[];
  keys?: string[];
  limit?: number;
  /** Score >= this → "reuse". Default 0.9 (provisional, not calibrated). */
  reuseThreshold?: number;
  /** Score <= this → "new". Default 0.5. */
  newThreshold?: number;
}

export type ReconcileDisposition = "reuse" | "uncertain" | "new";

export interface EntitySuggestion {
  existing: string;
  score: number;
}

export interface ReconcileMatch {
  candidate: string;
  suggestions: EntitySuggestion[];
  disposition: ReconcileDisposition;
}

export interface ReconcileResult {
  corpus: string;
  subjects: ReconcileMatch[];
  keys: ReconcileMatch[];
  rankFn: string;
  warnings: string[];
  content: string;
}

interface MatchAxisThresholds {
  limit: number;
  reuseAt: number;
  newAt: number;
}

/**
 * Score `candidates` against the corpus's live distinct entities on `axis`. Read-only.
 *
 * `ran` reports whether entityScorer actually executed on this axis (i.e. the axis had
 * candidates AND the corpus is known) — used by the caller to decide which axis's rankFn
 * is meaningful when reducing to a single top-level ReconcileResult.rankFn (an axis that
 * short-circuited never touched the embeddings/jaccard path, so its rankFn is a default,
 * not a fact about what ran).
 */
async function matchAxis(
  session: Session,
  args: ReconcileArgs,
  axis: EntityAxis,
  candidates: string[] | undefined,
  known: boolean,
  aliasMap: KeyAliasMap,
  now: number,
  deps: ReadDeps,
  thresholds: MatchAxisThresholds,
  warnings: string[],
): Promise<{ matches: ReconcileMatch[]; rankFn: string; ran: boolean }> {
  if (!candidates?.length) return { matches: [], rankFn: deps.embeddings.rankFn, ran: false };
  if (!known) {
    // Unknown corpus: existing is always empty, so every disposition is "new" regardless
    // of score — skip the entityScorer warm-up entirely rather than wasting embedding work.
    const matches: ReconcileMatch[] = candidates.map((candidate) => ({
      candidate, suggestions: [], disposition: "new" as const,
    }));
    return { matches, rankFn: deps.embeddings.rankFn, ran: false };
  }
  const { limit, reuseAt, newAt } = thresholds;
  const existing = distinctEntities(session, args.corpus, axis, deps, aliasMap, now).map((e) => e.value);
  const { rankFn, warnings: w, scoreOne } = await entityScorer([...candidates, ...existing], deps);
  warnings.push(...w);
  const matches: ReconcileMatch[] = candidates.map((candidate) => {
    const suggestions = existing
      .map((existingValue) => ({ existing: existingValue, score: scoreOne(candidate, existingValue) }))
      .sort((a, b) => b.score - a.score || a.existing.localeCompare(b.existing))
      .slice(0, limit);
    const top = suggestions[0]?.score ?? 0;
    const disposition: ReconcileDisposition = top >= reuseAt ? "reuse" : top <= newAt ? "new" : "uncertain";
    return { candidate, suggestions, disposition };
  });
  return { matches, rankFn, ran: true };
}

function renderContent(corpus: string, subjects: ReconcileMatch[], keys: ReconcileMatch[]): string {
  const lines: string[] = [`## Reconcile: corpus "${corpus}"`];

  const renderAxis = (label: string, matches: ReconcileMatch[]): void => {
    if (matches.length === 0) return;
    lines.push("", `**${label}:**`);
    for (const { candidate, disposition, suggestions } of matches) {
      const top = suggestions[0];
      const suffix = top ? ` — top match \`${top.existing}\` (${top.score.toFixed(3)})` : " — no existing matches";
      lines.push(`- \`${candidate}\`: ${disposition}${suffix}`);
    }
  };

  renderAxis("Subjects", subjects);
  renderAxis("Keys", keys);

  return lines.join("\n");
}

/**
 * Read-only reconciliation of candidate subjects/keys against the corpus's live
 * distinct entities. Never writes, never merges — returns scored suggestions and
 * a disposition per candidate so the caller (agent or human) decides whether to
 * reuse an existing entity or mint a new one.
 */
export async function reconcile(
  session: Session,
  args: ReconcileArgs,
  deps: ReadDeps,
): Promise<ReconcileResult> {
  const limit = args.limit ?? 5;
  const reuseAt = args.reuseThreshold ?? 0.9; // provisional, not calibrated (spec)
  const newAt = args.newThreshold ?? 0.5;
  const known = session.listCorpora().some((c) => c.id === args.corpus);
  const warnings: string[] = [];
  const now = Date.now(); // ONE instant, shared by alias load + both axis enumerations
  const aliasContext = known
    ? loadAliasContext(session, args.corpus, now, deps.keyCardinality)
    : { aliasMap: {}, selfAliases: [], warnings: [] };
  warnings.push(...aliasContext.warnings);
  const aliasMap = aliasContext.aliasMap;

  const thresholds: MatchAxisThresholds = { limit, reuseAt, newAt };
  const s = await matchAxis(session, args, "subject", args.subjects, known, aliasMap, now, deps, thresholds, warnings);
  const k = await matchAxis(session, args, "key", args.keys, known, aliasMap, now, deps, thresholds, warnings);

  if (!known) warnings.push(`corpus "${args.corpus}" does not exist — all candidates are new`);

  const content = renderContent(args.corpus, s.matches, k.matches);

  // Reduce two per-axis rankFns to one: only axes that actually ran entityScorer are
  // meaningful; a jaccard fallback on EITHER of them must be reflected, since a
  // short-circuited axis (empty candidates, or unknown corpus) never touched the
  // embeddings/jaccard path and its rankFn is just a default, not a fact about what ran.
  const ranAxes = [s, k].filter((axisResult) => axisResult.ran);
  const rankFn = ranAxes.some((axisResult) => axisResult.rankFn === "jaccard")
    ? "jaccard"
    : (ranAxes[0]?.rankFn ?? deps.embeddings.rankFn);

  return {
    corpus: args.corpus,
    subjects: s.matches,
    keys: k.matches,
    rankFn,
    warnings,
    content,
  };
}
