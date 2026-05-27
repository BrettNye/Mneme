import { selectSummarizeInput } from "./summarize-select.js";

it("returns [] without calling read when episode has empty runIds", () => {
  let readCalled = false;
  const read = () => { readCalled = true; return []; };
  const result = selectSummarizeInput(read, { id: "e", runIds: [], startedAt: 0 } as any);
  expect(result).toEqual([]);
  expect(readCalled).toBe(false);
});

it("excludes prior summaries (collapse guard)", () => {
  const claims = [
    { id: "a", status: "candidate", provenance: { workflow: "summary", runId: "r1" }, recorded: 2, confidence: { raw: 0.5 } },
    { id: "b", status: "candidate", provenance: { workflow: "dream", runId: "r1" }, recorded: 1, confidence: { raw: 0.5 } },
  ] as any[];
  const read = () => claims;
  const result = selectSummarizeInput(read, { id: "e", runIds: ["r1"], startedAt: 0 } as any);
  expect(result.map((c) => c.id)).toEqual(["b"]);
});

it("excludes deprecated claims", () => {
  const claims = [
    { id: "c", status: "deprecated", provenance: { workflow: "grounded", runId: "r1" }, recorded: 3, confidence: { raw: 0.9 } },
    { id: "d", status: "candidate", provenance: { workflow: "grounded", runId: "r1" }, recorded: 2, confidence: { raw: 0.5 } },
  ] as any[];
  const read = () => claims;
  const result = selectSummarizeInput(read, { id: "e", runIds: ["r1"], startedAt: 0 } as any);
  expect(result.map((c) => c.id)).toEqual(["d"]);
});

it("caps to maxInputClaims ordered by recency then confidence", () => {
  const claims = [
    { id: "x1", status: "candidate", provenance: { workflow: "dream", runId: "r1" }, recorded: 1, confidence: { raw: 0.9 } },
    { id: "x2", status: "candidate", provenance: { workflow: "dream", runId: "r1" }, recorded: 3, confidence: { raw: 0.4 } },
    { id: "x3", status: "candidate", provenance: { workflow: "dream", runId: "r1" }, recorded: 2, confidence: { raw: 0.7 } },
  ] as any[];
  const read = () => claims;
  // cap to 2 — should get the two most-recent: x2 (recorded=3) then x3 (recorded=2)
  const result = selectSummarizeInput(read, { id: "e", runIds: ["r1"], startedAt: 0 } as any, { maxInputClaims: 2 });
  expect(result.map((c) => c.id)).toEqual(["x2", "x3"]);
});

it("uses confidence as tiebreaker when recorded timestamps are equal", () => {
  const claims = [
    { id: "y1", status: "candidate", provenance: { workflow: "dream", runId: "r1" }, recorded: 5, confidence: { raw: 0.3 } },
    { id: "y2", status: "candidate", provenance: { workflow: "dream", runId: "r1" }, recorded: 5, confidence: { raw: 0.8 } },
  ] as any[];
  const read = () => claims;
  const result = selectSummarizeInput(read, { id: "e", runIds: ["r1"], startedAt: 0 } as any);
  expect(result.map((c) => c.id)).toEqual(["y2", "y1"]);
});

it("uses DEFAULT_BIO_POLICY.summarize.maxInputClaims (200) as default cap", () => {
  const claims = Array.from({ length: 250 }, (_, i) => ({
    id: `z${i}`,
    status: "candidate",
    provenance: { workflow: "dream", runId: "r1" },
    recorded: i,
    confidence: { raw: 0.5 },
  })) as any[];
  const read = () => claims;
  const result = selectSummarizeInput(read, { id: "e", runIds: ["r1"], startedAt: 0 } as any);
  expect(result).toHaveLength(200);
});
