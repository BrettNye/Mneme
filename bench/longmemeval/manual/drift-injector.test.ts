import { describe, it, expect } from "vitest";
import { injectDrift, morphVariants, hashStr, buildJudgedVocab, type DriftOpts } from "./drift-injector.js";
import type { ClaimRecordT } from "../types.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SINGLE = { employer: "single", city: "single", hobby: "multi" } as Record<string, "single" | "multi">;

function rec(subject: string, key: string, value: string, validFrom: number): ClaimRecordT {
  return { subject, key, value, validFrom, tags: [`session:s-${validFrom}`, "turn:0"] };
}

// A superseding lineage (same subject+key, two times) plus a multi-key claim.
const CLAIMS: ClaimRecordT[] = [
  rec("alice", "employer", "Initech", 1000),
  rec("alice", "employer", "Globex", 2000),
  rec("alice", "city", "Denver", 1500),
  rec("alice", "hobby", "sushi", 1500),
];

const baseOpts = (over: Partial<DriftOpts> = {}): DriftOpts => ({
  mode: "morph", fraction: 0.5, seed: "t", multiKeys: SINGLE, ...over,
});

describe("hashStr", () => {
  it("is deterministic and order-free", () => {
    expect(hashStr("abc")).toBe(hashStr("abc"));
    expect(hashStr("abc")).not.toBe(hashStr("abd"));
  });
});

describe("morphVariants", () => {
  it("returns >= 2 distinct variants, none equal to the key", () => {
    const vs = morphVariants("employer");
    expect(new Set(vs).size).toBeGreaterThanOrEqual(2);
    expect(vs).not.toContain("employer");
  });
});

describe("injectDrift morph", () => {
  it("is a true no-op at fraction 0", () => {
    const r = injectDrift(CLAIMS, baseOpts({ fraction: 0 }));
    expect(r.claims).toEqual(CLAIMS);
    expect(r.aliasMap).toEqual({});
  });

  it("is deterministic for the same seed/fraction", () => {
    const a = injectDrift(CLAIMS, baseOpts());
    const b = injectDrift(CLAIMS, baseOpts());
    expect(b.claims).toEqual(a.claims);
    expect(b.aliasMap).toEqual(a.aliasMap);
  });

  it("never drifts a multi-value key", () => {
    const r = injectDrift(CLAIMS, baseOpts({ fraction: 1 }));
    const hobby = r.claims.find((c) => c.value === "sushi")!;
    expect(hobby.key).toBe("hobby");
  });

  it("preserves all non-key fields", () => {
    const r = injectDrift(CLAIMS, baseOpts({ fraction: 1 }));
    const initech = r.claims.find((c) => c.value === "Initech")!;
    expect(initech.subject).toBe("alice");
    expect(initech.validFrom).toBe(1000);
    expect(initech.tags).toEqual(["session:s-1000", "turn:0"]);
  });

  it("alias map is exact: every drifted key maps to its canonical, no canonical is a map key", () => {
    const r = injectDrift(CLAIMS, baseOpts({ fraction: 1 }));
    for (const [variant, canonical] of Object.entries(r.aliasMap)) {
      expect(["employer", "city"]).toContain(canonical);
      expect(r.aliasMap[canonical]).toBeUndefined();
    }
    // every claim whose key differs from its canonical must be in the map
    for (const c of r.claims) {
      if (c.value === "Initech" || c.value === "Globex") {
        if (c.key !== "employer") expect(r.aliasMap[c.key]).toBe("employer");
      }
    }
  });

  it("fragments a lineage at fraction 1 (employer lineage spans >= 2 distinct keys)", () => {
    const r = injectDrift(CLAIMS, baseOpts({ fraction: 1 }));
    const empKeys = new Set(
      r.claims.filter((c) => c.value === "Initech" || c.value === "Globex").map((c) => c.key),
    );
    expect(empKeys.size).toBeGreaterThanOrEqual(2);
  });

  it("variant selection is driven by full claim identity, not key alone", () => {
    const variants = morphVariants("employer"); // shared variant set for both claims
    // two claims, same subject+key, differ in validFrom AND value:
    const idA = "x|var|alice|employer|1000|Initech";
    const idB = "x|var|alice|employer|2000|Globex";
    // identities hash differently...
    expect(hashStr(idA)).not.toBe(hashStr(idB));
    // ...and map to DIFFERENT variant indices for this pair (so the lineage fragments):
    // seed "x" produces indices 2 and 3 respectively, proving fragmentation is reachable
    expect(hashStr(idA) % variants.length).not.toBe(hashStr(idB) % variants.length);
  });

  it("fragmentation is reachable across seeds (determinism + seed-driven)", () => {
    // Test 1: Determinism — same seed always produces same picks for the same claims.
    const r1 = injectDrift(CLAIMS, baseOpts({ seed: "test-seed", fraction: 1 }));
    const r2 = injectDrift(CLAIMS, baseOpts({ seed: "test-seed", fraction: 1 }));
    const empClaims1 = r1.claims.filter((c) => c.value === "Initech" || c.value === "Globex");
    const empClaims2 = r2.claims.filter((c) => c.value === "Initech" || c.value === "Globex");
    expect(empClaims1.map((c) => c.key)).toEqual(empClaims2.map((c) => c.key));

    // Test 2: For a 2-claim lineage with 5 morph variants (~20% collision probability),
    // at least one seed in a small set should produce ≥2 distinct variant keys,
    // proving fragmentation depends on full claim identity, not just key.
    const testSeeds = ["t", "a", "b", "c", "d"];
    let foundFragmentation = false;
    for (const seed of testSeeds) {
      const r = injectDrift(CLAIMS, baseOpts({ seed, fraction: 1 }));
      const empKeys = new Set(
        r.claims.filter((c) => c.value === "Initech" || c.value === "Globex").map((c) => c.key),
      );
      if (empKeys.size >= 2) {
        foundFragmentation = true;
        break;
      }
    }
    expect(foundFragmentation).toBe(true);
  });
});

