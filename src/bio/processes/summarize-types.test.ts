import { isSummary, SUMMARY_WORKFLOW } from "./summarize-types.js";

it("isSummary is true only for the summary workflow marker", () => {
  expect(SUMMARY_WORKFLOW).toBe("summary");
  expect(isSummary({ provenance: { workflow: "summary" } } as any)).toBe(true);
  expect(isSummary({ provenance: { workflow: "dream" } } as any)).toBe(false);
  expect(isSummary({ provenance: {} } as any)).toBe(false);
});
