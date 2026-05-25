import { tauKnown, tauValid, tauRecorded, tauNow } from "./temporal.js";
import { corpusOf } from "./types.js";
import type { Claim } from "../core/claim.js";

// Minimal claim factory for testing — only valid and recorded matter here
function makeClaim(valid: { from: number; to: number }, recorded: number): Claim {
  return { valid, recorded } as unknown as Claim;
}

const claimA = makeClaim({ from: 0, to: 100 }, 50);   // valid at 50, recorded at 50
const claimB = makeClaim({ from: 0, to: 100 }, 150);  // valid at 100, recorded at 150
const claimC = makeClaim({ from: 200, to: 300 }, 10); // not valid at 100, recorded early

it("tauValid keeps claims whose interval covers T", () => {
  const c = corpusOf([claimA, claimB, claimC]);
  // covers is [from, to) so t=99 is inside [0,100) for claimA and claimB
  // claimC has [200,300) which does not cover 99
  const result = tauValid(99)(c);
  expect(result.claims).toContain(claimA);
  expect(result.claims).toContain(claimB);
  expect(result.claims).not.toContain(claimC);
});

it("tauValid keeps claim when T is inside interval", () => {
  const c = corpusOf([claimA]);
  expect(tauValid(50)(c).claims).toContain(claimA);
});

it("tauValid excludes claim when T is at or past 'to' boundary", () => {
  const c = corpusOf([claimA]); // to=100, half-open [from, to)
  expect(tauValid(100)(c).claims).toHaveLength(0);
});

it("tauRecorded keeps claims where recorded <= T", () => {
  const c = corpusOf([claimA, claimB, claimC]);
  // at T=100: claimA.recorded=50<=100 ✓, claimB.recorded=150>100 ✗, claimC.recorded=10<=100 ✓
  const result = tauRecorded(100)(c);
  expect(result.claims).toContain(claimA);
  expect(result.claims).not.toContain(claimB);
  expect(result.claims).toContain(claimC);
});

it("tauKnown equals tauValid composed with tauRecorded", () => {
  const c = corpusOf([
    { valid: { from: 0, to: 100 }, recorded: 50 } as unknown as Claim,
    { valid: { from: 0, to: 100 }, recorded: 150 } as unknown as Claim,
  ]);
  expect(tauKnown(100)(c)).toEqual(tauValid(100)(tauRecorded(100)(c)));
});

it("tauKnown keeps only claims that are both valid at T and recorded at or before T", () => {
  const c = corpusOf([claimA, claimB, claimC]);
  const result = tauKnown(50)(c);
  // at T=50: claimA valid([0,100) covers 50) AND recorded(50<=50) ✓
  // claimB recorded(150>50) ✗
  // claimC valid([200,300) does NOT cover 50) ✗
  expect(result.claims).toContain(claimA);
  expect(result.claims).not.toContain(claimB);
  expect(result.claims).not.toContain(claimC);
});

it("tauNow excludes future-recorded claims", () => {
  const futureRecorded = makeClaim({ from: 0, to: Number.POSITIVE_INFINITY }, Date.now() + 999_999_999);
  const c = corpusOf([futureRecorded]);
  const result = tauNow()(c);
  expect(result.claims).not.toContain(futureRecorded);
});

it("tauNow includes a currently-valid and already-recorded claim", () => {
  const currentlyValid = makeClaim(
    { from: Date.now() - 10_000, to: Date.now() + 10_000 },
    Date.now() - 5_000,
  );
  const c = corpusOf([currentlyValid]);
  const result = tauNow()(c);
  expect(result.claims).toContain(currentlyValid);
});
