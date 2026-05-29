import type { Corpus } from "./types.js";
import { corpusOf } from "./types.js";
import { evaluate } from "./expression.js";
import type { Stage } from "./expression.js";
import type { Claim } from "../core/claim.js";
import type { EvidenceRef } from "../core/evidence.js";

/**
 * §4.11 join ⋈_r : Corpus × Corpus → Corpus.
 *
 * A join under relation r does NOT fabricate combined claims. It collects the
 * claims from BOTH inputs that participate in the relation (i.e. each claim that
 * has at least one partner on the other side under r), de-duplicated by claim id.
 *
 * Order is stable: left participants first (in their corpus order), then right
 * participants not already included.
 */
function joinBy(
  left: Corpus,
  right: Corpus,
  related: (l: Claim, r: Claim) => boolean,
): Corpus {
  const lefts = left.claims as readonly Claim[];
  const rights = right.claims as readonly Claim[];

  const leftMatched: Claim[] = [];
  const rightMatched: Claim[] = [];

  for (const l of lefts) {
    if (rights.some((r) => related(l, r))) leftMatched.push(l);
  }
  for (const r of rights) {
    if (lefts.some((l) => related(l, r))) rightMatched.push(r);
  }

  // De-duplicate by claim id; left participants win order, then unseen rights.
  const seen = new Set<string>();
  const out: Claim[] = [];
  for (const cl of [...leftMatched, ...rightMatched]) {
    const id = cl.id as unknown as string;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(cl);
  }
  return corpusOf(out);
}

/** ⋈_scope: claims about the same scope-entity (join on scope.entityId, both defined). */
export function joinScope(left: Corpus, right: Corpus): Corpus {
  return joinBy(left, right, (l, r) => {
    const le = l.scope.entityId;
    const re = r.scope.entityId;
    return le !== undefined && re !== undefined && le === re;
  });
}

/** ⋈_subject: claims about the same subject. */
export function joinSubject(left: Corpus, right: Corpus): Corpus {
  return joinBy(left, right, (l, r) => l.subject === r.subject);
}

/**
 * ⋈_evidence: claims linked through evidence references — either claim references
 * the other via a ClaimRef, OR they share any evidence ref (compared by JSON).
 */
export function joinEvidence(left: Corpus, right: Corpus): Corpus {
  return joinBy(left, right, (l, r) => evidenceLinked(l, r));
}

function evidenceLinked(l: Claim, r: Claim): boolean {
  // Direct ClaimRef in either direction.
  if (referencesClaim(l.evidence, r.id as unknown as string)) return true;
  if (referencesClaim(r.evidence, l.id as unknown as string)) return true;

  // Shared evidence ref (structural equality via JSON of the ref).
  const rRefs = new Set(r.evidence.map((e) => JSON.stringify(e)));
  return l.evidence.some((e) => rRefs.has(JSON.stringify(e)));
}

function referencesClaim(refs: readonly EvidenceRef[], targetId: string): boolean {
  return refs.some(
    (e) => e.kind === "claim" && (e.claimId as unknown as string) === targetId,
  );
}

// ---------------------------------------------------------------------------
// Stage builders — evaluate a right sub-pipeline, then join against it.
// ---------------------------------------------------------------------------

/** Stage form of ⋈_scope: joins the incoming corpus against an evaluated right pipeline. */
export function joinScopeWith(right: Stage<any, any>[]): Stage<Corpus, Corpus> {
  return (c, ctx) => joinScope(c, evaluate<Corpus>(right, ctx));
}

/** Stage form of ⋈_subject. */
export function joinSubjectWith(right: Stage<any, any>[]): Stage<Corpus, Corpus> {
  return (c, ctx) => joinSubject(c, evaluate<Corpus>(right, ctx));
}

/** Stage form of ⋈_evidence. */
export function joinEvidenceWith(right: Stage<any, any>[]): Stage<Corpus, Corpus> {
  return (c, ctx) => joinEvidence(c, evaluate<Corpus>(right, ctx));
}
