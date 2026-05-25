import { scopeHash } from "./scope.js";

it("empty scope hashes to the reserved underscore", () => {
  expect(scopeHash({})).toBe("_");
  expect(scopeHash({ a: undefined })).toBe("_");
});

it("is insensitive to field order", () => {
  expect(scopeHash({ runId: "r", teamId: "t" })).toBe(
    scopeHash({ teamId: "t", runId: "r" })
  );
});

it("distinct scopes with = in keys/values produce different hashes", () => {
  // Under the old key=value&key=value format, these two scopes would both
  // produce the canonical string "a=x=y&b=z", causing a hash collision.
  // The fix must ensure they hash differently.
  expect(scopeHash({ "a=x": "y", b: "z" })).not.toBe(
    scopeHash({ a: "x=y", b: "z" })
  );
});
