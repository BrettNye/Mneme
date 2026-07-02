/**
 * ingest.ts — the enforced recall-before-write ingestion loop.
 *
 * PURE COMPOSITION of already-shipped primitives (reconcile, remember, keyCensus/
 * subjectCensus, audit) — no new algebra. Gathers the corpus's live canonical entities,
 * runs the caller-injected `extract` callback WITH that canon (the recall-before-write
 * edge), reconciles the candidates, auto-remaps only high-confidence ("reuse") matches
 * while routing "uncertain" matches to a ratify bucket (the over-anchoring guard), writes
 * each remapped candidate via supersession-aware `remember`, and composes `audit` for
 * propose-only maintenance suggestions.
 *
 * Per docs/superpowers/specs/2026-07-02-ingest-loop-sdk-design.md §3-§7.
 */
import type { Session, ReadDeps } from "./types.js";
import type { ReconcileDisposition, ReconcileMatch } from "./reconcile.js";
import type { SupersessionOutcome } from "./belief-change.js";
import type { AuditProposal, AuditResult } from "./audit.js";
import { reconcile } from "./reconcile.js";
import { remember } from "./remember.js";
import { keyCensus, subjectCensus } from "./census.js";
import { audit } from "./audit.js";

export interface CandidateClaim {
  subject: string;
  key: string;
  value: string;
  /** ISO-8601; explicit ⇒ deterministic supersession. Omitted ⇒ defaults to now (per remember). */
  validFrom?: string;
  confidence?: number;
  tags?: string[];
  scope?: Record<string, string>;
}

export interface IngestContext {
  corpus: string;
  /** Live distinct subjects (subjectCensus). */
  canonicalSubjects: string[];
  /** Live distinct keys (keyCensus). */
  canonicalKeys: string[];
  /** Preformatted block to drop into an LLM extractor prompt (reuse-when-same, mint-when-new). */
  canonPrompt: string;
}

export interface IngestArgs {
  corpus: string;
  /**
   * The source-shaped extraction step. Receives the corpus's LIVE canonical entities so it
   * can reuse them DURING extraction (recall-before-write). If the caller already has
   * structured candidates (no LLM), it ignores ctx and returns them.
   */
  extract: (ctx: IngestContext) => CandidateClaim[] | Promise<CandidateClaim[]>;
  /** Score >= this → auto-remap candidate to the canonical entity. Default 0.9 (reconcile's). */
  reuseThreshold?: number;
  /** Score <= this → treat as genuinely new. Default 0.5 (reconcile's). */
  newThreshold?: number;
  /** Apply cardinality-declare proposals automatically. Default false (charter I3: propose-only). */
  autoDeclareCardinality?: boolean;
  /** Extract + reconcile + plan, write NOTHING. Default false. */
  dryRun?: boolean;
}

export interface IngestedClaim {
  candidate: CandidateClaim;
  subject: { final: string; disposition: ReconcileDisposition; remappedFrom?: string };
  key: { final: string; disposition: ReconcileDisposition; remappedFrom?: string };
  /** Absent when dryRun. */
  write?: { id: string; status: string; supersession?: SupersessionOutcome };
}

export interface IngestReport {
  corpus: string;
  dryRun: boolean;
  claims: IngestedClaim[];
  counts: {
    extracted: number;
    reusedSubjects: number;
    mintedSubjects: number;
    /** Borderline entity matches (subject OR key axis) the loop refused to auto-fold. */
    uncertain: number;
    superseded: number;
    /** ⊕_dedupe absorbed / write status !== "committed". */
    duplicates: number;
    written: number;
  };
  /** cardinality-declare / key-alias / subject-fragmentation — NEVER auto-applied unless flagged. */
  proposals: AuditProposal[];
  rankFn: string;
  warnings: string[];
  content: string;
}

function buildCanonPrompt(canonicalSubjects: string[], canonicalKeys: string[]): string {
  const lines: string[] = [
    "## Canonical entities (reuse when the same entity, mint only when genuinely new)",
    "",
    `**Subjects (${canonicalSubjects.length}):**`,
  ];
  for (const s of canonicalSubjects) lines.push(`- ${s}`);
  lines.push("", `**Keys (${canonicalKeys.length}):**`);
  for (const k of canonicalKeys) lines.push(`- ${k}`);
  return lines.join("\n");
}

/** Remap a single axis (subject or key) per the over-anchoring guard: only "reuse" auto-folds. */
function remapAxis(
  raw: string,
  match: ReconcileMatch | undefined,
): { final: string; disposition: ReconcileDisposition; remappedFrom?: string } {
  const disposition = match?.disposition ?? "new";
  if (disposition === "reuse" && match) {
    const existing = match.suggestions[0].existing;
    // Only record remappedFrom when the matched existing value actually differs from the
    // raw candidate — the common case is the extractor reusing the exact canonical spelling
    // (from IngestContext), where remappedFrom === final would be misleading "X -> X" noise.
    return { final: existing, disposition, remappedFrom: existing !== raw ? raw : undefined };
  }
  // "uncertain" and "new" both mint as-is — uncertain is surfaced (via counts.uncertain /
  // the disposition itself) but NEVER auto-folded (the over-anchoring guard).
  return { final: raw, disposition };
}

