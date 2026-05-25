import { betaToOpinion, opinionToBeta } from "./subjective-logic.js";

it("Beta(1,1) is the vacuous opinion (belief 0, uncertainty 1)", () => {
  const o = betaToOpinion(1, 1, 2, 0.5);
  expect(o.belief).toBeCloseTo(0);
  expect(o.disbelief).toBeCloseTo(0);
  expect(o.uncertainty).toBeCloseTo(1);
  expect(o.baseRate).toBeCloseTo(0.5);
});

it("projected probability equals belief + baseRate * uncertainty by construction", () => {
  // For arbitrary beta params, projected = alpha/(alpha+beta)
  // and by SL construction it should equal belief + baseRate * uncertainty
  const alpha = 3;
  const beta = 5;
  const a = 0.5;
  const W = 2;
  const o = betaToOpinion(alpha, beta, W, a);
  const projected = alpha / (alpha + beta);
  expect(o.belief + o.baseRate * o.uncertainty).toBeCloseTo(projected);
});

it("opinionToBeta is the inverse of betaToOpinion (round-trip)", () => {
  const alpha = 4;
  const beta = 6;
  const W = 2;
  const a = 0.5;
  const o = betaToOpinion(alpha, beta, W, a);
  const { alpha: alphaBack, beta: betaBack } = opinionToBeta(o, W);
  expect(alphaBack).toBeCloseTo(alpha);
  expect(betaBack).toBeCloseTo(beta);
});

it("round-trip with non-default base rate and different alpha/beta", () => {
  const alpha = 10;
  const beta = 3;
  const W = 2;
  const a = 0.3;
  const o = betaToOpinion(alpha, beta, W, a);
  const { alpha: alphaBack, beta: betaBack } = opinionToBeta(o, W);
  expect(alphaBack).toBeCloseTo(alpha);
  expect(betaBack).toBeCloseTo(beta);
});
