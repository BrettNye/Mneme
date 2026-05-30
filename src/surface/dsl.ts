import { pipe, leaf, sigma, rho, kappa, delta, alpha } from "../index.js";
import type { Stage } from "../algebra/expression.js";

const GRAMMAR = `supported clauses:
  where subject = <s>
  where key = <k>
  where status = <st>
  where confidence > <n>
  rank jaccard "<q>"
  rank exact "<q>"
  decay exp <halfLifeDays>
  decay none
  as markdown <maxTokens>
  as xml <maxTokens>
  as json <maxTokens>
  as text <maxTokens>
  count`;

/**
 * Compile a DSL string against a corpus into an evaluable pipeline.
 *
 * The corpus leaf is always the first stage. Each pipe-separated clause
 * appends one stage. An empty DSL string returns [leaf(corpusId)].
 *
 * Exotic queries should fall back to session.mneme.query(...) with a
 * hand-built Stage[] pipeline.
 */
export function parseDsl(corpusId: string, dsl: string): Stage<any, any>[] {
  const clauses = dsl
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);

  const stages: Stage<any, any>[] = [leaf(corpusId)];

  for (const clause of clauses) {
    stages.push(compileClause(clause));
  }

  return pipe(...stages);
}

function compileClause(clause: string): Stage<any, any> {
  const m = (re: RegExp): RegExpMatchArray | null => clause.match(re);
  let g: RegExpMatchArray | null;

  // where subject = <value>
  if ((g = m(/^where subject\s*=\s*(.+)$/))) {
    return sigma({ op: "subjectEq", value: g[1].trim() });
  }

  // where key = <value>
  if ((g = m(/^where key\s*=\s*(.+)$/))) {
    return sigma({ op: "keyEq", value: g[1].trim() });
  }

  // where status = <value>
  if ((g = m(/^where status\s*=\s*(.+)$/))) {
    return sigma({ op: "statusEq", value: g[1].trim() });
  }

  // where confidence > <number>
  if ((g = m(/^where confidence\s*>\s*(\d+(?:\.\d+)?)$/))) {
    return sigma({ op: "confidenceGt", value: Number(g[1]) });
  }

  // rank jaccard "<query>"
  if ((g = m(/^rank jaccard\s+"(.*)"$/))) {
    return rho.jaccard(g[1]);
  }

  // rank exact "<query>"
  if ((g = m(/^rank exact\s+"(.*)"$/))) {
    return rho.exact(g[1]);
  }

  // decay exp <halfLifeDays>
  if ((g = m(/^decay exp\s+(\d+(?:\.\d+)?)$/))) {
    return delta.exponential(Number(g[1]));
  }

  // decay none
  if (clause === "decay none") {
    return delta.none();
  }

  // as markdown <maxTokens>
  if ((g = m(/^as markdown\s+(\d+)$/))) {
    return kappa.markdown(Number(g[1]));
  }

  // as xml <maxTokens>
  if ((g = m(/^as xml\s+(\d+)$/))) {
    return kappa.xml(Number(g[1]));
  }

  // as json <maxTokens>
  if ((g = m(/^as json\s+(\d+)$/))) {
    return kappa.json(Number(g[1]));
  }

  // as text <maxTokens>
  if ((g = m(/^as text\s+(\d+)$/))) {
    return kappa.text(Number(g[1]));
  }

  // count
  if (clause === "count") {
    return alpha.count();
  }

  throw new Error(`unknown clause: "${clause}"\n${GRAMMAR}`);
}
