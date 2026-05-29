import { runBioQuickstart } from "./bio-quickstart.js";

it("bio quickstart runs the cognitive loop on the public surface", () => {
  const r = runBioQuickstart();

  // recall surfaced at least the seeded memory into the episode
  expect(r.recalledCount).toBeGreaterThanOrEqual(1);

  // the cognitive cycle ran cleanly and applied reinforcement ops
  expect(r.cycleErrors).toBe(0);
  expect(r.opsApplied).toBeGreaterThan(0);

  // a successful outcome strengthened the recalled memory (Beta alpha rose)
  expect(r.reinforcedAlpha).toBeGreaterThan(r.seededAlpha);

  // consolidation ran cleanly on a known episode
  expect(r.consolidationErrors).toBe(0);
});
