import { describe, it, expect } from "vitest";
import type { Claim } from "../../../src/core/claim.js";
import { rankBlend } from "./rank-blend.js";
import { rankBlendConf } from "./rank-blend-conf.js";

function mk(id: string, value: string, validFrom: number, conf: number): Claim {
  return {
    id, subject: "s", key: "k", value,
    valid: { from: validFrom, to: Infinity },
    confidence: { distribution: "scalar", parameters: { p: conf }, raw: conf },
    tags: [], status: "validated",
  } as unknown as Claim;
}

const HL = 90 * 86_400_000;
const T = 10_000_000_000;

describe("rankBlendConf", () => {
  const survivors = [
    mk("a", "alpha trip vegas", T - HL, 0.05),
    mk("b", "beta trip paris", T - 10 * HL, 0.95),
    mk("c", "gamma hotel", T - 2 * HL, 0.5),
  ];

  it("wConf=0 is byte-identical to bench rankBlend (identity gate)", () => {
    const query = "trip";
    for (const alpha of [1, 0.5, 0]) {
      const base = rankBlend(survivors, query, { alpha, halfLifeMs: HL, t: T });
      const conf = rankBlendConf(survivors, query, { alpha, halfLifeMs: HL, wConf: 0, t: T });
      expect(conf.map((x) => x.id)).toEqual(base.map((x) => x.id));
    }
  });

  it("wConf>0 lets a high-confidence claim outrank on confidence alone", () => {
    // wConf=1 → pure confidence → "b" (conf 0.95) ranks first.
    const out = rankBlendConf(survivors, "zzz", { alpha: 0.5, halfLifeMs: HL, wConf: 1, t: T });
    expect(out[0].id).toBe("b");
  });

  it("is deterministic", () => {
    const a = rankBlendConf(survivors, "trip", { alpha: 0.5, halfLifeMs: HL, wConf: 0.3, t: T });
    const b = rankBlendConf(survivors, "trip", { alpha: 0.5, halfLifeMs: HL, wConf: 0.3, t: T });
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
  });
});
