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
