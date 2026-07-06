/**
 * Golden fixture: pins the FULL post-Phase-1 RecallResult (including the
 * warnings array ORDER: alias -> coverage -> cardinality) before the Phase 2
 * restructure (spec Sec 5/Sec 8.6, amendment A2 binding).
 *
 * Workflow followed: build the fixture, run it ONCE, pin the observed literal
 * as GOLDEN (not hand-guessed). `jaccardDeps` is a const — passed bare.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { recall, type RecallResult } from "./recall.js";
import { remember } from "./remember.js";
import { makeSpySession, jaccardDeps } from "./test-support.js";

const CORPUS = "golden-corpus";
const T0 = Date.parse("2026-01-01T00:00:00Z");
const ASOF = T0 + 100_000;

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Seeds the three-warning fixture (task-golden-pin recipe):
 *
 *  1. Alias-loader warning (deterministic trigger chosen from key-alias.ts's
 *     aliasMapOf): ONE alias-shaped claim, subject "key:variant", key
 *     "alias-of", value "alias-of" — the canonical value equals the alias key
 *     name itself, which aliasMapOf flags via its
 *     `meta-alias detected: canonical "..." ... is the alias key name` branch.
 *     Chosen over the cycle/tie variants because it fires from a SINGLE claim
 *     with no second write needed to force the collision.
 *
 *  2. Coverage warning — about: "status Budget". entityTokensOf only extracts
 *     capitalized/number-bearing tokens (retrieval/coverage.ts heuristic), so
 *     lowercase "status" is not an entity at all; "Budget" (capitalized) IS
 *     extracted, and no claim mentions "budget" -> the
 *     "question entities with no claim available to this recall: 'Budget'"
 *     warning fires.
 *
 *  3. Cardinality warning — two claims on (subject:"svc", key:"status") with
 *     token-dissimilar values ("green light everywhere" vs "totally broken
 *     outage" — zero shared tokens, jaccard=0 < the 0.5 ⊕_dedupe cutoff), so
 *     dedupe does NOT merge them. "status" cardinality is left UNDECLARED
 *     (cardinalityOf defaults undeclared keys to "single"), so the pre-⊥
 *     safety check flags the (subject,key) collision. The recall is scoped
 *     `key: "status"` so both claims are inside the σ scope.
 *
 * Claim ids: crypto.randomUUID is stubbed (deterministic sequential ids) so
 * the pinned GOLDEN.matches[].id is stable across runs.
 */
function seedGoldenFixture(session: ReturnType<typeof makeSpySession>["session"]): void {
  const iso = (ms: number) => new Date(ms).toISOString();

  // 1. Meta-alias loader warning.
  remember(session, {
    subject: "key:variant",
    key: "alias-of",
    value: "alias-of",
    corpus: CORPUS,
    validFrom: iso(T0),
  });

  // 2 + 3. Two "status" claims — token-dissimilar values, undeclared cardinality.
  remember(session, {
    subject: "svc",
    key: "status",
    value: "green light everywhere",
    corpus: CORPUS,
    validFrom: iso(T0),
  });
  remember(session, {
    subject: "svc",
    key: "status",
    value: "totally broken outage",
    corpus: CORPUS,
    validFrom: iso(T0 + 1_000),
  });
}

/** Classifies a warning string by which of the three checks emitted it —
 *  used ONLY to assert the pinned GOLDEN.warnings ORDER, not to derive it. */
function kindOf(w: string): "alias" | "coverage" | "cardinality" {
  if (w.includes("no claim available to this recall")) return "coverage";
  if (w.includes("single-cardinality")) return "cardinality";
  return "alias";
}

describe("recall — golden fixture (post-Phase-1 RecallResult, pinned before Phase 2)", () => {
  it("golden: full RecallResult bytes for the three-warning fixture", async () => {
    let seq = 0;
    vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(
      () => `00000000-0000-0000-0000-${String(seq++).padStart(12, "0")}` as `${string}-${string}-${string}-${string}-${string}`,
    );

    const { session } = makeSpySession();
    seedGoldenFixture(session);

    const res = await recall(
      session,
      { about: "status Budget", corpus: CORPUS, key: "status", asOf: ASOF },
      jaccardDeps,
    );

    expect(res.warnings?.length).toBe(3);
    expect(res).toEqual(GOLDEN);
  });

  it("warnings order is alias -> coverage -> cardinality", () => {
    expect(GOLDEN.warnings!.map(kindOf)).toEqual(["alias", "coverage", "cardinality"]);
  });
});

// Captured by running the fixture ONCE and pinning the observed output
// verbatim (task-golden-pin workflow) — do not hand-edit. If recall.ts's
// Phase 2 restructure intentionally changes this shape, re-run and re-pin.
const GOLDEN: RecallResult = {
  corpus: "golden-corpus",
  content: "- totally broken outage",
  matches: [
    {
      subject: "svc",
      key: "status",
      value: "totally broken outage",
      confidence: 1,
      score: 0.4999955876242226,
      id: "00000000-0000-0000-0000-000000000002",
      tags: [],
    },
  ],
  topScore: 0.4999955876242226,
  abstained: false,
  rankFn: "jaccard",
  coverage: {
    entities: [{ text: "Budget", supported: false }],
    missing: ["Budget"],
  },
  warnings: [
    'meta-alias detected: canonical "alias-of" for variant "variant" is the alias key name — dropped',
    "question entities with no claim available to this recall: 'Budget'",
    'single-cardinality (subject:svc, key:status) holds 2 distinct values — recall serves only the latest; declare keyCardinality:"multi" if they should coexist.',
  ],
};
