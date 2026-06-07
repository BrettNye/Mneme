import { createHash } from "node:crypto";

/** Deterministic 50/50 split by question id — byte-identical to the inline
 *  expression in abstention-signals.ts (the deep-dive split). The efficacy
 *  protocol cites THIS function as the split definition.
 *  The exact expression (audit-quoted from abstention-signals.ts:156):
 *  parseInt(createHash("sha256").update(questionId).digest("hex").slice(0, 8), 16) % 2 === 0 */
export function isTrain(questionId: string): boolean {
  return parseInt(createHash("sha256").update(questionId).digest("hex").slice(0, 8), 16) % 2 === 0;
}

/** Cross-fit folds: every item is evaluated held-out exactly once. */
export function splitFolds<T>(items: T[], idOf: (t: T) => string): { A: T[]; B: T[] } {
  const A: T[] = [];
  const B: T[] = [];
  for (const item of items) {
    if (isTrain(idOf(item))) {
      A.push(item);
    } else {
      B.push(item);
    }
  }
  return { A, B };
}
