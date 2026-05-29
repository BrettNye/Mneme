import type { Corpus } from "./types.js";
import { corpusOf, claimTripleKey } from "./types.js";
import type { Claim } from "../core/claim.js";
import type { Stage, EvalContext } from "./expression.js";
import { evaluate } from "./expression.js";

/**
 * §4.10 layered-override operator ⊳ (precedence merge).
 *
 * `overrideOp(left, right)` produces a corpus where `left`'s claims take
 * precedence over `right`'s on matching (subject, key, scopeHash) triples,
 * while `right` still contributes claims about triples `left` does not address.
 *
 * Typed-object-spread semantic: {...right, ...left} where `left` (the
 * dominator) wins. For a contested triple ALL of left's claims are kept and
 * right's are dropped — no combination (callers pre-dedupe each input).
 *
 * Laws: associative; identity (C ⊳ ∅ = C and ∅ ⊳ C = C); NOT commutative.
 */
export const overrideOp = (left: Corpus, right: Corpus): Corpus => {
  const leftClaims = left.claims as Claim[];
  const rightClaims = right.claims as Claim[];

  // Triples addressed by the dominator.
  const leftTriples = new Set(
    leftClaims.map((cl) => claimTripleKey(cl.subject, cl.key, cl.scopeHash))
  );

  // Keep all of left; from right keep only triples left does not address.
  const contributed = rightClaims.filter(
    (cl) => !leftTriples.has(claimTripleKey(cl.subject, cl.key, cl.scopeHash))
  );

  return corpusOf([...leftClaims, ...contributed]);
};

/**
 * Stage builder for ⊳. The incoming corpus is the dominator (left); `right`
 * is its own sub-pipeline evaluated in the same ctx (mirrors how leaf/pipe
 * compose), then `overrideOp` applies left-precedence.
 */
export const override =
  (right: Stage<any, any>[]): Stage<Corpus, Corpus> =>
  (c, ctx: EvalContext) =>
    overrideOp(c, evaluate<Corpus>(right, ctx));
