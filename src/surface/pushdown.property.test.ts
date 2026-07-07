/**
 * Differential property (spec Sec 8.3, amendment A3): with a pinned `asOf`, recall/explain
 * results must be byte-equal with hints reaching the adapter vs. hints stripped. Hints-off
 * is `makeSpySession({ transformPlan: (p) => ({ corpusId: p.corpusId }) })` — the identical
 * code path recall()/explainRecall() already exercise, no reconstruction of recall internals.
 *
 * Plan-stripping is semantics-safe even for the alias read: `aliasMapOf` self-filters
 * alias-shaped claims regardless of what the adapter physically returned.
 *
 * Determinism: claim ids come from crypto.randomUUID at commit time. The two arms are
 * TWO SEPARATE sessions seeded with the same logical claims in the same order — stubbing
 * randomUUID with a resettable sequential counter (reset before seeding EACH session)
 * makes both sessions mint IDENTICAL id sequences, giving true byte-equality (including
 * `RecallMatch.id`). `valid.from` is pinned via the arbitrary (explicit ISO validFrom on
 * every write); recordedSeq falls out of write order, which is identical across arms
 * because seeding happens in the same array order for both sessions.
 *
 * Naming follows the repo's only property suites (src/distribution/*.property.test.ts).
 */
import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import { recall, type RecallArgs } from "./recall.js";
import { explainRecall } from "./explain.js";
import { remember } from "./remember.js";
import { makeSpySession, jaccardDeps } from "./test-support.js";
import { KEY_ALIAS_KEY } from "../retrieval/key-alias.js";
import type { Session } from "./types.js";

const CORPUS = "pushdown-prop";
const T0 = Date.parse("2026-01-01T00:00:00Z");
const RUNS = 100;

// ── Small, deterministic vocabulary — the differential cares about arm-parity, not about
// covering every value/entity shape (that's recall.test.ts / recall-golden.test.ts's job).
const SUBJECTS = ["s0", "s1", "s2"];
const CANON_KEYS = ["k0", "k1"];
const VARIANT_KEY = "k0v"; // candidate alias variant of "k0"
const VALUES = ["alpha", "beta", "gamma"];

interface ClaimSpec {
  subject: string;
  key: string;
  value: string;
  validFromOffset: number; // ms offset from (T0 - 5000); some land before, some after T0
}

interface CorpusSpec {
  claims: ClaimSpec[];
  declareAlias: boolean; // whether to write a "k0v" -> "k0" alias claim
}

const claimArb: fc.Arbitrary<ClaimSpec> = fc.record({
  subject: fc.constantFrom(...SUBJECTS),
  key: fc.constantFrom(...CANON_KEYS, VARIANT_KEY),
  value: fc.constantFrom(...VALUES),
  validFromOffset: fc.integer({ min: 0, max: 10_000 }),
});

const corpusArb: fc.Arbitrary<CorpusSpec> = fc.record({
  claims: fc.array(claimArb, { minLength: 0, maxLength: 8 }),
  declareAlias: fc.boolean(),
});

type SubjectSel = "s0" | "s1" | "s2" | "none";
type KeySel = "k0" | "k1" | "k0v" | "none";

interface RecallArgsSpec {
  about: string;
  subjectSel: SubjectSel;
  keySel: KeySel;
  limit: number;
  recencyAlpha: 0 | 0.5 | 1;
}

const recallArgsArb: fc.Arbitrary<RecallArgsSpec> = fc.record({
  about: fc.constantFrom(...VALUES, "other"),
  subjectSel: fc.constantFrom<SubjectSel>("s0", "s1", "s2", "none"),
  keySel: fc.constantFrom<KeySel>("k0", "k1", "k0v", "none"),
  limit: fc.integer({ min: 1, max: 10 }),
  recencyAlpha: fc.constantFrom<0 | 0.5 | 1>(0, 0.5, 1),
});

function toArgs(spec: RecallArgsSpec): RecallArgs {
  const args: RecallArgs = {
    about: spec.about,
    corpus: CORPUS,
    asOf: T0,
    limit: spec.limit,
    recencyAlpha: spec.recencyAlpha,
  };
  if (spec.subjectSel !== "none") args.subject = spec.subjectSel;
  if (spec.keySel !== "none") args.key = spec.keySel;
  return args;
}

function seedCorpus(session: Session, corpus: CorpusSpec): void {
  for (const c of corpus.claims) {
    remember(session, {
      subject: c.subject,
      key: c.key,
      value: c.value,
      corpus: CORPUS,
      validFrom: new Date(T0 - 5000 + c.validFromOffset).toISOString(),
    });
  }
  if (corpus.declareAlias) {
    remember(session, {
      subject: `key:${VARIANT_KEY}`,
      key: KEY_ALIAS_KEY,
      value: "k0",
      corpus: CORPUS,
      validFrom: new Date(T0 - 5000).toISOString(),
    });
  }
}

