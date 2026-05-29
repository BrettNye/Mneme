import {
  joinScope,
  joinSubject,
  joinEvidence,
  joinScopeWith,
  joinSubjectWith,
  joinEvidenceWith,
} from "./join.js";
import { corpusOf } from "./types.js";
import { leaf as leafStage } from "./expression.js";
import type { EvalContext } from "./expression.js";
import type { Claim } from "../core/claim.js";
import type { EvidenceRef } from "../core/evidence.js";

// ---------------------------------------------------------------------------
// Minimal Claim fixture
// ---------------------------------------------------------------------------

function makeClaim(overrides: Omit<Partial<Claim>, "id"> & { id: string }): Claim {
  return {
    profile: "p1" as any,
    workspace: "w1" as any,
    subject: "alice" as any,
    key: "k" as any,
    scope: {},
    scopeHash: "h",
    value: "v" as any,
    valueHash: "vh",
    confidence: { distribution: "scalar", parameters: { p: 0.9 }, raw: 0.9 } as any,
    valid: { from: 0, to: Number.MAX_SAFE_INTEGER } as any,
    recorded: 0 as any,
    recordedSeq: 0,
    status: "validated",
    source: "manual",
    provenance: {} as any,
    evidence: [],
    tags: [],
    schema: "v1",
    ...overrides,
  } as Claim;
}

const idsOf = (claims: readonly Claim[]) => claims.map((c) => c.id).sort();

const makeCtx = (claims: Claim[] = []): EvalContext =>
  ({
    adapter: { query: () => claims, getClaim: () => undefined } as any,
    catalog: { getCorpus: () => ({}) } as any,
  }) as EvalContext;

// ---------------------------------------------------------------------------
// joinScope
// ---------------------------------------------------------------------------

it("joinScope collects claims from both sides sharing scope.entityId", () => {
  const l = makeClaim({ id: "L1", scope: { entityId: "e1" } });
  const r = makeClaim({ id: "R1", scope: { entityId: "e1" } });
  const out = joinScope(corpusOf([l]), corpusOf([r]));
  expect(idsOf(out.claims)).toEqual(["L1", "R1"]);
});

it("joinScope excludes claims with no matching entityId on the other side", () => {
  const l = makeClaim({ id: "L1", scope: { entityId: "e1" } });
  const r = makeClaim({ id: "R1", scope: { entityId: "e2" } });
  const out = joinScope(corpusOf([l]), corpusOf([r]));
  expect(out.claims).toHaveLength(0);
});

it("joinScope ignores claims whose entityId is undefined", () => {
  const l = makeClaim({ id: "L1", scope: {} });
  const r = makeClaim({ id: "R1", scope: {} });
  const out = joinScope(corpusOf([l]), corpusOf([r]));
  expect(out.claims).toHaveLength(0);
});

it("joinScope keeps left matches before right matches in order", () => {
  const l = makeClaim({ id: "L1", scope: { entityId: "e1" } });
  const r = makeClaim({ id: "R1", scope: { entityId: "e1" } });
  const out = joinScope(corpusOf([l]), corpusOf([r]));
  expect(out.claims.map((c) => c.id)).toEqual(["L1", "R1"]);
});

it("joinScope is commutative on the resulting id set", () => {
  const l = makeClaim({ id: "L1", scope: { entityId: "e1" } });
  const r = makeClaim({ id: "R1", scope: { entityId: "e1" } });
  const lr = joinScope(corpusOf([l]), corpusOf([r]));
  const rl = joinScope(corpusOf([r]), corpusOf([l]));
  expect(idsOf(lr.claims)).toEqual(idsOf(rl.claims));
});

// ---------------------------------------------------------------------------
// joinSubject
// ---------------------------------------------------------------------------

it("joinSubject collects claims from both sides sharing subject", () => {
  const l = makeClaim({ id: "L1", subject: "alice" as any });
  const r = makeClaim({ id: "R1", subject: "alice" as any });
  const out = joinSubject(corpusOf([l]), corpusOf([r]));
  expect(idsOf(out.claims)).toEqual(["L1", "R1"]);
});

it("joinSubject excludes claims with no matching subject on the other side", () => {
  const l = makeClaim({ id: "L1", subject: "alice" as any });
  const r = makeClaim({ id: "R1", subject: "bob" as any });
  const out = joinSubject(corpusOf([l]), corpusOf([r]));
  expect(out.claims).toHaveLength(0);
});

it("joinSubject is commutative on the resulting id set", () => {
  const l = makeClaim({ id: "L1", subject: "alice" as any });
  const r = makeClaim({ id: "R1", subject: "alice" as any });
  const lr = joinSubject(corpusOf([l]), corpusOf([r]));
  const rl = joinSubject(corpusOf([r]), corpusOf([l]));
  expect(idsOf(lr.claims)).toEqual(idsOf(rl.claims));
});

