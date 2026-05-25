import { covers, INFINITY } from "./time.js";
it("half-open interval includes from, excludes to", () => {
  expect(covers({ from: 10, to: 20 }, 10)).toBe(true);
  expect(covers({ from: 10, to: 20 }, 20)).toBe(false);
  expect(covers({ from: 10, to: INFINITY }, 1e15)).toBe(true);
});
