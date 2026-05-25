import { subjectOf } from "./key.js";

it("derives subject and rejects dynamic segments", () => {
  expect(subjectOf("repo.test-command")).toBe("repo");
  expect(() => subjectOf("repo.{repoId}.test-command")).toThrow();
});

it("derives subject from a three-segment key", () => {
  expect(subjectOf("user.preference.terseness")).toBe("user");
});

it("rejects keys with uppercase letters", () => {
  expect(() => subjectOf("Repo.test-command")).toThrow();
  expect(() => subjectOf("repo.Test-command")).toThrow();
});

it("rejects keys with underscores", () => {
  expect(() => subjectOf("repo.test_command")).toThrow();
  expect(() => subjectOf("repo_name.test-command")).toThrow();
});

it("rejects keys with fewer than two segments", () => {
  expect(() => subjectOf("repo")).toThrow();
  expect(() => subjectOf("")).toThrow();
});
