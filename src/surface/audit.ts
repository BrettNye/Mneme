/**
 * audit.ts — the whole-corpus detector.
 *
 * Composes `keyCensus` (alias candidates), `subjectCensus` (subject fragmentation),
 * and single-cardinality collisions (surfaced via keyCensus's cardinality-safety
 * warnings) into ONE ranked list of proposed declarations.
 *
 * Charter I3 (hard invariant): PROPOSE ONLY. `audit` never applies a proposal —
 * no alias claim, no cardinality declaration, no deprecation. It calls only the
 * read-only census ops (keyCensus/subjectCensus) and never touches session.write*
 * or session.declareCardinality.
 */
import type { Session, ReadDeps } from "./types.js";
import { keyCensus, subjectCensus } from "./census.js";

export type ProposalKind = "key-alias" | "subject-fragmentation" | "cardinality-declare";

export interface AuditProposal {
  kind: ProposalKind;
  entities: string[]; // key pair / subject pair / [subject, key]
  score?: number; // similarity for alias/fragmentation proposals
  claimsAffected: number; // ranking signal
  suggestedAction: string; // ready-to-apply action string — NEVER auto-run here
  detail: string;
}

export interface AuditResult {
  corpus: string;
  proposals: AuditProposal[]; // ranked desc by claimsAffected then score
  rankFn: string;
  warnings: string[];
  content: string; // human-readable maintenance report
}

// Matches the cardinality-safety warning composed by cardinalitySafetyWarnings
// (src/surface/cardinality.ts):
//   `single-cardinality (subject:${subject}, key:${key}) holds ${n} distinct values — ...`
const CARDINALITY_WARNING_RE =
  /^single-cardinality \(subject:([^,]+), key:([^)]+)\) holds (\d+) distinct values/;

/**
 * Read-only whole-corpus audit. Composes keyCensus + subjectCensus into a single
 * ranked list of proposed declarations. NEVER writes — the caller (agent or human)
 * confirms via the returned `suggestedAction` strings.
 */
export async function audit(
  session: Session,
  args: { corpus: string; limit?: number },
  deps: ReadDeps,
): Promise<AuditResult> {
  const corpus = args.corpus;
  const limit = args.limit;

  // Read-only: unknown corpus → empty report, no corpus created. Neither keyCensus
  // nor subjectCensus creates a corpus on an unknown id, but we short-circuit here
  // too so the emptyResult content/rankFn stay well-defined without invoking them.
  if (!session.listCorpora().some((c) => c.id === corpus)) {
    return {
      corpus,
      proposals: [],
      rankFn: deps.embeddings.rankFn,
      warnings: [],
      content: `## Audit: corpus "${corpus}"\n\nCorpus not found — no proposals.`,
    };
  }

  const [keyResult, subjectResult] = await Promise.all([
    keyCensus(session, { corpus, limit }, deps),
    subjectCensus(session, { corpus, limit }, deps),
  ]);

  const keyClaims = new Map(keyResult.keys.map((k) => [k.key, k.claims]));
  const subjectClaims = new Map(subjectResult.subjects.map((s) => [s.subject, s.claims]));

  const proposals: AuditProposal[] = [];

  // ── key-alias proposals (from keyCensus.candidates) ─────────────────────────
  for (const { a, b, score } of keyResult.candidates) {
    const claimsAffected = (keyClaims.get(a) ?? 0) + (keyClaims.get(b) ?? 0);
    proposals.push({
      kind: "key-alias",
      entities: [a, b],
      score,
      claimsAffected,
      suggestedAction: `remember({ subject: "key:${a}", key: "alias-of", value: "${b}", corpus: "${corpus}" })`,
      detail: `Keys \`${a}\` and \`${b}\` look like aliases (score ${score.toFixed(3)}).`,
    });
  }

  // ── subject-fragmentation proposals (from subjectCensus.candidates) ─────────
  for (const { a, b, score } of subjectResult.candidates) {
    const claimsAffected = (subjectClaims.get(a) ?? 0) + (subjectClaims.get(b) ?? 0);
    proposals.push({
      kind: "subject-fragmentation",
      entities: [a, b],
      score,
      claimsAffected,
      suggestedAction: `reconcile({ corpus: "${corpus}", subjects: ["${a}", "${b}"] }) // advisory — no subject-alias mechanism; reconcile at ingest time`,
      detail: `Subjects \`${a}\` and \`${b}\` may be fragmented instances of one entity (score ${score.toFixed(3)}).`,
    });
  }

  // ── cardinality-declare proposals (from keyCensus.warnings) ─────────────────
  for (const w of keyResult.warnings) {
    const m = CARDINALITY_WARNING_RE.exec(w);
    if (!m) continue;
    const [, subject, key, count] = m;
    proposals.push({
      kind: "cardinality-declare",
      entities: [subject, key],
      claimsAffected: Number(count),
      suggestedAction: `session.declareCardinality("${corpus}", { "${key}": "multi" })`,
      detail: w,
    });
  }

  proposals.sort(
    (x, y) => y.claimsAffected - x.claimsAffected || (y.score ?? 0) - (x.score ?? 0),
  );

  const warnings = [...keyResult.warnings, ...subjectResult.warnings];

  const lines: string[] = [`## Audit: corpus "${corpus}"`, "", `**Proposals (${proposals.length}):**`];
  if (proposals.length === 0) lines.push("- none");
  for (const p of proposals) {
    lines.push(`- [${p.kind}] ${p.detail} (claimsAffected=${p.claimsAffected})`);
    lines.push(`  suggestedAction: \`${p.suggestedAction}\``);
  }
  const content = lines.join("\n");

  return {
    corpus,
    proposals,
    rankFn: keyResult.rankFn,
    warnings,
    content,
  };
}
