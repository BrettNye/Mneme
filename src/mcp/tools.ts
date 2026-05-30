/**
 * Mneme MCP tool handlers — pure functions over a `Session`, independent of the
 * MCP SDK so they are unit-testable. `recall` deliberately runs the algebra
 * (σ filter → ρ similarity-rank → κ compose) and surfaces confidence, because
 * that composable, principled retrieval is the thing dogfooding is meant to test.
 */
import { pipe, leaf, sigma, rho, kappa } from "../index.js";
import type { Predicate, RankedCorpus, ComposedContext } from "../index.js";
import { pointEstimate } from "../core/confidence.js";
import type { Session } from "../surface/index.js";

/** Create the corpus if it doesn't already exist (idempotent). */
export function ensureCorpus(session: Session, corpusId: string): void {
  if (!session.listCorpora().some((c) => c.id === corpusId)) {
    session.createCorpus({ id: corpusId, subjects: [] });
  }
}

export interface RememberArgs {
  subject: string;
  key: string;
  value: string;
  corpus: string;
  confidence?: number;
  tags?: string[];
}
export interface RememberResult {
  id: string;
  status: string;
  corpus: string;
}

export function remember(session: Session, args: RememberArgs): RememberResult {
  ensureCorpus(session, args.corpus);
  const out = session.write(args.corpus, {
    subject: args.subject,
    key: args.key,
    value: args.value,
    confidence: args.confidence,
    tags: args.tags,
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
}

export function recall(session: Session, args: RecallArgs): RecallResult {
  ensureCorpus(session, args.corpus);
  const maxTokens = args.maxTokens ?? 2000;
  const limit = args.limit ?? 5;

  const filters: Predicate[] = [];
  if (args.subject) filters.push({ op: "subjectEq", value: args.subject });
  if (args.key) filters.push({ op: "keyEq", value: args.key });
  const sigmas = filters.map((p) => sigma(p));

  // σ → ρ : filter, then similarity-rank against the query.
  const ranked = session.mneme.query<RankedCorpus>(
    args.corpus,
    pipe(leaf(args.corpus), ...sigmas, rho.jaccard(args.about)),
  );
  const matches: RecallMatch[] = ranked.scored.slice(0, limit).map((s) => ({
    subject: s.claim.subject,
    key: s.claim.key,
    value: s.claim.value,
    confidence: pointEstimate(s.claim.confidence),
    score: s.score,
  }));

  // σ → ρ → κ : compose the ranked claims into a token-bounded context.
  const composed = session.mneme.query<ComposedContext>(
    args.corpus,
    pipe(leaf(args.corpus), ...sigmas, rho.jaccard(args.about), kappa.markdown(maxTokens)),
  );

  return { corpus: args.corpus, content: composed.content, matches };
}

export interface ListResult {
  corpora: { id: string; displayName: string }[];
}
export function listCorpora(session: Session): ListResult {
  return { corpora: session.listCorpora() };
}
