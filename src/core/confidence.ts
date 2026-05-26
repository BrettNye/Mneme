export interface Prior { W: number; a: number } // §0.3: default {W:2, a:0.5}
export const DEFAULT_PRIOR: Prior = { W: 2, a: 0.5 };

export type Confidence =
  | { distribution: "beta"; parameters: { alpha: number; beta: number }; raw: number; effective?: number }
  | { distribution: "scalar"; parameters: { p: number }; raw: number; effective?: number };

export const betaMean = (alpha: number, beta: number): number => alpha / (alpha + beta);

export function pointEstimate(c: Confidence): number {
  return c.distribution === "beta"
    ? betaMean(c.parameters.alpha, c.parameters.beta)
    : c.parameters.p;
}

export function scalarToBeta(
  scalar: number,
  pseudocount: number,
  prior: Prior = DEFAULT_PRIOR
): { alpha: number; beta: number } {
  return {
    alpha: scalar * pseudocount + prior.a * prior.W,
    beta: (1 - scalar) * pseudocount + (1 - prior.a) * prior.W,
  };
}
