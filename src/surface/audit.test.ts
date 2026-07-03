import { describe, it, expect } from "vitest";
import { remember, listCorpora } from "./remember.js";
import { freshSession, jaccardDeps } from "./test-support.js";
import { audit } from "./audit.js";

describe("audit", () => {
  it("proposes a cardinality-declare for a single-cardinality collision and NEVER applies it", async () => {
    const s = freshSession();
    s.createCorpus({ id: "c", keyCardinality: { plan: "single" } });
    s.write("c", { subject: "p", key: "plan", value: "alpha", valid: { from: 1, to: Infinity } });
    s.write("c", { subject: "p", key: "plan", value: "bravo", valid: { from: 2, to: Infinity } });
    const before = s.mneme.read("c", { corpusId: "c" }).length;
    const r = await audit(s, { corpus: "c" }, jaccardDeps);
    expect(r.proposals.some((p) => p.kind === "cardinality-declare")).toBe(true);
    // I3: proposing must not mutate — claim count + schema unchanged.
    expect(s.mneme.read("c", { corpusId: "c" }).length).toBe(before);
    expect((s.inspectCorpus("c") as { schema: { keyCardinality: Record<string, string> } }).schema.keyCardinality)
      .toEqual({ plan: "single" });
    s.close();
  });

  it("the cardinality-declare proposal names the collided subject/key and a declare-cardinality suggestedAction", async () => {
    const s = freshSession();
    s.createCorpus({ id: "c", keyCardinality: { plan: "single" } });
    s.write("c", { subject: "p", key: "plan", value: "alpha", valid: { from: 1, to: Infinity } });
    s.write("c", { subject: "p", key: "plan", value: "bravo", valid: { from: 2, to: Infinity } });
    const r = await audit(s, { corpus: "c" }, jaccardDeps);
    const prop = r.proposals.find((p) => p.kind === "cardinality-declare");
    expect(prop).toBeDefined();
    expect(prop!.entities).toEqual(["p", "plan"]);
    expect(prop!.claimsAffected).toBeGreaterThanOrEqual(2);
    expect(prop!.suggestedAction).toContain("declareCardinality");
    expect(prop!.suggestedAction).toContain("plan");
    s.close();
  });

  it("cardinality-declare claimsAffected equals the group's total claim count, not distinctValues", async () => {
    const s = freshSession();
    const corpus = "audit-cardinality-units";
    s.createCorpus({ id: corpus, keyCardinality: { plan: "single" } });
    // beta confidence (not the default scalar) so a >1-claim value group can be pooled
    // by clustersOf's default EVIDENCE_POOLED rule during collision detection.
    const beta = { distribution: "beta" as const, parameters: { alpha: 2, beta: 2 }, raw: 0.5 };
    // ⊕_dedupe groups by RAW key (pre-alias); the cardinality cluster groups by CANONICAL
    // key. Two raw keys aliased to the same canonical key each keep their own duplicate
    // value un-merged across the raw-key boundary, so once grouped under the canonical
    // key totalClaims (3) > distinctValues (2, "alpha" appearing under both raw keys +
    // "bravo") — the case the old distinctValues-based ranking got wrong.
    s.write(corpus, { subject: "p", key: "plan", value: "alpha", confidence: beta, valid: { from: 1, to: Infinity } });
    s.write(corpus, { subject: "p", key: "plan_variant", value: "alpha", confidence: beta, valid: { from: 2, to: Infinity } });
    s.write(corpus, { subject: "p", key: "plan_variant", value: "bravo", confidence: beta, valid: { from: 3, to: Infinity } });
    remember(s, { subject: "key:plan_variant", key: "alias-of", value: "plan", corpus });
    const r = await audit(s, { corpus }, jaccardDeps);
    const prop = r.proposals.find((p) => p.kind === "cardinality-declare");
    expect(prop).toBeDefined();
    expect(prop!.claimsAffected).toBe(3); // totalClaims, NOT distinctValues (2)
    s.close();
  });

  it("cardinality-declare proposal is structural: subject/key containing comma or ')' is not mis-parsed", async () => {
    const s = freshSession();
    s.createCorpus({ id: "c", keyCardinality: { "weird)key": "single" } });
    s.write("c", { subject: "p,x)", key: "weird)key", value: "alpha", valid: { from: 1, to: Infinity } });
    s.write("c", { subject: "p,x)", key: "weird)key", value: "bravo", valid: { from: 2, to: Infinity } });
    const r = await audit(s, { corpus: "c" }, jaccardDeps);
    const prop = r.proposals.find((p) => p.kind === "cardinality-declare");
    expect(prop).toBeDefined();
    expect(prop!.entities).toEqual(["p,x)", "weird)key"]);
    expect(prop!.claimsAffected).toBe(2);
    s.close();
  });

  it("proposes a key-alias for near-duplicate keys, composed from keyCensus candidates", async () => {
    const s = freshSession();
    const corpus = "audit-key-alias";
    remember(s, { subject: "user:brett", key: "editor", value: "vim", corpus });
    remember(s, { subject: "user:brett", key: "preferred_editor", value: "emacs", corpus });
    const r = await audit(s, { corpus }, jaccardDeps);
    const prop = r.proposals.find((p) => p.kind === "key-alias");
    expect(prop).toBeDefined();
    expect(prop!.entities).toEqual(["editor", "preferred_editor"]);
    expect(prop!.suggestedAction).toContain("remember");
    expect(prop!.suggestedAction).toContain("alias-of");
    expect(typeof prop!.score).toBe("number");
  });

  it("proposes a subject-fragmentation for near-duplicate subjects, composed from subjectCensus candidates", async () => {
    const s = freshSession();
    const corpus = "audit-subject-frag";
    remember(s, { subject: "project:crewtracks", key: "status", value: "active", corpus });
    remember(s, { subject: "project:crewTracks-liner-build", key: "status", value: "active", corpus });
    const r = await audit(s, { corpus }, jaccardDeps);
    const prop = r.proposals.find((p) => p.kind === "subject-fragmentation");
    expect(prop).toBeDefined();
    expect(prop!.entities).toEqual(["project:crewtracks", "project:crewTracks-liner-build"]);
  });

  it("ranks proposals desc by claimsAffected then score", async () => {
    const s = freshSession();
    const corpus = "audit-rank";
    // Small key-alias signal (2 claims total).
    remember(s, { subject: "user:brett", key: "editor", value: "vim", corpus });
    remember(s, { subject: "user:brett", key: "preferred_editor", value: "emacs", corpus });
    const r = await audit(s, { corpus }, jaccardDeps);
    for (let i = 0; i < r.proposals.length - 1; i++) {
      const a = r.proposals[i];
      const b = r.proposals[i + 1];
      expect(
        a.claimsAffected > b.claimsAffected ||
          (a.claimsAffected === b.claimsAffected && (a.score ?? 0) >= (b.score ?? 0)),
      ).toBe(true);
    }
  });

  it("unknown corpus returns empty proposals and does NOT create the corpus", async () => {
    const s = freshSession();
    const r = await audit(s, { corpus: "never-seen-audit" }, jaccardDeps);
    expect(r.proposals).toEqual([]);
    expect(listCorpora(s).corpora.map((c) => c.id)).not.toContain("never-seen-audit");
  });

  it("is read-only overall: zero writes for a corpus with both alias and cardinality signal", async () => {
    const s = freshSession();
    s.createCorpus({ id: "c2", keyCardinality: { plan: "single" } });
    s.write("c2", { subject: "p", key: "plan", value: "alpha", valid: { from: 1, to: Infinity } });
    s.write("c2", { subject: "p", key: "plan", value: "bravo", valid: { from: 2, to: Infinity } });
    remember(s, { subject: "user:brett", key: "editor", value: "vim", corpus: "c2" });
    remember(s, { subject: "user:brett", key: "preferred_editor", value: "emacs", corpus: "c2" });
    const before = s.mneme.read("c2", { corpusId: "c2" }).length;
    const r = await audit(s, { corpus: "c2" }, jaccardDeps);
    expect(r.proposals.length).toBeGreaterThan(0);
    expect(s.mneme.read("c2", { corpusId: "c2" }).length).toBe(before);
    s.close();
  });

  it("surfaces subject-over-merge proposals from reverseReconcile, ranked after the high-confidence kinds", async () => {
    const s = freshSession();
    const corpus = "audit-overmerge";
    s.createCorpus({ id: corpus, keyCardinality: { plan: "single" } });
    // high-confidence cardinality-declare signal (claimsAffected=2, kind claimsAffected>0).
    s.write(corpus, { subject: "p", key: "plan", value: "alpha", valid: { from: 1, to: Infinity } });
    s.write(corpus, { subject: "p", key: "plan", value: "bravo", valid: { from: 2, to: Infinity } });
    // over-merged subject: two token-disjoint value clusters on one subject.
    s.write(corpus, { subject: "project:x", key: "capability", value: "payroll export csv adp", valid: { from: 3, to: Infinity }, source: "llm", confidence: 0.8 });
    s.write(corpus, { subject: "project:x", key: "capability2", value: "payroll timesheet approval flow", valid: { from: 4, to: Infinity }, source: "llm", confidence: 0.8 });
    s.write(corpus, { subject: "project:x", key: "capability3", value: "geofencing biometric clock gate", valid: { from: 5, to: Infinity }, source: "llm", confidence: 0.8 });
    s.write(corpus, { subject: "project:x", key: "capability4", value: "geofencing location perimeter alerts", valid: { from: 6, to: Infinity }, source: "llm", confidence: 0.8 });

    const r = await audit(s, { corpus }, jaccardDeps);

    const overMerge = r.proposals.filter((p) => p.kind === "subject-over-merge");
    expect(overMerge.length).toBeGreaterThan(0);
    expect(overMerge[0].detail).toMatch(/confidence: (low|medium)/);

    const lastHighConfIdx = r.proposals.reduce(
      (last, p, i) => (p.claimsAffected > 0 ? i : last),
      -1,
    );
    const firstOverMergeIdx = r.proposals.findIndex((p) => p.kind === "subject-over-merge");
    expect(lastHighConfIdx).toBeGreaterThanOrEqual(0);
    expect(firstOverMergeIdx).toBeGreaterThan(lastHighConfIdx);
    s.close();
  });

  it("content is a human-readable maintenance report naming the proposals", async () => {
    const s = freshSession();
    const corpus = "audit-content";
    remember(s, { subject: "user:brett", key: "editor", value: "vim", corpus });
    remember(s, { subject: "user:brett", key: "preferred_editor", value: "emacs", corpus });
    const r = await audit(s, { corpus }, jaccardDeps);
    expect(r.content).toContain("Audit");
    expect(r.content.length).toBeGreaterThan(0);
  });
});
