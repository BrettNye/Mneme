import { newClaimId } from "./ids.js";

it("newClaimId returns a v4 UUID", () => {
  expect(newClaimId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

it("two calls to newClaimId return different values", () => {
  const id1 = newClaimId();
  const id2 = newClaimId();
  expect(id1).not.toBe(id2);
});
