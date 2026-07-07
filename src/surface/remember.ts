import type { Session, CorpusSpec } from "./types.js";
import { corpusDefFromSpec, SURFACE_DEFAULTS } from "./types.js";
import {
  supersessionOutcome,
  supersessionOutcomeAsync,
  type SupersessionOutcome,
} from "./belief-change.js";
import { buildCandidateClaim } from "./candidate.js";
import type { CandidateClaim, CorpusDef, Source } from "../index.js";
import type { RecallSource } from "./recall.js";
import type { Claim } from "../core/claim.js";
import type { ClaimId } from "../core/ids.js";

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
  /** What this write did to the belief state (best-effort; never throws). */
  supersession?: SupersessionOutcome;
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
  let supersession: SupersessionOutcome | undefined;
  if (out.status === "committed") {
    try {
      supersession = supersessionOutcome(session, args.corpus, out.id);
    } catch {
      // best-effort: never fail the write on attribution errors
    }
  }
  return { id: out.id, status: out.status, corpus: args.corpus, supersession };
}

// ── Async twins (task-remember-async) ────────────────────────────────────────

/**
 * Async twin of `ensureCorpus` — sync-returning, first-declaration-wins (B12): if the
 * corpus already exists, return immediately and IGNORE `spec` entirely (Catalog.createCorpus
 * would otherwise overwrite the existing def; the exists-check IS the guard). Defaults mirror
 * sync `ensureCorpus`'s scopeFields ({ project, person, context }).
 *
 * Caveat: there is no sidecar tracking "did I already declare this corpus in this process" —
 * the guard is purely `listCorpora().some(...)`, so a caller that re-declares a corpus at every
 * boot with a DIFFERENT spec will silently keep the FIRST-ever-persisted def forever.
 */
export function ensureCorpusAsync(
  mneme: {
    createCorpus(def: CorpusDef): CorpusDef;
    listCorpora(filter?: (c: { id: string }) => boolean): { id: string }[];
  },
  corpusId: string,
  spec?: Omit<CorpusSpec, "id">,
): void {
  if (mneme.listCorpora().some((c) => c.id === corpusId)) return; // first-declaration-wins (B12)
  // Strip explicit-undefined spec entries BEFORE spreading (same bug class as spec audit
  // 2.5): `{ scopeFields: undefined }` would clobber the defaults with undefined.
  const cleanSpec = Object.fromEntries(
    Object.entries(spec ?? {}).filter(([, v]) => v !== undefined),
  );
  mneme.createCorpus(
    corpusDefFromSpec({
      id: corpusId,
      scopeFields: { project: "string", person: "string", context: "string" },
      ...cleanSpec,
    }),
  );
}

export interface RememberAsyncOptions {
  writer?: string;
  profile?: string;
  workspace?: string;
  source?: Source;
}

/** The structural seam rememberAsync needs — AsyncMneme satisfies it. Includes readByIds
 *  because the attribution step (supersessionOutcomeAsync) requires it. */
export type AsyncRememberSource = RecallSource & {
  createCorpus(def: CorpusDef): CorpusDef;
  commit(
    corpusId: string,
    candidate: CandidateClaim,
    opts: { writer: string; idempotencyKey?: string },
  ): Promise<{ id: string; status: string }>;
  readByIds(corpusId: string, ids: ClaimId[]): Promise<Claim[]> | Claim[];
};

/**
 * Async twin of `remember` — mirrors the sync body exactly (spec §3.3): ensure → validFrom
 * parse (same error text) → buildCandidateClaim with schemaVersion per the B5 rule
 * (`def.schema.version ?? SURFACE_DEFAULTS.schemaVersion`, read from `listCorpora`) →
 * `await mneme.commit(...)` → attribution gated on `status === "committed"` (B6), best-effort
 * never-throws.
 */
export async function rememberAsync(
  mneme: AsyncRememberSource,
  args: RememberArgs,
  opts: RememberAsyncOptions = {},
): Promise<RememberResult> {
  ensureCorpusAsync(mneme, args.corpus);

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

  // B5: schemaVersion resolved from the corpus def, mirroring buildCandidate in test-support.ts
  // and session.ts's write() path — never re-derived by buildCandidateClaim itself.
  const def = mneme.listCorpora((c) => c.id === args.corpus)[0] as
    | { schema?: { version?: string } }
    | undefined;
  const schemaVersion = def?.schema?.version ?? SURFACE_DEFAULTS.schemaVersion;

  const candidate = buildCandidateClaim(
    {
      subject: args.subject,
      key: args.key,
      value: args.value,
      confidence: args.confidence,
      tags: args.tags,
      scope: args.scope,
      valid: { from: validFrom ?? Date.now(), to: Infinity },
    },
    {
      corpusId: args.corpus,
      schemaVersion,
      profile: opts.profile,
      workspace: opts.workspace,
      source: opts.source,
    },
  );

  const out = await mneme.commit(args.corpus, candidate, {
    writer: opts.writer ?? SURFACE_DEFAULTS.writer,
  });

  let supersession: SupersessionOutcome | undefined;
  if (out.status === "committed") {
    try {
      supersession = await supersessionOutcomeAsync(mneme, args.corpus, out.id);
    } catch {
      // best-effort: never fail the write on attribution errors
    }
  }
  return { id: out.id, status: out.status, corpus: args.corpus, supersession };
}

export interface ListResult {
  corpora: { id: string; displayName: string }[];
}
export function listCorpora(session: Session): ListResult {
  return { corpora: session.listCorpora() };
}
