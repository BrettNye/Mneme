import { valueHash } from "./value.js";

it("is insensitive to object key order", () => {
  expect(valueHash({ a: 1, b: 2 })).toBe(valueHash({ b: 2, a: 1 }));
});

it("hashes distinct values differently", () => {
  expect(valueHash("x")).not.toBe(valueHash("y"));
});

it("array order is significant", () => {
  expect(valueHash([1, 2])).not.toBe(valueHash([2, 1]));
});
