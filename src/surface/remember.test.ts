import { describe, it, expect, vi } from "vitest";
import { recall } from "./recall.js";
import {
  remember,
  listCorpora,
  ensureCorpus,
  ensureCorpusAsync,
  rememberAsync,
  type AsyncRememberSource,
} from "./remember.js";
import { freshSession, jaccardDeps } from "./test-support.js";
import type { Session } from "./types.js";
import type { ExecutionPlan } from "../adapters/adapter-types.js";
import type { ClaimId } from "../core/ids.js";
import type { Claim, CandidateClaim, CorpusDef } from "../index.js";

// ── Existing behaviour (minimal churn) ────────────────────────────────────────

describe("mcp tools — existing behaviour", () => {
  it("remember auto-creates the corpus and commits a claim", () => {
    const s = freshSession();
    const r = remember(s, { subject: "project:mneme", key: "decision", value: "dogfood via MCP", corpus: "dev" });
    expect(r.status).toBe("committed");
    expect(r.corpus).toBe("dev");
    expect(listCorpora(s).corpora.map((c) => c.id)).toContain("dev");
  });

  it("listCorpora reflects created corpora", () => {
    const s = freshSession();
    ensureCorpus(s, "c1");
    ensureCorpus(s, "c2");
    expect(listCorpora(s).corpora.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
  });
});

// ── remember: scope + validFrom ───────────────────────────────────────────────

describe("remember — scope and validFrom", () => {
  it("validFrom sets valid.from (recalled claim has correct temporal interval)", async () => {
    const s = freshSession();
    const corpus = "vf-corpus";
    remember(s, {
      subject: "user:brett",
      key: "editor",
      value: "helix",
      corpus,
      validFrom: "2026-03-01T00:00:00Z",
    });
    // The claim should be retrievable at query time (now > 2026-03-01)
    const r = await recall(s, { about: "editor", corpus }, jaccardDeps);
    expect(r.matches.length).toBe(1);
    expect(r.matches[0].value).toBe("helix");
  });

  it("invalid validFrom ISO string throws a descriptive error", () => {
    const s = freshSession();
    expect(() =>
      remember(s, {
        subject: "user:brett",
        key: "editor",
        value: "helix",
        corpus: "err-corpus",
        validFrom: "not-a-date",
      }),
    ).toThrowError(/validFrom/);
  });

  it("scope round-trips through write (new corpus has default scopeFields)", async () => {
    const s = freshSession();
    const corpus = "scope-corpus";
    // ensureCorpus is called by remember — it should declare default scopeFields
    remember(s, {
      subject: "user:brett",
      key: "editor",
      value: "helix",
      corpus,
      scope: { project: "mneme" },
    });
    // Verify the corpus was created with scopeFields
    const corpusDef = s.inspectCorpus(corpus) as { schema?: { scopeFields?: Record<string, string> } } | undefined;
    expect(corpusDef?.schema?.scopeFields).toMatchObject({
      project: "string",
      person: "string",
      context: "string",
    });
    // The claim should still be retrievable
    const r = await recall(s, { about: "editor", corpus }, jaccardDeps);
    expect(r.matches.length).toBe(1);
  });

  it("both scope and validFrom optional → today's behaviour unchanged", () => {
    const s = freshSession();
    const r = remember(s, { subject: "s", key: "k", value: "v", corpus: "plain-corpus" });
    expect(r.status).toBe("committed");
  });
});

// ── ensureCorpus: default scopeFields ────────────────────────────────────────

// ── remember: supersession outcome ────────────────────────────────────────────

describe("remember — supersession outcome", () => {
  it("remember reports superseding an older single-cardinality value", () => {
    const s = freshSession();
    s.createCorpus({ id: "c", keyCardinality: { plan: "single" } });
    remember(s, { subject: "p", key: "plan", value: "alpha", corpus: "c", validFrom: "2026-01-01T00:00:00Z" });
    const r = remember(s, { subject: "p", key: "plan", value: "bravo", corpus: "c", validFrom: "2026-02-01T00:00:00Z" });
    expect(r.supersession?.action).toBe("superseded");
    expect(r.supersession?.deprecatedIds.length).toBeGreaterThan(0);
    s.close();
  });

  it("remember reports committed for a coexisting multi-cardinality write", () => {
    const s = freshSession();
    s.createCorpus({ id: "c2", keyCardinality: { tag: "multi" } });
    remember(s, { subject: "p", key: "tag", value: "alpha", corpus: "c2", validFrom: "2026-01-01T00:00:00Z" });
    const r = remember(s, { subject: "p", key: "tag", value: "bravo", corpus: "c2", validFrom: "2026-02-01T00:00:00Z" });
    expect(r.supersession?.action).toBe("committed");
    s.close();
  });
});

describe("ensureCorpus — default scopeFields for new corpora", () => {
  it("new corpus gets project/person/context scopeFields", () => {
    const s = freshSession();
    ensureCorpus(s, "scope-test");
    const def = s.inspectCorpus("scope-test") as { schema?: { scopeFields?: Record<string, string> } } | undefined;
    expect(def?.schema?.scopeFields).toMatchObject({
      project: "string",
      person: "string",
      context: "string",
    });
  });

  it("ensureCorpus is idempotent (calling twice does not throw)", () => {
    const s = freshSession();
    expect(() => {
      ensureCorpus(s, "idem-corpus");
      ensureCorpus(s, "idem-corpus");
    }).not.toThrow();
  });
});

// ── async twins (task-remember-async) ────────────────────────────────────────

/** Wraps a Session's `mneme` facade in the `AsyncRememberSource` seam
 *  rememberAsync/ensureCorpusAsync expect — awaited reads/writes over the SAME sync store. */
function asyncMnemeOver(s: Session): AsyncRememberSource {
  return {
    listCorpora: (f?: (c: { id: string }) => boolean) => s.mneme.listCorpora(f),
    read: async (c: string, p: ExecutionPlan): Promise<Claim[]> => s.mneme.read(c, p),
    readByIds: async (c: string, ids: ClaimId[]): Promise<Claim[]> => s.mneme.readByIds(c, ids),
    createCorpus: (def: CorpusDef): CorpusDef => s.mneme.createCorpus(def),
    commit: async (c: string, candidate: CandidateClaim, opts: { writer: string; idempotencyKey?: string }) =>
      s.mneme.commit(c, candidate, opts),
  };
}

/** UUID stub helper (recall-golden.test.ts pattern): sequential deterministic ids, reset the
 *  counter before each store's writes (B3) so parity comparisons don't diverge on id text. */
function stubRandomUuid(): { seq: number; restore: () => void } {
  const state = { seq: 0 };
  const spy = vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(
    () =>
      `00000000-0000-0000-0000-${String(state.seq++).padStart(12, "0")}` as `${string}-${string}-${string}-${string}-${string}`,
  );
  return { seq: state.seq, restore: () => spy.mockRestore() };
}

describe("ensureCorpusAsync", () => {
  it("creates once with the sync-default scopeFields", () => {
    const s = freshSession();
    ensureCorpusAsync(asyncMnemeOver(s), "async-scope-test");
    const def = s.inspectCorpus("async-scope-test") as
      | { schema?: { scopeFields?: Record<string, string> } }
      | undefined;
    expect(def?.schema?.scopeFields).toMatchObject({
      project: "string",
      person: "string",
      context: "string",
    });
    s.close();
  });

  it("second call with a DIFFERENT spec is a no-op (first-declaration-wins)", () => {
    const s = freshSession();
    const mneme = asyncMnemeOver(s);
    ensureCorpusAsync(mneme, "fdw-corpus");
    ensureCorpusAsync(mneme, "fdw-corpus", { scopeFields: { other: "string" } });
    const def = s.inspectCorpus("fdw-corpus") as
      | { schema?: { scopeFields?: Record<string, string> } }
      | undefined;
    expect(def?.schema?.scopeFields).toMatchObject({
      project: "string",
      person: "string",
      context: "string",
    });
    expect(def?.schema?.scopeFields?.other).toBeUndefined();
    s.close();
  });

  it("pseudocount validation throws via corpusDefFromSpec (exact error text)", () => {
    const s = freshSession();
    const mneme = asyncMnemeOver(s);
    expect(() =>
      ensureCorpusAsync(mneme, "bad-pseudocount", { scalarPseudocount: { manual: -1 } }),
    ).toThrowError('invalid scalarPseudocount for source "manual": -1 (must be a finite number >= 0)');
    s.close();
  });
});

describe("rememberAsync", () => {
  it("invalid validFrom throws the exact sync error text", async () => {
    const s = freshSession();
    const mneme = asyncMnemeOver(s);
    await expect(
      rememberAsync(mneme, {
        subject: "user:brett",
        key: "editor",
        value: "helix",
        corpus: "async-err-corpus",
        validFrom: "not-a-date",
      }),
    ).rejects.toThrowError('remember: validFrom "not-a-date" is not a valid ISO-8601 date string');
    s.close();
  });

  it("duplicates get supersession: undefined (B6 gate asserted)", async () => {
    // A fake source that reports a "duplicate" write outcome directly — exercises the B6
    // gate (attribution only fires for status==="committed") without depending on the
    // idempotencyKey machinery that produces "duplicate" in the real store. readByIds
    // returns a real, attributable claim (not a throw) — if the B6 gate did NOT skip
    // attribution for a non-committed status, supersession would come back DEFINED
    // ("committed", since the group has only this one claim), not undefined; a throw
    // here would let the best-effort try/catch mask a missing gate, which this must not.
    let readByIdsCalled = false;
    const claim = {
      id: "dup-id",
      subject: "p",
      key: "k",
      value: "v",
      scopeHash: "",
      valueHash: "",
    } as unknown as Claim;
    const fakeSource: AsyncRememberSource = {
      listCorpora: () => [{ id: "c" }],
      read: async () => [claim],
      readByIds: async () => {
        readByIdsCalled = true;
        return [claim];
      },
      createCorpus: (def: CorpusDef) => def,
      commit: async () => ({ id: "dup-id", status: "duplicate" }),
    };
    const r = await rememberAsync(fakeSource, {
      subject: "p",
      key: "k",
      value: "v",
      corpus: "c",
    });
    expect(r.status).toBe("duplicate");
    expect(r.supersession).toBeUndefined();
    expect(readByIdsCalled).toBe(false); // B6 gate: attribution never attempted for non-committed status
  });

  it("attribution failure never fails the write (inject a throwing readByIds)", async () => {
    const s = freshSession();
    s.createCorpus({ id: "attr-fail-corpus" });
    const mneme = asyncMnemeOver(s);
    const throwingMneme: AsyncRememberSource = {
      ...mneme,
      readByIds: async () => {
        throw new Error("readByIds boom");
      },
    };
    const r = await rememberAsync(throwingMneme, {
      subject: "p",
      key: "k",
      value: "v",
      corpus: "attr-fail-corpus",
    });
    expect(r.status).toBe("committed");
    expect(r.supersession).toBeUndefined();
    s.close();
  });

  it("rememberAsync over asyncified store equals sync remember (status + supersession)", async () => {
    // Store 1: sync remember, over a fresh single-cardinality corpus.
    const uuid1 = stubRandomUuid();
    const s1 = freshSession();
    s1.createCorpus({ id: "parity-c", keyCardinality: { plan: "single" } });
    remember(s1, {
      subject: "p",
      key: "plan",
      value: "alpha",
      corpus: "parity-c",
      validFrom: "2026-01-01T00:00:00Z",
    });
    const r1 = remember(s1, {
      subject: "p",
      key: "plan",
      value: "bravo",
      corpus: "parity-c",
      validFrom: "2026-02-01T00:00:00Z",
    });
    uuid1.restore();
    s1.close();

    // Store 2: rememberAsync over the async seam, same shape, per-store id reset.
    const uuid2 = stubRandomUuid();
    const s2 = freshSession();
    s2.createCorpus({ id: "parity-c", keyCardinality: { plan: "single" } });
    const mneme2 = asyncMnemeOver(s2);
    await rememberAsync(mneme2, {
      subject: "p",
      key: "plan",
      value: "alpha",
      corpus: "parity-c",
      validFrom: "2026-01-01T00:00:00Z",
    });
    const r2 = await rememberAsync(mneme2, {
      subject: "p",
      key: "plan",
      value: "bravo",
      corpus: "parity-c",
      validFrom: "2026-02-01T00:00:00Z",
    });
    uuid2.restore();
    s2.close();

    expect({ status: r2.status, supersession: r2.supersession }).toEqual({
      status: r1.status,
      supersession: r1.supersession,
    });
  });
});
