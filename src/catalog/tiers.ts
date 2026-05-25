export type TierRequirement =
  | { kind: "core" }
  | { kind: "protocol"; name: string }
  | { kind: "profile"; name: string };

export const tierKey = (t: TierRequirement): string =>
  t.kind === "core" ? "core" : `${t.kind}:${t.name}`;

export function validateRequiredTiers(
  required: TierRequirement[],
  available: TierRequirement[]
): void {
  const have = new Set(available.map(tierKey));
  const missing = required.filter((r) => !have.has(tierKey(r)));
  if (missing.length)
    throw new Error(`unavailable tiers: ${missing.map(tierKey).join(", ")}`);
}
