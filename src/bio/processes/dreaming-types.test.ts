import { depthTag, depthOf, isUnvalidatedDream, DREAM_WORKFLOW, MAX_DREAM_DEPTH, DREAM_PRIOR } from "./dreaming-types.js";

it("depthOf round-trips depthTag and defaults to 0 for non-dream claims", () => {
  expect(depthOf({ tags: [depthTag(2)] } as any)).toBe(2);
  expect(depthOf({ tags: [] } as any)).toBe(0);
});

it("depthTag produces the expected string format", () => {
  expect(depthTag(0)).toBe("dream-depth:0");
  expect(depthTag(3)).toBe("dream-depth:3");
});

it("isUnvalidatedDream is true only when workflow is 'dream' and status is 'candidate'", () => {
  const dreamCandidate = { provenance: { workflow: DREAM_WORKFLOW }, status: "candidate" } as any;
  expect(isUnvalidatedDream(dreamCandidate)).toBe(true);

  // validated dream → false
  const dreamValidated = { provenance: { workflow: DREAM_WORKFLOW }, status: "validated" } as any;
  expect(isUnvalidatedDream(dreamValidated)).toBe(false);

  // provisional dream → false
  const dreamProvisional = { provenance: { workflow: DREAM_WORKFLOW }, status: "provisional" } as any;
  expect(isUnvalidatedDream(dreamProvisional)).toBe(false);

  // non-dream candidate → false
  const otherCandidate = { provenance: { workflow: "other-workflow" }, status: "candidate" } as any;
  expect(isUnvalidatedDream(otherCandidate)).toBe(false);

  // no workflow → false
  const noWorkflow = { provenance: {}, status: "candidate" } as any;
  expect(isUnvalidatedDream(noWorkflow)).toBe(false);
});

it("DREAM_PRIOR has alpha:1 beta:3 (mean 0.25 — clearly subordinate)", () => {
  expect(DREAM_PRIOR).toEqual({ alpha: 1, beta: 3 });
});

it("MAX_DREAM_DEPTH is 3", () => {
  expect(MAX_DREAM_DEPTH).toBe(3);
});

it("DREAM_WORKFLOW is 'dream'", () => {
  expect(DREAM_WORKFLOW).toBe("dream");
});