/** Stub crypto.randomUUID with a resettable sequential counter so two separately-seeded
 *  sessions (same logical claims, same write order) mint IDENTICAL id sequences. */
function withDeterministicIds<T>(fn: (reset: () => void) => Promise<T>): Promise<T> {
  let seq = 0;
  const spy = vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(
    () => `00000000-0000-0000-0000-${String(seq++).padStart(12, "0")}` as `${string}-${string}-${string}-${string}-${string}`,
  );
  const reset = () => {
    seq = 0;
  };
  return fn(reset).finally(() => spy.mockRestore());
}

describe("pushdown differential — recall/explainRecall byte-equal with hints on vs. stripped", () => {
  it("recall is byte-equal with hints on vs hints stripped (pinned asOf)", async () => {
    await withDeterministicIds(async (reset) => {
      await fc.assert(
        fc.asyncProperty(corpusArb, recallArgsArb, async (corpusSpec, argsSpec) => {
          const on = makeSpySession();
          const off = makeSpySession({ transformPlan: (p) => ({ corpusId: p.corpusId }) });
          try {
            reset();
            seedCorpus(on.session, corpusSpec);
            reset();
            seedCorpus(off.session, corpusSpec);

            const args = toArgs(argsSpec);
            const full = await recall(on.session, args, jaccardDeps);
            const stripped = await recall(off.session, args, jaccardDeps);
            expect(stripped).toEqual(full);
          } finally {
            on.session.close();
            off.session.close();
          }
        }),
        { numRuns: RUNS },
      );
    });
  });

  it("explainRecall is byte-equal with hints on vs hints stripped (pinned asOf)", async () => {
    await withDeterministicIds(async (reset) => {
      await fc.assert(
        fc.asyncProperty(corpusArb, recallArgsArb, async (corpusSpec, argsSpec) => {
          const on = makeSpySession();
          const off = makeSpySession({ transformPlan: (p) => ({ corpusId: p.corpusId }) });
          try {
            reset();
            seedCorpus(on.session, corpusSpec);
            reset();
            seedCorpus(off.session, corpusSpec);

            const args = toArgs(argsSpec);
            const full = await explainRecall(on.session, args, jaccardDeps);
            const stripped = await explainRecall(off.session, args, jaccardDeps);
            expect(stripped).toEqual(full);
          } finally {
            on.session.close();
            off.session.close();
          }
        }),
        { numRuns: RUNS },
      );
    });
  });
});

describe("pushdown — hydration smoke", () => {
  /** 50 claims total: `matching` of them on (s0,k0), the rest spread across distinct
   *  (subject,key) pairs that never collide with (s0,k0). */
  function mixedCorpus(total: number, matching: number): ClaimSpec[] {
    const claims: ClaimSpec[] = [];
    for (let i = 0; i < matching; i++) {
      claims.push({ subject: "s0", key: "k0", value: `match-${i}`, validFromOffset: i });
    }
    for (let i = matching; i < total; i++) {
      claims.push({ subject: `other-${i}`, key: `otherkey-${i}`, value: `noise-${i}`, validFromOffset: i });
    }
    return claims;
  }

  it("a (subject,key)-scoped recall hydrates only matching rows", async () => {
    const { session, rowsHydrated } = makeSpySession();
    seedCorpus(session, { claims: mixedCorpus(50, 5), declareAlias: false });
    const match = (p: { key?: string }) => p.key !== KEY_ALIAS_KEY;
    // Baseline BEFORE calling recall(): writes (via remember()'s supersessionOutcome
    // attribution) issue their own unrelated reads — isolate recall()'s own hydration
    // by delta, mirroring recall.test.ts's `const before = plansSeen.length` precedent.
    const before = rowsHydrated(match);
    await recall(session, { about: "q", corpus: CORPUS, subject: "s0", key: "k0", asOf: T0 }, jaccardDeps);
    const after = rowsHydrated(match);
    // task-recall-core: recall() now issues ONE hint-carrying shared-prefix storage read
    // (`corpusOf(await source.read(...))` — no more separate `mneme.query` pipeline
    // evaluations); the cardinality-safety check and the ranked result both derive from
    // that SAME read in-memory, no further adapter I/O. Bound at 2x the matching-row
    // count is generous headroom over the single-read reality — was ~100 (2 x 50,
    // full-corpus scan) before hint pushdown.
    expect(after - before).toBeLessThanOrEqual(10);
  });
});
