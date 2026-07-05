import { createMnemeAsync } from "./mneme-async.js";
import { leafAsync } from "./algebra/async-expression.js";
import type { AsyncStorageAdapter } from "./adapters/async-adapter.js";
import type {
  AdapterCapabilities,
  AdapterScope,
  ClaimEvent,
  ExecutionPlan,
  IdempotencyRecord,
} from "./adapters/adapter-types.js";
import type { Claim } from "./core/claim.js";
import type { ClaimId } from "./core/ids.js";
import type { Corpus as AlgCorpus } from "./algebra/types.js";
import type { Corpus as CorpusDef } from "./catalog/corpus.js";
import type { ClaimSchema } from "./catalog/schema.js";

/**
 * Minimal Map-backed fake AsyncStorageAdapter (no Docker, no sqlite) — just enough
 * of the contract for createMnemeAsync's commit/query round trip: insert/get/delete,
 * a corpusId/subject/key/status/scopeHash-filtering query, idempotency records,
 * a no-op transaction wrapper, a corpus-scoped maxRecordedSeq, and a `scoped()`
 * view that forces the bound corpus on every write/read (mirrors sqlite.ts's base
 * capability shape and scoped() semantics).
 */
function createFakeAsyncAdapter(): AsyncStorageAdapter {
  const claims = new Map<string, Claim>();
  const idempotency = new Map<string, IdempotencyRecord>();
  const events: ClaimEvent[] = [];

  function matches(c: Claim, plan: ExecutionPlan, force?: AdapterScope): boolean {
    if (force !== undefined && c.corpusId !== force.corpus) return false;
    if (force === undefined && plan.corpusId !== undefined && c.corpusId !== plan.corpusId) return false;
    if (plan.subject !== undefined && c.subject !== plan.subject) return false;
    if (plan.key !== undefined && c.key !== plan.key) return false;
    if (plan.scopeHash !== undefined && c.scopeHash !== plan.scopeHash) return false;
    if (plan.status !== undefined && plan.status.length > 0 && !plan.status.includes(c.status)) return false;
    return true;
  }

  function executeQuery(plan: ExecutionPlan, force?: AdapterScope): Claim[] {
    return [...claims.values()].filter((c) => matches(c, plan, force));
  }

  function capabilities(): AdapterCapabilities {
    return {
      valuePredicateSupport: {
        equality: "fallback_in_memory",
        range: "fallback_in_memory",
        set_membership: "fallback_in_memory",
        regex: "fallback_in_memory",
        structural_pattern: "fallback_in_memory",
        null_check: "fallback_in_memory",
      },
    };
  }

  const base: AsyncStorageAdapter = {
    async insertClaim(c: Claim): Promise<void> {
      claims.set(c.id, c);
    },
    async getClaim(id: ClaimId): Promise<Claim | undefined> {
      return claims.get(id);
    },
    async deleteClaim(id: ClaimId): Promise<void> {
      const c = claims.get(id);
      if (c) claims.set(id, { ...c, status: "deprecated" });
    },
    async insertBatch(cs: Claim[]): Promise<void> {
      for (const c of cs) claims.set(c.id, c);
    },
    async query(plan: ExecutionPlan): Promise<Claim[]> {
      return executeQuery(plan, undefined);
    },
    async getIdempotencyRecord(scope: string, key: string): Promise<IdempotencyRecord | undefined> {
      return idempotency.get(`${scope}::${key}`);
    },
    async putIdempotencyRecord(scope: string, key: string, rec: IdempotencyRecord): Promise<void> {
      idempotency.set(`${scope}::${key}`, rec);
    },
    capabilities,
    async transaction<T>(_corpusId: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async maxRecordedSeq(corpusId: string): Promise<number> {
      let max = 0;
      for (const c of claims.values()) {
        if (c.corpusId === corpusId && c.recordedSeq > max) max = c.recordedSeq;
      }
      return max;
    },
    async appendEvent(e: ClaimEvent): Promise<void> {
      events.push(e);
    },
    async readEvents(filter?: { corpusId?: string; claimId?: string; since?: number }): Promise<ClaimEvent[]> {
      return events.filter(
        (e) =>
          (filter?.corpusId === undefined || e.corpusId === filter.corpusId) &&
          (filter?.claimId === undefined || e.claimId === filter.claimId) &&
          (filter?.since === undefined || e.recorded >= filter.since)
      );
    },
    scoped(scope: AdapterScope): AsyncStorageAdapter {
      return {
        ...base,
        async insertClaim(c: Claim): Promise<void> {
          claims.set(c.id, { ...c, corpusId: scope.corpus as Claim["corpusId"] });
        },
        async insertBatch(cs: Claim[]): Promise<void> {
          for (const c of cs) claims.set(c.id, { ...c, corpusId: scope.corpus as Claim["corpusId"] });
        },
        async query(plan: ExecutionPlan): Promise<Claim[]> {
          return executeQuery(plan, scope);
        },
        async deleteClaim(id: ClaimId): Promise<void> {
          const c = claims.get(id);
          if (c && c.corpusId === scope.corpus) claims.set(id, { ...c, status: "deprecated" });
        },
        async getClaim(id: ClaimId): Promise<Claim | undefined> {
          const c = claims.get(id);
          if (!c || c.corpusId !== scope.corpus) return undefined;
          return c;
        },
        capabilities,
      };
    },
  };

  return base;
}

const schema: ClaimSchema = {
  version: "1",
  subjects: ["fixture:async"],
  scopeFields: {},
  required: [],
  scalarPseudocount: { manual: 2 },
};

const corpusDef: CorpusDef = {
  id: "fixture:async",
  displayName: "Async Fixture Corpus",
  schema,
  defaults: {
    decayPolicy: { kind: "none" },
    confidenceThreshold: 0.5,
    contradictionPolicy: { kind: "always_accept" },
    defaultStatus: ["validated"],
  },
  requiredTiers: [{ kind: "core" }],
  metadata: {},
  createdAt: 0,
  updatedAt: 0,
};

function makeCandidate() {
  return {
    profile: "profile-1" as any,
    workspace: "fixture:async" as any,
    subject: "async-block",
    key: "schema",
    scope: {},
    value: "async round trip value",
    confidence: { distribution: "beta" as const, parameters: { alpha: 9, beta: 1 }, raw: 0.9 },
    valid: { from: 0, to: Infinity },
    source: "manual" as const,
    provenance: {},
    evidence: [],
    tags: [],
    schema: "fixture:async@1",
  };
}

it("createCorpus + commit + query round-trips the committed claim id", async () => {
  const adapter = createFakeAsyncAdapter();
  const m = createMnemeAsync({ adapter, availableTiers: [{ kind: "core" }] });

  m.createCorpus(corpusDef);

  const result = await m.commit("fixture:async", makeCandidate(), { writer: "test-writer" });
  expect(result.status).toBe("committed");

  const corpus = await m.query<AlgCorpus>("fixture:async", [leafAsync("fixture:async")]);
  expect(corpus.claims.map((c) => c.id)).toContain(result.id);
  expect(corpus.claims[0].value).toBe("async round trip value");
});

it("does not expose replay or derive", () => {
  const adapter = createFakeAsyncAdapter();
  const m = createMnemeAsync({ adapter, availableTiers: [{ kind: "core" }] });
  expect((m as any).replay).toBeUndefined();
  expect((m as any).derive).toBeUndefined();
});

it("commit rejects an unknown corpus", async () => {
  const adapter = createFakeAsyncAdapter();
  const m = createMnemeAsync({ adapter, availableTiers: [{ kind: "core" }] });
  await expect(
    m.commit("no-such-corpus", makeCandidate(), { writer: "test-writer" })
  ).rejects.toThrow(/unknown corpus/);
});

it("promoteStaged commits a previously emitted candidate via the async pipeline", async () => {
  const adapter = createFakeAsyncAdapter();
  const m = createMnemeAsync({ adapter, availableTiers: [{ kind: "core" }] });
  m.createCorpus(corpusDef);

  const { stagingId } = m.emitCandidate("fixture:async", makeCandidate());
  const result = await m.promoteStaged(stagingId, { writer: "test-writer" });

  expect(result.status).toBe("committed");
  const claims = await m.readByIds("fixture:async", [result.id as ClaimId]);
  expect(claims).toHaveLength(1);
});

// ── wiring-level coverage: supersede / promote / commitBatch / promoteAllStaged ──
// (mirrors src/mneme.test.ts's sync equivalents — the underlying AsyncPromoter logic
// is exercised in async-pipeline.test.ts; these verify mneme-async.ts's glue: corpus
// existence checks, policy defaulting, opts forwarding, and takeAllStaged→commitBatch.)

it("supersede deprecates the named claim and commits the replacement through the async surface", async () => {
  const adapter = createFakeAsyncAdapter();
  const m = createMnemeAsync({ adapter, availableTiers: [{ kind: "core" }] });
  m.createCorpus(corpusDef);

  const original = await m.commit("fixture:async", makeCandidate(), { writer: "test-writer" });
  expect(original.status).toBe("committed");

  const result = await m.supersede(
    "fixture:async",
    original.id,
    { ...makeCandidate(), value: "replacement value" },
    { writer: "test-writer" }
  );

  expect(result.status).toBe("superseded");
  expect(typeof result.id).toBe("string");
  expect(result.id).not.toBe(original.id);

  const [oldClaim] = await m.readByIds("fixture:async", [original.id as ClaimId]);
  expect(oldClaim?.status).toBe("deprecated");

  const [newClaim] = await m.readByIds("fixture:async", [result.id as ClaimId]);
  expect(newClaim?.value).toBe("replacement value");
});

it("promote transitions a claim's status forward through the async surface", async () => {
  const adapter = createFakeAsyncAdapter();
  const m = createMnemeAsync({ adapter, availableTiers: [{ kind: "core" }] });
  m.createCorpus(corpusDef);

  const committed = await m.commit(
    "fixture:async",
    { ...makeCandidate(), status: "candidate" },
    { writer: "test-writer" }
  );
  expect(committed.status).toBe("committed");

  const result = await m.promote("fixture:async", committed.id, "validated", {
    writer: "test-writer",
    reason: "approved by reviewer",
  });

  expect(result.status).toBe("promoted");
  expect(result.id).toBe(committed.id);

  const [promotedClaim] = await m.readByIds("fixture:async", [committed.id as ClaimId]);
  expect(promotedClaim?.status).toBe("validated");
});

it("commitBatch returns a BatchResult with per-item statuses", async () => {
  const adapter = createFakeAsyncAdapter();
  const m = createMnemeAsync({ adapter, availableTiers: [{ kind: "core" }] });
  m.createCorpus(corpusDef);

  const res = await m.commitBatch(
    "fixture:async",
    [
      { ...makeCandidate(), subject: "s1" },
      { ...makeCandidate(), subject: "s2" },
    ],
    { writer: "test-writer" }
  );

  expect(res.results).toHaveLength(2);
  expect(res.results.map((r) => r.index)).toEqual([0, 1]);
  expect(res.results.every((r) => r.status === "committed")).toBe(true);
});

it("promoteAllStaged drains the staging buffer and returns a BatchResult", async () => {
  const adapter = createFakeAsyncAdapter();
  const m = createMnemeAsync({ adapter, availableTiers: [{ kind: "core" }] });
  m.createCorpus(corpusDef);

  m.emitCandidate("fixture:async", { ...makeCandidate(), subject: "sA" });
  m.emitCandidate("fixture:async", { ...makeCandidate(), subject: "sB" });

  const res = await m.promoteAllStaged("fixture:async", { writer: "test-writer" });

  expect(res.results).toHaveLength(2);
  expect(res.results.every((r) => r.status === "committed")).toBe(true);
  expect(m.listStaged("fixture:async")).toEqual([]);
});

it("query rejects an unknown corpus", async () => {
  const adapter = createFakeAsyncAdapter();
  const m = createMnemeAsync({ adapter, availableTiers: [{ kind: "core" }] });
  await expect(
    m.query("no-such-corpus", [leafAsync("no-such-corpus")])
  ).rejects.toThrow(/unknown corpus/);
});

it("supersede rejects an unknown corpus", async () => {
  const adapter = createFakeAsyncAdapter();
  const m = createMnemeAsync({ adapter, availableTiers: [{ kind: "core" }] });
  await expect(
    m.supersede("no-such-corpus", "some-id", makeCandidate(), { writer: "test-writer" })
  ).rejects.toThrow(/unknown corpus/);
});

it("promote rejects an unknown corpus", async () => {
  const adapter = createFakeAsyncAdapter();
  const m = createMnemeAsync({ adapter, availableTiers: [{ kind: "core" }] });
  await expect(
    m.promote("no-such-corpus", "some-id", "validated", { writer: "test-writer" })
  ).rejects.toThrow(/unknown corpus/);
});
