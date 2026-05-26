import { selectDreamInput } from "./dreaming-select.js";
import type { Claim } from "../../core/claim.js";
import type { Episode } from "../types.js";
import { MAX_DREAM_DEPTH, depthTag } from "./dreaming-types.js";

// Minimal claim factory — casts branded fields via as any / as unknown as Claim
function makeClaim(
  id: string,
  overrides: {
    recorded?: number;
    status?: string;
    workflow?: string;
    tags?: string[];
    confidenceRaw?: number;
  } = {}
): Claim {
  return {
    id: id as any,
    profile: "p1" as any,
    workspace: "w1" as any,
    subject: "lesson",
    key: "lesson.x",
    scope: {},
    scopeHash: "sh",
    value: { text: "v" },
    valueHash: "vh",
    confidence: { raw: overrides.confidenceRaw ?? 0.8 } as any,
    valid: { from: 0, to: Infinity },
    recorded: overrides.recorded ?? 1,
    recordedSeq: 0,
    status: (overrides.status ?? "validated") as any,
    source: "manual",
    provenance: { workflow: overrides.workflow ?? "extract" } as any,
    evidence: [],
    tags: overrides.tags ?? [],
    schema: "1.0",
  } as unknown as Claim;
}

const episode: Episode = { id: "ep1", runIds: ["r1"], startedAt: 0 };

// ------- spec-provided test -------

it("excludes unvalidated dreams from the dreamable set", () => {
  const candidateDream = makeClaim("d1", { recorded: 2, status: "candidate", workflow: "dream", confidenceRaw: 0.9 });
  const grounded = makeClaim("g1", { recorded: 1, status: "validated", workflow: "extract", confidenceRaw: 0.9 });
  const read = () => [candidateDream, grounded];
  const out = selectDreamInput(read, episode);
  expect(out.map((c) => c.id)).toEqual(["g1"]);
});

// ------- empty runIds → [] (no read called) -------

it("returns empty array when episode has no runIds without calling read", () => {
  let readCalled = false;
  const read = () => { readCalled = true; return []; };
  const out = selectDreamInput(read, { id: "ep0", runIds: [], startedAt: 0 });
  expect(out).toEqual([]);
  expect(readCalled).toBe(false);
});

// ------- depth-cap exclusion -------

it("excludes claims at or above MAX_DREAM_DEPTH", () => {
  const atCap = makeClaim("deep", { tags: [depthTag(MAX_DREAM_DEPTH)], status: "validated", workflow: "dream" });
  const belowCap = makeClaim("shallow", { tags: [depthTag(MAX_DREAM_DEPTH - 1)], status: "validated", workflow: "dream" });
  const nonDream = makeClaim("plain");
  const read = () => [atCap, belowCap, nonDream];
  const out = selectDreamInput(read, episode);
  const ids = out.map((c) => c.id);
  expect(ids).not.toContain("deep");
  expect(ids).toContain("shallow");
  expect(ids).toContain("plain");
});

// ------- malformed depth tag treated as MAX_DREAM_DEPTH (excluded) -------

it("excludes claims with malformed depth tag (treated as at-cap)", () => {
  // Override tags directly via cast since makeClaim doesn't expose raw tags with malformed values
  const malformed: Claim = {
    ...(makeClaim("bad-depth", { status: "validated", workflow: "dream" }) as any),
    tags: ["dream-depth:NaN"],
  } as unknown as Claim;
  const read = () => [malformed];
  const out = selectDreamInput(read, episode);
  expect(out.map((c) => c.id)).not.toContain("bad-depth");
});

// ------- top-N bound -------

it("respects maxInputClaims option and returns at most that many claims", () => {
  const claims = Array.from({ length: 10 }, (_, i) =>
    makeClaim(`c${i}`, { recorded: i })
  );
  const read = () => claims;
  const out = selectDreamInput(read, episode, { maxInputClaims: 3 });
  expect(out.length).toBe(3);
});

// ------- ranking: recency first, then confidence -------

it("ranks by recency desc, then confidence desc", () => {
  const c1 = makeClaim("old-low",  { recorded: 1, confidenceRaw: 0.5 });
  const c2 = makeClaim("new-high", { recorded: 5, confidenceRaw: 0.9 });
  const c3 = makeClaim("new-low",  { recorded: 5, confidenceRaw: 0.3 });
  const read = () => [c1, c2, c3];
  const out = selectDreamInput(read, episode);
  expect(out.map((c) => c.id)).toEqual(["new-high", "new-low", "old-low"]);
});

// ------- no mutation of input pool -------

it("does not mutate the input array returned by read", () => {
  const readResult = [
    makeClaim("a", { recorded: 1 }),
    makeClaim("b", { recorded: 3 }),
    makeClaim("c", { recorded: 2 }),
  ];
  const originalOrder = readResult.map((c) => c.id);
  const read = () => readResult;
  selectDreamInput(read, episode);
  // The array returned from read must not have been sorted in place
  expect(readResult.map((c) => c.id)).toEqual(originalOrder);
});

// ------- validated dream passes through -------

it("allows validated dream claims (only candidate dreams are excluded)", () => {
  const validatedDream = makeClaim("vd1", {
    status: "validated",
    workflow: "dream",
    tags: [depthTag(1)],
  });
  const read = () => [validatedDream];
  const out = selectDreamInput(read, episode);
  expect(out.map((c) => c.id)).toContain("vd1");
});

// ------- default maxInputClaims is 200 -------

it("default maxInputClaims is 200", () => {
  const claims = Array.from({ length: 250 }, (_, i) =>
    makeClaim(`c${i}`, { recorded: i })
  );
  const read = () => claims;
  const out = selectDreamInput(read, episode);
  expect(out.length).toBe(200);
});
