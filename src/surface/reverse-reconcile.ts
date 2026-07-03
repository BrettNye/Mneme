/**
 * reverse-reconcile.ts — over-anchoring (N entities → 1 subject) detection.
 *
 * Symmetric to reconcile.ts's under-folding guard: `reconcile`/`subjectCensus`
 * protect against minting a redundant subject for an entity that already exists.
 * `reverseReconcile` protects the opposite failure — a subject that has silently
 * absorbed claims belonging to MULTIPLE distinct entities. Per
 * docs/superpowers/specs/2026-07-02-reverse-reconcile-over-anchoring-design.md §3/§5:
 *
 *   A. Subject-cohesion audit (low confidence) — cluster each subject's live claim
 *      VALUES; a subject whose values form >=2 well-separated clusters (above a
 *      claim-count floor) is flagged as a possible over-merge.
 *   B. Value-to-subject re-attribution check (medium confidence) — per claim, score
 *      its value's cohesion to its own subject's OTHER values vs every other live
 *      subject's values; if a different subject coheres more, the attribution is
 *      suspect.
 *
 * PURE COMPOSITION — reuses distinctEntities/entityScorer machinery, canonicalReadStages,
 * and the same live-set semantics as keyCensus/subjectCensus. Adds NO new algebra.
 * I3 propose-only: reverseReconcile NEVER writes; confidence is "low"/"medium" only,
 * NEVER "high" (heuristic, not an assertion).
 */
import type { Session, ReadDeps } from "./types.js";
import type { Claim } from "../core/claim.js";
import type { Corpus } from "../algebra/types.js";
import type { EvalContext } from "../algebra/expression.js";
import { filterCorpus } from "../algebra/types.js";
import { CONTRADICTION_FLAG_KEY } from "../algebra/resolution.js";
import { canonicalizeValue } from "../core/value.js";
import { canonicalReadStages } from "../retrieval/read-pipeline.js";
import { isKeyAliasShaped } from "../retrieval/key-alias.js";
import { entityScorer } from "./entities.js";
import { loadAliasContext, MCP_EVIDENCE_POOLING_RULE } from "./recall.js";
import { resolveKeyCardinality } from "./cardinality.js";

export interface OverFoldProposal {
  kind: "subject-over-merge";
  subject: string;
  /** (approach B, aggregated) a representative mis-cohering claim id. */
  claim?: string;
  /** (approach B) the subject its value coheres with more. */
  betterSubject?: string;
  /** (approach B) the max cohesion gap observed among the subject's mis-cohering claims. */
  cohesion?: number;
  /** (approach B) how many of the subject's claims cohere more with another subject. */
  affectedClaims?: number;
  confidence: "low" | "medium"; // A = low, B = medium — NEVER "high" (heuristic)
  detail: string; // hedged: "possible over-merge — review", never asserted
}

export interface ReverseReconcileResult {
  corpus: string;
  proposals: OverFoldProposal[]; // ranked: medium (B) before low (A)
  rankFn: string;
  content: string;
}

/**
 * Approach A clustering is SCORER-RELATIVE, not tied to any scorer's absolute
 * baseline. Jaccard scores genuinely-disjoint token sets ~0; cosine (and hence
 * hybrid = max(jaccard,cosine)) maps them to a ~0.5 neutral baseline (orthogonal
 * embeddings, (1+cos)/2 with cos=0) — an absolute edge threshold tuned for one
 * baseline silently no-ops under the other (union-find unions ~everything, so
 * clusters.length is always 1). Instead:
 *   1. Compute all pairwise sims for the subject's values.
 *   2. Cohesion gate: if the score RANGE (max-min) is below SEPARATION_MIN, the
 *      subject is cohesive — no meaningful separation regardless of the scorer's
 *      absolute baseline — treat as one cluster (never flag).
 *   3. Otherwise cluster with a RELATIVE edge threshold = the midpoint of the
 *      observed range. A tight intra-cluster / far inter-cluster split (e.g.
 *      jaccard ~0.6 intra / ~0 inter, OR hybrid ~0.9 intra / ~0.5 inter) crosses
 *      this midpoint either way, so both scorers split an over-merged subject.
 */
const SEPARATION_MIN = 0.1;

function valueToString(v: unknown): string {
  return typeof v === "string" ? v : canonicalizeValue(v as never);
}

