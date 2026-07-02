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

/** Score `candidates` against the corpus's live distinct entities on `axis`. Read-only. */
async function matchAxis(
  session: Session,
  args: ReconcileArgs,
  axis: EntityAxis,
  candidates: string[] | undefined,
  known: boolean,
  aliasMap: import("../retrieval/key-alias.js").KeyAliasMap,
  now: number,
  deps: ReadDeps,
  limit: number,
  reuseAt: number,
  newAt: number,
  warnings: string[],
): Promise<{ matches: ReconcileMatch[]; rankFn: string }> {
  if (!candidates?.length) return { matches: [], rankFn: deps.embeddings.rankFn };
  const existing = known
    ? distinctEntities(session, args.corpus, axis, deps, aliasMap, now).map((e) => e.value)
    : [];
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
  return { matches, rankFn };
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
  const aliasMap = known ? loadAliasContext(session, args.corpus, now, deps.keyCardinality).aliasMap : {};

  const s = await matchAxis(session, args, "subject", args.subjects, known, aliasMap, now, deps, limit, reuseAt, newAt, warnings);
  const k = await matchAxis(session, args, "key", args.keys, known, aliasMap, now, deps, limit, reuseAt, newAt, warnings);

  if (!known) warnings.push(`corpus "${args.corpus}" does not exist — all candidates are new`);

  const content = renderContent(args.corpus, s.matches, k.matches);

  return {
    corpus: args.corpus,
    subjects: s.matches,
    keys: k.matches,
    rankFn: s.rankFn,
    warnings,
    content,
  };
}