function renderContent(
  corpus: string,
  dryRun: boolean,
  claims: IngestedClaim[],
  counts: IngestReport["counts"],
  auditResult: AuditResult,
): string {
  const lines: string[] = [`## Ingest: corpus "${corpus}"${dryRun ? " (dry run)" : ""}`, ""];
  lines.push(
    `**Extracted ${counts.extracted} candidate${counts.extracted !== 1 ? "s" : ""}** — ` +
      `reused ${counts.reusedSubjects} subject(s), minted ${counts.mintedSubjects}, ` +
      `${counts.uncertain} uncertain match(es), ${counts.superseded} superseded, ` +
      `${counts.duplicates} duplicate(s), ${counts.written} written.`,
  );

  if (claims.length > 0) {
    lines.push("", "**Claims:**");
    for (const c of claims) {
      const subj = c.subject.remappedFrom
        ? `\`${c.subject.remappedFrom}\` → \`${c.subject.final}\``
        : `\`${c.subject.final}\``;
      const key = c.key.remappedFrom
        ? `\`${c.key.remappedFrom}\` → \`${c.key.final}\``
        : `\`${c.key.final}\``;
      const writeSuffix = c.write
        ? ` — ${c.write.status}${c.write.supersession?.action === "superseded" ? " (superseded)" : ""}`
        : "";
      lines.push(`- subject ${subj} (${c.subject.disposition}), key ${key} (${c.key.disposition})${writeSuffix}`);
    }
  }

  lines.push("", auditResult.content);

  return lines.join("\n");
}

/**
 * The enforced recall-before-write ingestion loop. See module docstring for the
 * algorithm; §4 of the design spec for the full step-by-step.
 */
export async function ingest(session: Session, args: IngestArgs, deps: ReadDeps): Promise<IngestReport> {
  const corpus = args.corpus;
  const autoDeclareCardinality = args.autoDeclareCardinality ?? false;
  const dryRun = args.dryRun ?? false;

  // 1. Gather canon (subjectCensus/keyCensus already guard unknown corpus → empty result).
  const [subjectResult, keyResult] = await Promise.all([
    subjectCensus(session, { corpus }, deps),
    keyCensus(session, { corpus }, deps),
  ]);
  const canonicalSubjects = subjectResult.subjects.map((s) => s.subject);
  const canonicalKeys = keyResult.keys.map((k) => k.key);
  const canonPrompt = buildCanonPrompt(canonicalSubjects, canonicalKeys);
  const ctx: IngestContext = { corpus, canonicalSubjects, canonicalKeys, canonPrompt };

  // 2. Extract WITH canon — the recall-before-write edge.
  const candidates = await args.extract(ctx);

  // 3. Reconcile candidate distinct subjects/keys (reconcile itself guards unknown corpus —
  //    every disposition becomes "new" with a warning — and empty arrays return empty matches).
  const distinctSubjects = [...new Set(candidates.map((c) => c.subject))];
  const distinctKeys = [...new Set(candidates.map((c) => c.key))];
  const reconcileResult = await reconcile(
    session,
    {
      corpus,
      subjects: distinctSubjects,
      keys: distinctKeys,
      reuseThreshold: args.reuseThreshold,
      newThreshold: args.newThreshold,
    },
    deps,
  );
  const subjectByCandidate = new Map(reconcileResult.subjects.map((m) => [m.candidate, m]));
  const keyByCandidate = new Map(reconcileResult.keys.map((m) => [m.candidate, m]));

  // 4-5. Remap (over-anchoring guard) + write (unless dryRun).
  const claims: IngestedClaim[] = [];
  const counts: IngestReport["counts"] = {
    extracted: candidates.length,
    reusedSubjects: 0,
    mintedSubjects: 0,
    uncertain: 0,
    superseded: 0,
    duplicates: 0,
    written: 0,
  };

  for (const candidate of candidates) {
    const subject = remapAxis(candidate.subject, subjectByCandidate.get(candidate.subject));
    const key = remapAxis(candidate.key, keyByCandidate.get(candidate.key));

    if (subject.disposition === "reuse") counts.reusedSubjects++;
    else if (subject.disposition === "new") counts.mintedSubjects++;
    if (subject.disposition === "uncertain") counts.uncertain++;
    if (key.disposition === "uncertain") counts.uncertain++;

    const ingestedClaim: IngestedClaim = { candidate, subject, key };

    if (!dryRun) {
      const result = remember(session, {
        subject: subject.final,
        key: key.final,
        value: candidate.value,
        corpus,
        confidence: candidate.confidence,
        tags: candidate.tags,
        scope: candidate.scope,
        validFrom: candidate.validFrom,
      });
      ingestedClaim.write = { id: result.id, status: result.status, supersession: result.supersession };
      if (result.status === "committed") counts.written++;
      else counts.duplicates++;
      if (result.supersession?.action === "superseded") counts.superseded++;
    }

    claims.push(ingestedClaim);
  }

  // 6. Propose (never apply, unless autoDeclareCardinality opts in — cardinality-declare ONLY).
  const auditResult = await audit(session, { corpus }, deps);
  if (autoDeclareCardinality) {
    for (const proposal of auditResult.proposals) {
      if (proposal.kind !== "cardinality-declare") continue;
      const key = proposal.entities[1];
      session.declareCardinality(corpus, { [key]: "multi" });
    }
  }

  const warnings = [...reconcileResult.warnings, ...auditResult.warnings];
  const rankFn = reconcileResult.rankFn === "jaccard" ? "jaccard" : auditResult.rankFn;

  return {
    corpus,
    dryRun,
    claims,
    counts,
    proposals: auditResult.proposals,
    rankFn,
    warnings,
    content: renderContent(corpus, dryRun, claims, counts, auditResult),
  };
}
