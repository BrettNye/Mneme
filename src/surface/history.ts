/**
 * history — `lineageOf`: the full non-destructive lineage of one (subject,key).
 *
 * Every COMMITTED version is returned (deprecated, merged, tau-invalid claims are never
 * dropped — they are the non-destructive ledger), each tagged with its disposition + reason
 * at `asOf` (default now) via `groupDispositions` — the same attribution recall/explain use,
 * so lineage is always consistent with what recall would serve.
 */
import type { Session } from "./types.js";
import type { Claim } from "../core/claim.js";
import { pointEstimate } from "../core/confidence.js";
import { groupDispositions, type DispositionReason, type GroupDisposition } from "./belief-change.js";
import { resolveKeyCardinality } from "./cardinality.js";
import { loadAliasContext, parseAsOf } from "./recall.js";
import { keyFamilyOf } from "../retrieval/key-alias.js";

export interface LineageEntry {
  id: string;
  value: unknown;
  confidence: number;
  valid: { from: number; to: number };
  recordedSeq: number;
  tags: string[];
  disposition: GroupDisposition;
  reason: DispositionReason;
}

export interface LineageResult {
  corpus: string;
  subject: string;
  key: string;
  asOf: number;
  entries: LineageEntry[];
  content: string;
}

/** All committed claims for (subject, key family), ordered by valid.from then recordedSeq,
 *  each tagged with its disposition+reason at `asOf`. Read-only: unknown corpus → empty
 *  result (does NOT create the corpus). Embeddings-free; honors per-corpus cardinality +
 *  key aliases via the same alias-load path recall() uses. */
export function lineageOf(
  session: Session,
  args: { corpus: string; subject: string; key: string; asOf?: string | number },
): LineageResult {
  const empty: LineageResult = { corpus: args.corpus, subject: args.subject, key: args.key, asOf: 0, entries: [], content: "" };
  if (!session.listCorpora().some((c) => c.id === args.corpus)) return empty;

  const now = parseAsOf(args.asOf) ?? Date.now();
  const keyCardinality = resolveKeyCardinality(session, args.corpus, undefined);
  const { aliasMap } = loadAliasContext(session, args.corpus, now, keyCardinality);
  const family = keyFamilyOf(args.key, aliasMap);

  const seen = new Set<string>();
  const claims: Claim[] = [];
  for (const k of family) {
    for (const c of session.mneme.read(args.corpus, { corpusId: args.corpus, subject: args.subject, key: k }) as Claim[]) {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        claims.push(c);
      }
    }
  }

  const disp = groupDispositions(claims, keyCardinality, aliasMap, now);

  const entries: LineageEntry[] = claims
    .map((c) => {
      const d = disp.get(c.id) ?? { disposition: "served" as GroupDisposition, reason: { kind: "served" as const } };
      return {
        id: c.id,
        value: c.value,
        confidence: pointEstimate(c.confidence),
        valid: { from: c.valid.from, to: c.valid.to },
        recordedSeq: c.recordedSeq,
        tags: [...c.tags],
        disposition: d.disposition,
        reason: d.reason,
      };
    })
    .sort((a, b) => a.valid.from - b.valid.from || a.recordedSeq - b.recordedSeq);

  const content = entries
    .map((e) => `- ${new Date(e.valid.from).toISOString()} [${e.disposition}] ${JSON.stringify(e.value)}`)
    .join("\n");

  return { corpus: args.corpus, subject: args.subject, key: args.key, asOf: now, entries, content };
}
