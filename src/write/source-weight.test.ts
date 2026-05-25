import { betaFromRaw } from "./source-weight.js";
import type { ClaimSchema } from "../catalog/schema.js";
it("forms a prior-inclusive Beta and throws when pseudocount is undeclared", () => {
  const schema = { scalarPseudocount: { llm: 2 } } as unknown as ClaimSchema;
  const c = betaFromRaw(0.8, "llm", schema);
  expect(c.parameters).toEqual({ alpha: 0.8 * 2 + 1, beta: 0.2 * 2 + 1 }); // {W:2,a:0.5}
  expect(() => betaFromRaw(0.8, "manual", schema)).toThrow(/no scalarPseudocount/);
});
