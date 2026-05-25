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

it("tauKnown equals tauValid composed with tauRecorded (non-vacuous law test)", () => {
  // At T=50:
  // claimLaw1: valid {from:100,to:200} → tauValid(50) FAILS; recorded=10 → tauRecorded(50) passes
  //   → survives tauRecorded but then filtered out by tauValid → NOT in result
  // claimLaw2: valid {from:0,to:100} → tauValid(50) passes; recorded=10 → tauRecorded(50) passes
  //   → survives both → IN result
  // claimLaw3: valid {from:0,to:100} → tauValid(50) passes; recorded=80 → tauRecorded(50) FAILS
  //   → filtered by tauRecorded → NOT in result
  const claimLaw1 = makeClaim({ from: 100, to: 200 }, 10);
  const claimLaw2 = makeClaim({ from: 0, to: 100 }, 10);
  const claimLaw3 = makeClaim({ from: 0, to: 100 }, 80);
  const c = corpusOf([claimLaw1, claimLaw2, claimLaw3]);

  const knownResult = tauKnown(50)(c);
  const composedResult = tauValid(50)(tauRecorded(50)(c));

  // Law: tauKnown == tauValid ∘ tauRecorded
  expect(knownResult).toEqual(composedResult);
  // Non-trivial: exactly 1 claim survives (claimLaw2)
  expect(knownResult.claims).toHaveLength(1);
  expect(knownResult.claims).toContain(claimLaw2);
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

it("tauNow excludes future-recorded claims (fixed clock)", () => {
  const fixedClock = () => 1000;
  // recorded=2000 > clock()=1000, so tauRecorded filters it out
  const futureRecorded = makeClaim({ from: 0, to: Number.POSITIVE_INFINITY }, 2000);
  const c = corpusOf([futureRecorded]);
  const result = tauNow(fixedClock)(c);
  expect(result.claims).not.toContain(futureRecorded);
});

it("tauNow includes a currently-valid and already-recorded claim (fixed clock)", () => {
  const fixedClock = () => 1000;
  // valid [0, 2000) covers 1000; recorded=500 <= 1000
  const currentlyValid = makeClaim({ from: 0, to: 2000 }, 500);
  const c = corpusOf([currentlyValid]);
  const result = tauNow(fixedClock)(c);
  expect(result.claims).toContain(currentlyValid);
});
