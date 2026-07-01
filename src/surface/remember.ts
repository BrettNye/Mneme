import type { Session } from "./types.js";

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
   * When omitted: valid from Date.now() — facts are valid from when stated, so a
   * later no-validFrom write on the same subject/key supersedes an earlier one
   * (last-write-wins under resolveDeprecateOlder) instead of tying at from=0.
   * Backdating stays explicit: pass validFrom to place the interval in the past.
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
    // Default valid.from to "now": conversational facts are valid from when
    // stated. Leaving this undefined would fall through to the surface default
    // { from: 0 }, making two no-validFrom writes on the same subject/key TIE
    // under resolveDeprecateOlder instead of last-write-wins.
    valid: { from: validFrom ?? Date.now(), to: Infinity },
  });
  return { id: out.id, status: out.status, corpus: args.corpus };
}

export interface ListResult {
  corpora: { id: string; displayName: string }[];
}
export function listCorpora(session: Session): ListResult {
  return { corpora: session.listCorpora() };
}