/** Scorer-relative single-link (union-find) clustering — see SEPARATION_MIN doc
 *  above. Returns each connected component as an array of indices into `values`. */
function clusterValues(
  values: string[], scoreOne: (a: string, b: string) => number,
): number[][] {
  const n = values.length;
  if (n < 2) return values.map((_, i) => [i]);

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sim = scoreOne(values[i], values[j]);
      if (sim < min) min = sim;
      if (sim > max) max = sim;
    }
  }

  if (max - min < SEPARATION_MIN) return [values.map((_, i) => i)]; // cohesive: no split

  const threshold = (min + max) / 2;
  const parent = values.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a: number, b: number): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (scoreOne(values[i], values[j]) >= threshold) union(i, j);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }
  return [...groups.values()];
}

interface SubjectValue { claimId: string; subject: string; value: string }

function renderContent(corpus: string, proposals: OverFoldProposal[]): string {
  const lines: string[] = [`## Reverse Reconcile: corpus "${corpus}"`];
  if (proposals.length === 0) {
    lines.push("", "No over-fold signals detected.");
    return lines.join("\n");
  }
  lines.push("", `**Possible over-merges (${proposals.length}):**`);
  for (const p of proposals) {
    const suffix = p.claim
      ? ` (claim \`${p.claim}\`${p.betterSubject ? ` → \`${p.betterSubject}\`` : ""})`
      : "";
    lines.push(`- \`${p.subject}\` [${p.confidence}]${suffix}: ${p.detail}`);
  }
  return lines.join("\n");
}

/**
 * Read-only over-fold detector. Never writes, never creates a corpus, never
 * asserts — surfaces propose-only `OverFoldProposal[]` for human review.
 */
