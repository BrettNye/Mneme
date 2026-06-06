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
import { oplusDedupe, oplusSynthesizeAs } from "./combination.js";
import { pairsOf, clustersOf } from "./contradiction.js";
import { resolutionRegistry } from "./registries.js";
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
 * Unsupported in v1: aggregate (throws UnsupportedExprOp — read-time terminal, §4.13).
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
          (c: Corpus, ctx: EvalContext) => {
            const clk = ctx.evaluationClock;
            if (clk === undefined) throw new Error("tau mode:now requires ctx.evaluationClock");
            return tauKnown(clk)(c);
          },
        ];
      }
      const t = node.t;
      if (t === undefined) throw new Error(`tau mode:${node.mode} requires t`);
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
        (c: Corpus, ctx: EvalContext) => {
          const clk = ctx.evaluationClock;
          if (clk === undefined) throw new Error("delta requires ctx.evaluationClock");
          return delta(node.policy, clk)(c);
        },
      ];

    case "combine": // ⊕_dedupe (§4.9): collapse same-(subject,key,scope) claims via the rule
      return [...compile(node.src), liftOp(oplusDedupe(node.rule, node.params,
        node.similarity ? { similarity: node.similarity } : undefined))];

    case "resolve": {
      const { policy, threshold, rule: resolveRule, keyCardinality, keyAliases } = node;
      if (threshold === undefined) {
        throw new Error(
          "resolve node has no threshold — stamp corpus defaults via the derive path or pass one explicitly",
        );
      }
      const detectionOpts =
        keyCardinality !== undefined || keyAliases !== undefined
          ? { keyCardinality, keyAliases }
          : undefined;
      return [...compile(node.src), (c: Corpus) => {
        const { fn, input } = resolutionRegistry(policy); // throws MissingRule on unknown at evaluate time
        const apply = fn as (g: unknown, rule?: string) => (c: Corpus) => Corpus;
        const groups = input === "pairs"
          ? pairsOf(c, threshold, detectionOpts)
          : clustersOf(c, threshold, detectionOpts);
        return apply(groups, resolveRule)(c);
      }];
    }

    case "aggregate":
      // read-time terminal (AggregateResult, §4.13) — not a replayable claim query
      throw new UnsupportedExprOp("aggregate");

    default: {
      const _exhaustive: never = node;
      throw new UnsupportedExprOp((node as { op: string }).op);
    }
  }
}
