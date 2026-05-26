import type { AppendOp } from "./types.js";

it("AppendOp discriminates its three kinds", () => {
  const ops: AppendOp[] = [
    { kind: "supersede", deprecate: "id-1" as any, with: {} as any, reason: "reinforce" },
  ];
  expect(ops[0].kind).toBe("supersede");
});
