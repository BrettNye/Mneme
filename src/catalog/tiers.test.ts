import { validateRequiredTiers } from "./tiers.js";

it("rejects a corpus requiring an unavailable protocol tier", () => {
  expect(() => validateRequiredTiers([{ kind: "protocol", name: "dirichlet" }], [{ kind: "core" }])).toThrow(/dirichlet/);
});

it("accepts core-only against a core deployment", () => {
  expect(() => validateRequiredTiers([{ kind: "core" }], [{ kind: "core" }])).not.toThrow();
});

it("lists all missing tiers in the error, not just the first", () => {
  expect(() =>
    validateRequiredTiers(
      [
        { kind: "protocol", name: "dirichlet" },
        { kind: "profile", name: "advanced" },
      ],
      [{ kind: "core" }]
    )
  ).toThrow(/dirichlet.*advanced|advanced.*dirichlet/);
});
