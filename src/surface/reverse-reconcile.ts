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
/**
 * HEURISTIC, pending empirical calibration against labeled over-merge data (which
 * we do not yet have). Controls the cohesion gate in `clusterValues`: below this
 * pairwise-score RANGE, a subject is treated as cohesive (never split) regardless
 * of the scorer's absolute baseline — see the `clusterValues` doc above for why a
 * relative gate is required. 0.1 was chosen as a conservative "clearly separated"
 * floor (comfortably above scorer noise, comfortably below the ~0.5-0.6+ ranges
 * genuine two-entity subjects exhibit in the worked examples above) — not derived
 * from labeled data. Exposed as `separationMin` on args so a consumer can tune it
 * per-corpus once real signal is available.
 */
const SEPARATION_MIN = 0.1;

/**
 * HEURISTIC, pending empirical calibration against labeled over-merge data (which
 * we do not yet have). Controls the "substantial cluster" floor in Approach A: a
 * value cluster must have at least this many members to count toward the ">=2
 * well-separated clusters" over-merge signal. 2 was chosen so a single outlier
 * claim (a [N,1] split) never on its own triggers a flag — one real group plus a
 * lone claim is far more likely to be a stray/mistagged claim than a second
 * distinct entity; Approach B's per-claim re-attribution check is the backstop
 * for that case. Not derived from labeled data.
 */
const MIN_CLUSTER_MEMBERS = 2;

/**
 * HEURISTIC, pending empirical calibration against labeled over-merge data (which
 * we do not yet have). Controls the coherent-core gate in Approach B: a subject
 * only qualifies as a grab-bag (over-merge) when its mis-cohering claims are a
 * STRICT MINORITY of its live claims — i.e. the subject retains a MAJORITY
 * coherent core of its own. Real-data finding (2026-07): a subject with 6 of 7
 * (86%) claims mis-cohering with a bigger subject is effectively a FOLD-IN (the
 * subject mostly belongs to the bigger one), not an over-merge — the earlier "<
 * ALL" rule was too weak and flagged it anyway. 0.5 was chosen as the natural
 * majority/minority split: a subject exactly half or more mis-cohering is
 * suppressed as a fold-in candidate (reconcile/subjectCensus's job, the opposite
 * direction), leaving Approach B to fire only on "an otherwise-coherent subject
 * with SOME leaked foreign claims." Not derived from labeled data.
 */
const MAX_MISCOHERE_FRACTION = 0.5;

function valueToString(v: unknown): string {
  return typeof v === "string" ? v : canonicalizeValue(v as never);
}

/** Scorer-relative single-link (union-find) clustering — see SEPARATION_MIN doc
 *  above. Returns each connected component as an array of indices into `values`. */
function clusterValues(
  values: string[], scoreOne: (a: string, b: string) => number, separationMin: number,
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

  if (max - min < separationMin) return [values.map((_, i) => i)]; // cohesive: no split

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
  session: Session,
  args: { corpus: string; minClaims?: number; separationMin?: number },
  deps: ReadDeps,
): Promise<ReverseReconcileResult> {
  const corpus = args.corpus;
  const minClaims = args.minClaims ?? 3;
  const separationMin = args.separationMin ?? SEPARATION_MIN;
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
  // Requires >=2 SUBSTANTIAL clusters (each with >=2 members) — this gate suppresses
  // ANY split with a singleton side ([2,1], [3,1], [5,1], …), not just [2,1]: one
  // real group plus a lone outlier is not an over-merge, and must NOT fire. Accepted
  // trade-off: a genuine second entity that happens to appear as a lone claim is
  // missed by design — Approach B's per-claim re-attribution check is the backstop.
  const lowProposals: OverFoldProposal[] = [];
  for (const [subject, subjectItems] of bySubject) {
    if (subjectItems.length < minClaims) continue;
    const clusters = clusterValues(subjectItems.map((i) => i.value), scoreOne, separationMin);
    const substantialClusters = clusters.filter((c) => c.length >= MIN_CLUSTER_MEMBERS);
    if (substantialClusters.length >= 2) {
      lowProposals.push({
        kind: "subject-over-merge",
        subject,
        confidence: "low",
        detail:
          `subject "${subject}" holds ${substantialClusters.length} well-separated value clusters ` +
          `(each with >=${MIN_CLUSTER_MEMBERS} claims, of ${clusters.length} total) across ${subjectItems.length} claims — ` +
          `possible over-merge — review`,
      });
    }
  }

  // ── Approach B (medium): per-subject aggregated value→subject re-attribution
  // check. Per-claim mis-cohering findings are collected, then rolled into AT
  // MOST ONE proposal per subject — a 13-mis-cohering-claim over-merge should
  // read as one signal, not 13 (incl. redundant bidirectional pairs), which is
  // naturally avoided once each subject only ever emits its own proposal.
  //
  // DIRECTION-AWARE (Change 1): reverseReconcile detects OVER-MERGE (a subject
  // that has absorbed foreign claims but still has its own coherent core), NOT
  // FOLD-IN (a subject mostly/entirely absorbed by one other subject — that's a
  // `reconcile`/`subjectCensus` concern, the opposite direction). A subject whose
  // mis-cohering claims are a MAJORITY (up to and including ALL) has no majority
  // core of its own: emitting an over-merge proposal for it would tell a reviewer
  // to "split" a subject that should instead be folded INTO the other one. So a
  // subject only qualifies as a grab-bag when it is (a) not tiny (>=minClaims)
  // and (b) retains a MAJORITY core — misCohering.length is a strict MINORITY of
  // its own live claim count, per MAX_MISCOHERE_FRACTION above — see gates below.
  const mediumProposals: OverFoldProposal[] = [];
  for (const [subject, subjectItems] of bySubject) {
    if (subjectItems.length < 2) continue; // no own-subject cohesion baseline without a sibling
    if (subjectItems.length < minClaims) continue; // too small — possible fold-in target, not an over-merge

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
    // No MAJORITY core of its own — mis-cohering claims are half or more of the
    // subject's live claims: fold-in candidate, not an over-merge. Suppress
    // regardless of subject size (see MAX_MISCOHERE_FRACTION doc above).
    if (misCohering.length >= subjectItems.length * MAX_MISCOHERE_FRACTION) continue;

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

    mediumProposals.push({
      kind: "subject-over-merge",
      subject,
      claim: representative.claimId,
      betterSubject: modeSubject,
      // cohesion describes modeSubject's OWN evidence (its max gap), not the max gap
      // across ALL mis-cohering claims — when votes split across MULTIPLE other
      // subjects, a different subject's larger gap must never be reported under
      // modeSubject's name.
      cohesion: modeGap,
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