// ---------------------------------------------------------------------------
// joinEvidence
// ---------------------------------------------------------------------------

it("joinEvidence matches when a left claim references a right claim by ClaimRef", () => {
  const r = makeClaim({ id: "R1" });
  const l = makeClaim({
    id: "L1",
    evidence: [{ kind: "claim", claimId: "R1" as any }] as EvidenceRef[],
  });
  const out = joinEvidence(corpusOf([l]), corpusOf([r]));
  expect(idsOf(out.claims)).toEqual(["L1", "R1"]);
});

it("joinEvidence matches when a right claim references a left claim by ClaimRef", () => {
  const l = makeClaim({ id: "L1" });
  const r = makeClaim({
    id: "R1",
    evidence: [{ kind: "claim", claimId: "L1" as any }] as EvidenceRef[],
  });
  const out = joinEvidence(corpusOf([l]), corpusOf([r]));
  expect(idsOf(out.claims)).toEqual(["L1", "R1"]);
});

it("joinEvidence matches when both sides share an evidence ref", () => {
  const shared: EvidenceRef = { kind: "external", uri: "https://x/doc" };
  const l = makeClaim({ id: "L1", evidence: [shared] });
  const r = makeClaim({ id: "R1", evidence: [{ ...shared }] });
  const out = joinEvidence(corpusOf([l]), corpusOf([r]));
  expect(idsOf(out.claims)).toEqual(["L1", "R1"]);
});

it("joinEvidence excludes claims with no evidence link", () => {
  const l = makeClaim({
    id: "L1",
    evidence: [{ kind: "external", uri: "https://x/a" }],
  });
  const r = makeClaim({
    id: "R1",
    evidence: [{ kind: "external", uri: "https://x/b" }],
  });
  const out = joinEvidence(corpusOf([l]), corpusOf([r]));
  expect(out.claims).toHaveLength(0);
});

it("joinEvidence is commutative on the resulting id set", () => {
  const r = makeClaim({ id: "R1" });
  const l = makeClaim({
    id: "L1",
    evidence: [{ kind: "claim", claimId: "R1" as any }] as EvidenceRef[],
  });
  const lr = joinEvidence(corpusOf([l]), corpusOf([r]));
  const rl = joinEvidence(corpusOf([r]), corpusOf([l]));
  expect(idsOf(lr.claims)).toEqual(idsOf(rl.claims));
});

// ---------------------------------------------------------------------------
// De-duplication by id
// ---------------------------------------------------------------------------

it("join de-duplicates a claim that appears (by id) in both corpora", () => {
  const shared = makeClaim({ id: "S1", subject: "alice" as any });
  const l = makeClaim({ id: "L1", subject: "alice" as any });
  const out = joinSubject(corpusOf([l, shared]), corpusOf([shared]));
  // S1 appears on both sides but must show up once
  expect(out.claims.filter((c) => c.id === ("S1" as any))).toHaveLength(1);
  expect(idsOf(out.claims)).toEqual(["L1", "S1"]);
});

// ---------------------------------------------------------------------------
// Stage builders
// ---------------------------------------------------------------------------

it("joinSubjectWith evaluates a right sub-pipeline and joins against it", () => {
  const l = makeClaim({ id: "L1", subject: "alice" as any });
  const r = makeClaim({ id: "R1", subject: "alice" as any });
  const ctx = makeCtx([r]);
  const stage = joinSubjectWith([leafStage("right:corpus")]);
  const out = stage(corpusOf([l]), ctx);
  expect(idsOf(out.claims)).toEqual(["L1", "R1"]);
});

it("joinScopeWith evaluates a right sub-pipeline and joins on scope.entityId", () => {
  const l = makeClaim({ id: "L1", scope: { entityId: "e1" } });
  const r = makeClaim({ id: "R1", scope: { entityId: "e1" } });
  const ctx = makeCtx([r]);
  const stage = joinScopeWith([leafStage("right:corpus")]);
  const out = stage(corpusOf([l]), ctx);
  expect(idsOf(out.claims)).toEqual(["L1", "R1"]);
});

it("joinEvidenceWith evaluates a right sub-pipeline and joins on evidence links", () => {
  const r = makeClaim({ id: "R1" });
  const l = makeClaim({
    id: "L1",
    evidence: [{ kind: "claim", claimId: "R1" as any }] as EvidenceRef[],
  });
  const ctx = makeCtx([r]);
  const stage = joinEvidenceWith([leafStage("right:corpus")]);
  const out = stage(corpusOf([l]), ctx);
  expect(idsOf(out.claims)).toEqual(["L1", "R1"]);
});
