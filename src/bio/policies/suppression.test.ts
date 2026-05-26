import { suppression, compose, exponentialDecay } from "./suppression.js";

it("drops claims whose decayed confidence is below the floor, keeps the rest", () => {
  const policy = suppression({ floor: 0.5 });
  const decay = (_c: any, _now: number) => 0.3;            // stub decay below floor
  const claims = [{ id: "c1" } as any];
  expect(policy.apply(claims, { now: 0, decay } as any)).toHaveLength(0);
});

it("keeps claims whose decayed confidence is at or above the floor", () => {
  const policy = suppression({ floor: 0.5 });
  const decay = (_c: any, _now: number) => 0.5;            // stub decay at floor
  const claims = [{ id: "c1" } as any];
  const result = policy.apply(claims, { now: 0, decay } as any);
  expect(result).toHaveLength(1);
  expect(result[0]).toBe(claims[0]);
});

it("does not mutate the input array when filtering", () => {
  const policy = suppression({ floor: 0.5 });
  const decay = (_c: any, _now: number) => 0.3;
  const claims = [{ id: "c1" } as any, { id: "c2" } as any];
  const original = [...claims];
  policy.apply(claims, { now: 0, decay } as any);
  expect(claims).toHaveLength(2);
  expect(claims[0]).toBe(original[0]);
  expect(claims[1]).toBe(original[1]);
});

it("compose applies policies left-to-right over the claim list", () => {
  const calls: string[] = [];
  const p1 = {
    name: "p1",
    apply: (claims: any[], _ctx: any) => { calls.push("p1"); return claims.slice(0, 1); },
  };
  const p2 = {
    name: "p2",
    apply: (claims: any[], _ctx: any) => { calls.push("p2"); return claims; },
  };
  const composed = compose([p1, p2]);
  const claims = [{ id: "c1" } as any, { id: "c2" } as any];
  const result = composed.apply(claims, { now: 0, decay: () => 1 } as any);
  expect(calls).toEqual(["p1", "p2"]);
  expect(result).toHaveLength(1);
});

it("exponentialDecay returns pointEstimate * 0.5^(age/halfLife)", () => {
  const halfLife = 1000;
  const decayFn = exponentialDecay(halfLife);
  const now = 2000;
  const recorded = 1000; // age = 1000ms = 1 half-life
  const confidence = { distribution: "scalar" as const, parameters: { p: 0.8 }, raw: 0.8 };
  const claim = { confidence, recorded } as any;
  const result = decayFn(claim, now);
  // pointEstimate(0.8) * 0.5^(1000/1000) = 0.8 * 0.5 = 0.4
  expect(result).toBeCloseTo(0.4, 10);
});