export async function reverseReconcile(
  session: Session, args: { corpus: string; minClaims?: number }, deps: ReadDeps,
): Promise<ReverseReconcileResult> {
  const corpus = args.corpus;
  const minClaims = args.minClaims ?? 3;
  const emptyResult: ReverseReconcileResult = {
    corpus, proposals: [], rankFn: deps.embeddings.rankFn, content: renderContent(corpus, []),
  };

  // Read-only: unknown corpus → empty report, no corpus created (I3-adjacent honesty).
  if (!session.listCorpora().some((c) => c.id === corpus)) return emptyResult;

  const now = Date.now();
  const effective = resolveKeyCardinality(session, corpus, deps.keyCardinality);
  const { aliasMap } = loadAliasContext(session, corpus, now, effective);

  // Deliberately stop BEFORE ⊥/resolveDeprecateOlder (canon stage 3): under the default
  // single-cardinality key, ⊥ is exactly the mechanism that would mass-deprecate all but
  // the latest of an over-merged subject's distinct values — collapsing the very signal
  // this detector exists to surface. Apply only τ_valid + ⊕_dedupe (mirrors the
  // "preContra" pattern behind cardinalitySafetyWarnings in recall.ts/census.ts), then the
  // same non-⊥ drop filter (deprecated / contradiction-flag / alias-shaped infrastructure).
  const raw: Corpus = { claims: session.mneme.read(corpus, { corpusId: corpus }) as Claim[] };
  const [tauValidStage, dedupeStage] = canonicalReadStages({
    evaluationInstant: now, keyCardinality: effective,
    keyAliases: aliasMap, evidencePoolingRule: MCP_EVIDENCE_POOLING_RULE,
  });
  const deduped = dedupeStage(tauValidStage(raw, {} as EvalContext) as Corpus, {} as EvalContext) as Corpus;
  const live: Corpus = filterCorpus(
    deduped,
    (cl) => cl.status !== "deprecated" && cl.key !== CONTRADICTION_FLAG_KEY && !isKeyAliasShaped(cl),
  );

  if (live.claims.length === 0) return emptyResult;

  const items: SubjectValue[] = live.claims.map((c) => ({
    claimId: c.id, subject: c.subject, value: valueToString(c.value),
  }));

  const { rankFn, scoreOne } = await entityScorer(items.map((i) => i.value), deps);

  const bySubject = new Map<string, SubjectValue[]>();
  for (const item of items) {
    if (!bySubject.has(item.subject)) bySubject.set(item.subject, []);
    bySubject.get(item.subject)!.push(item);
  }

  // ── Approach A (low): per-subject value clustering ─────────────────────────
  // Requires >=2 SUBSTANTIAL clusters (each with >=2 members) — a split like [2,1]
  // is one real group plus a lone outlier, not an over-merge, and must NOT fire.
  const lowProposals: OverFoldProposal[] = [];
  for (const [subject, subjectItems] of bySubject) {
    if (subjectItems.length < minClaims) continue;
    const clusters = clusterValues(subjectItems.map((i) => i.value), scoreOne);
    const substantialClusters = clusters.filter((c) => c.length >= 2);
    if (substantialClusters.length >= 2) {
      lowProposals.push({
        kind: "subject-over-merge",
        subject,
        confidence: "low",
        detail:
          `subject "${subject}" holds ${substantialClusters.length} well-separated value clusters ` +
          `(each with >=2 claims, of ${clusters.length} total) across ${subjectItems.length} claims — ` +
          `possible over-merge — review`,
      });
    }
  }

  // ── Approach B (medium): per-subject aggregated value→subject re-attribution
  // check. Per-claim mis-cohering findings are collected, then rolled into AT
  // MOST ONE proposal per subject — a 13-mis-cohering-claim over-merge should
  // read as one signal, not 13 (incl. redundant bidirectional pairs), which is
  // naturally avoided once each subject only ever emits its own proposal.
  const mediumProposals: OverFoldProposal[] = [];
  for (const [subject, subjectItems] of bySubject) {
    if (subjectItems.length < 2) continue; // no own-subject cohesion baseline without a sibling

    interface MisCohering { claimId: string; betterSubject: string; gap: number }
    const misCohering: MisCohering[] = [];
    for (const item of subjectItems) {
      const ownOthers = subjectItems.filter((o) => o.claimId !== item.claimId).map((o) => o.value);
      const ownCohesion = ownOthers.length > 0
        ? ownOthers.reduce((best, v) => Math.max(best, scoreOne(item.value, v)), -Infinity)
        : 0;

      let bestOtherSubject: string | undefined;
      let bestOtherCohesion = -Infinity;
      for (const [otherSubject, otherItems] of bySubject) {
        if (otherSubject === subject) continue;
        const cohesion = otherItems.reduce((best, o) => Math.max(best, scoreOne(item.value, o.value)), -Infinity);
        if (cohesion > bestOtherCohesion) {
          bestOtherCohesion = cohesion;
          bestOtherSubject = otherSubject;
        }
      }

      if (bestOtherSubject !== undefined && bestOtherCohesion > ownCohesion) {
        misCohering.push({
          claimId: item.claimId, betterSubject: bestOtherSubject, gap: bestOtherCohesion - ownCohesion,
        });
      }
    }

    if (misCohering.length === 0) continue;

    // Mode: most common betterSubject among mis-cohering claims; tie-break by
    // the highest single gap within the tied groups.
    const counts = new Map<string, number>();
    const maxGapBySubject = new Map<string, number>();
    for (const m of misCohering) {
      counts.set(m.betterSubject, (counts.get(m.betterSubject) ?? 0) + 1);
      maxGapBySubject.set(m.betterSubject, Math.max(maxGapBySubject.get(m.betterSubject) ?? -Infinity, m.gap));
    }
    let modeSubject = misCohering[0].betterSubject;
    let modeCount = -Infinity;
    let modeGap = -Infinity;
    for (const [otherSubject, count] of counts) {
      const gap = maxGapBySubject.get(otherSubject)!;
      if (count > modeCount || (count === modeCount && gap > modeGap)) {
        modeSubject = otherSubject;
        modeCount = count;
        modeGap = gap;
      }
    }

    const representative = misCohering
      .filter((m) => m.betterSubject === modeSubject)
      .reduce((best, m) => (m.gap > best.gap ? m : best));
    const maxGapOverall = misCohering.reduce((best, m) => Math.max(best, m.gap), -Infinity);

    mediumProposals.push({
      kind: "subject-over-merge",
      subject,
      claim: representative.claimId,
      betterSubject: modeSubject,
      cohesion: maxGapOverall,
      affectedClaims: misCohering.length,
      confidence: "medium",
      detail:
        `${misCohering.length} of ${subjectItems.length} claims cohere more with other subjects ` +
        `(e.g. \`${modeSubject}\`) — possible over-merge — review`,
    });
  }

  const proposals = [...mediumProposals, ...lowProposals];

  return { corpus, proposals, rankFn, content: renderContent(corpus, proposals) };
}
