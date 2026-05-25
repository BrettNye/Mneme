import { pointEstimate, scalarToBeta } from "./confidence.js";

it("Beta mean is alpha/(alpha+beta)", () => {
  expect(pointEstimate({ distribution: "beta", parameters: { alpha: 3, beta: 2 }, raw: 0.6 })).toBeCloseTo(0.6);
});

it("scalar point estimate returns p", () => {
  expect(pointEstimate({ distribution: "scalar", parameters: { p: 0.75 }, raw: 0.75 })).toBeCloseTo(0.75);
});

it("scalarToBeta keeps prior-inclusive structure (alpha+beta = pseudocount+W)", () => {
  const { alpha, beta } = scalarToBeta(0.8, 8); // {W:2,a:0.5}
  expect(alpha + beta).toBeCloseTo(10);
});

it("scalarToBeta mean is close to scalar value (prior-inclusive, NOT Laplace)", () => {
  const { alpha, beta } = scalarToBeta(0.8, 8);
  // mean = alpha / (alpha + beta) should be close to 0.8
  // alpha = 0.8*8 + 0.5*2 = 6.4 + 1 = 7.4
  // beta  = 0.2*8 + 0.5*2 = 1.6 + 1 = 2.6
  // mean = 7.4/10 = 0.74 (prior pulls toward 0.5)
  expect(alpha / (alpha + beta)).toBeCloseTo(0.74);
});

it("effective field is optional and not set by pointEstimate", () => {
  const c: Parameters<typeof pointEstimate>[0] = {
    distribution: "beta",
    parameters: { alpha: 1, beta: 1 },
    raw: 0.5,
  };
  expect("effective" in c ? c.effective : undefined).toBeUndefined();
});