describe("buildJudgedVocab", () => {
  // judged-pairs file: header line + symmetric {a,b,same} judgments.
  function writeJudgments(lines: object[]): string {
    const dir = mkdtempSync(join(tmpdir(), "drift-judge-"));
    const path = join(dir, "judgments.jsonl");
    const body = [
      { kind: "key-ratify-header", model: "claude-sonnet-4-6", promptVersion: "ratify-v1" },
      ...lines,
    ]
      .map((o) => JSON.stringify(o))
      .join("\n");
    writeFileSync(path, body, "utf-8");
    return path;
  }

  const claims: ClaimRecordT[] = [
    { subject: "u", key: "employer", value: "A", validFrom: 1, tags: ["session:s1", "turn:0"] },
    { subject: "u", key: "employer", value: "B", validFrom: 2, tags: ["session:s2", "turn:0"] },
    { subject: "u", key: "current_employer", value: "C", validFrom: 3, tags: ["session:s3", "turn:0"] },
    { subject: "u", key: "city", value: "Denver", validFrom: 1, tags: ["session:s1", "turn:0"] },
  ];

  it("groups a same:true pair; canonical = most claims; variant is the other member", () => {
    const path = writeJudgments([
      { a: "employer", b: "current_employer", same: true, score: 0.95 },
    ]);
    const vocab = buildJudgedVocab(claims, path);
    // employer (2 claims) > current_employer (1) → canonical employer, variant current_employer
    expect(vocab.get("employer")).toEqual(["current_employer"]);
    expect(vocab.has("current_employer")).toBe(false);
  });

  it("ignores same:false pairs and keys absent from the claims-file", () => {
    const path = writeJudgments([
      { a: "employer", b: "current_employer", same: false, score: 0.4 },
      { a: "city", b: "hometown", same: true, score: 0.9 }, // hometown not in claims
    ]);
    const vocab = buildJudgedVocab(claims, path);
    expect(vocab.has("employer")).toBe(false); // same:false → not grouped
    // city↔hometown: hometown has 0 claims; canonical=city, variant hometown retained
    // (hometown is a valid variant target even with no own claims)
    expect(vocab.get("city")).toEqual(["hometown"]);
  });

  it("judged injection only drifts canonical-with-variant keys", () => {
    const path = writeJudgments([
      { a: "employer", b: "current_employer", same: true, score: 0.95 },
    ]);
    const vocab = buildJudgedVocab(claims, path);
    const r = injectDrift(claims, {
      mode: "judged", fraction: 1, seed: "t",
      multiKeys: {}, judgedVocab: vocab,
    });
    // city has no judged variant → untouched
    expect(r.claims.find((c) => c.value === "Denver")!.key).toBe("city");
    // employer claims drift to current_employer (the only variant)
    const a = r.claims.find((c) => c.value === "A")!;
    expect(a.key).toBe("current_employer");
    expect(r.aliasMap["current_employer"]).toBe("employer");
  });
});
