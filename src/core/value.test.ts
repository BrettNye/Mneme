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

it("null does not throw and is distinct from false and 0", () => {
  expect(() => valueHash(null)).not.toThrow();
  expect(valueHash(null)).not.toBe(valueHash(false));
  expect(valueHash(null)).not.toBe(valueHash(0));
});

it("is insensitive to nested object key order", () => {
  expect(valueHash({ z: { b: 1, a: 2 } })).toBe(valueHash({ z: { a: 2, b: 1 } }));
});
