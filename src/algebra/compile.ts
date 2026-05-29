import type { ExprNode } from "./ast.js";
import {
  type Stage,
  type EvalContext,
  leaf as leafStage,
  liftOp,
  gammaStage,
} from "./expression.js";
import { sigma } from "./selection.js";
import { rho } from "./similarity.js";
import { tauValid, tauRecorded, tauKnown } from "./temporal.js";
import { delta } from "./decay.js";
import { pi } from "./projection.js";
import { kappa } from "./composition.js";
import { oplusSynthesizeAs } from "./combination.js";
import type { Corpus } from "./types.js";

export class UnsupportedExprOp extends Error {
  constructor(public readonly op: string) {
    super(`compile v1 does not support op: ${op}`);
  }
}

/**
 * compile(node): Stage[]
 *
 * Walks the ExprNode src-chain and produces a flat, leaf-first stage list.
 * Maps each supported ExprNode variant to its corresponding operator closure.
 * Pure structural transform — no EvalContext is read at compile time;
 * the context is threaded later by the unchanged evaluate().
 *
 * Unsupported in v1: combine, resolve, aggregate (throw UnsupportedExprOp).
 * Clock-pinned: delta and tau mode:"now" use ctx.evaluationClock at evaluate
 * time, ensuring deterministic replay re-execution.
 */
export function compile(node: ExprNode): Stage<any, any>[] {
  switch (node.op) {
    case "leaf":
      return [leafStage(node.corpusId)];

    case "sigma":
      return [...compile(node.src), liftOp(sigma(node.pred))];

    case "pi":
      return [...compile(node.src), liftOp(pi(node.fields))];

    case "rho":
      return [...compile(node.src), liftOp(rho(node.fn, node.query))];

    case "gamma":
      return [...compile(node.src), gammaStage(node.depth)];

    case "kappa":
      return [
        ...compile(node.src),
        liftOp(kappa(node.fmt, node.maxTokens, node.dedupThreshold)),
      ];

    case "synthesize":
      return [
        ...compile(node.src),
        liftOp(oplusSynthesizeAs(node.subject, node.key, node.rule, node.params)),
      ];

    case "tau": {
      if (node.mode === "now") {
        // Clock-pinning: read ctx.evaluationClock at evaluate time, not wall-clock
        return [
          ...compile(node.src),
          (c: Corpus, ctx: EvalContext) => tauKnown(ctx.evaluationClock!)(c),
        ];
      }
      const t = node.t!;
      const fn =
        node.mode === "valid"
          ? tauValid(t)
          : node.mode === "recorded"
          ? tauRecorded(t)
          : tauKnown(t); // mode === "known"
      return [...compile(node.src), liftOp(fn)];
    }

    case "delta":
      // Clock-pinning: read ctx.evaluationClock at evaluate time, not compile time
      return [
        ...compile(node.src),
        (c: Corpus, ctx: EvalContext) => delta(node.policy, ctx.evaluationClock!)(c),
      ];

    case "combine":
    case "resolve":
    case "aggregate":
      throw new UnsupportedExprOp(node.op);
  }
}
