import { describe, it, expect, vi, afterEach } from "vitest";
import { freshSession, jaccardDeps, makeFakeHybridDeps } from "./test-support.js";
import { _resetEmbeddingsForTest } from "./embeddings.js";
import { reconcile } from "./reconcile.js";

describe("reconcile", () => {
  afterEach(() => {
    _resetEmbeddingsForTest();
  });

  it("propagates alias-load warnings (variant cardinality shadow) into ReconcileResult.warnings", async () => {
    const session = freshSession();
    session.createCorpus({ id: "c" });
    session.write("c", { subject: "user:brett", key: "editor", value: "vim" });
    session.write("c", { subject: "user:brett", key: "preferred_editor", value: "emacs" });
    session.write("c", { subject: "key:editor", key: "alias-of", value: "preferred_editor" });

    // keyCardinality has "editor" marked as multi — but there's an alias for it,
    // which loadAliasContext should flag as a cardinality/variant-shadow warning.
    const deps = { ...jaccardDeps, keyCardinality: { editor: "multi" as const } };
    const r = await reconcile(session, { corpus: "c", subjects: ["user:brett"] }, deps);

    expect(r.warnings.some((w) => /cardinality|variant/.test(w))).toBe(true);
  });

  it("rankFn reflects a jaccard fallback on the keys axis even when subjects is empty (short-circuited)", async () => {
    const session = freshSession();
    session.createCorpus({ id: "c" });
    session.write("c", { subject: "project:alpha", key: "status", value: "active" });

    const deps = await makeFakeHybridDeps();
    // Force warmValues to throw so the keys-axis entityScorer falls back to jaccard.
    vi.spyOn(deps.embeddings.adapter!, "embed").mockRejectedValue(new Error("dim mismatch"));

    // subjects omitted entirely → matchAxis short-circuits without calling entityScorer.
    const r = await reconcile(session, { corpus: "c", keys: ["status"] }, deps);

    expect(r.rankFn).toBe("jaccard");
    expect(r.warnings.some((w) => w.includes("warm-up failed"))).toBe(true);
  });

  it("reuses a near-duplicate subject and mints a genuinely-new one", async () => {
    const session = freshSession();
    session.createCorpus({ id: "c" });
    session.write("c", { subject: "project:crewtracks", key: "status", value: "active" });

    const r = await reconcile(
      session,
      { corpus: "c", subjects: ["project:crewTracks", "division:traffic-control"] },
      jaccardDeps,
    );

    expect(r.subjects[0].disposition).toBe("reuse");
    expect(r.subjects[0].suggestions[0].existing).toBe("project:crewtracks");
    expect(r.subjects[1].disposition).toBe("new"); // over-anchoring guard
  });

  it("assigns uncertain when the top score is strictly between the thresholds", async () => {
    const session = freshSession();
    session.createCorpus({ id: "c" });
    session.write("c", { subject: "widget", key: "status", value: "active" });

    // "widget-extra" tokens = {widget, extra}; existing "widget" tokens = {widget}.
    // intersection=1, union=2 → jaccard = 0.5, strictly between newThreshold=0.2
    // and reuseThreshold=0.9.
    const r = await reconcile(
      session,
      { corpus: "c", subjects: ["widget-extra"], newThreshold: 0.2, reuseThreshold: 0.9 },
      jaccardDeps,
    );

    expect(r.subjects[0].disposition).toBe("uncertain");
    expect(r.subjects[0].suggestions[0].score).toBeCloseTo(0.5, 5);
  });

  it("reconciles subjects and keys independently and symmetrically", async () => {
    const session = freshSession();
    session.createCorpus({ id: "c" });
    session.write("c", { subject: "project:crewtracks", key: "status.deploy", value: "active" });

    const r = await reconcile(
      session,
      {
        corpus: "c",
        subjects: ["project:crewtracks", "division:traffic-control"],
        keys: ["status.deploy", "totally-different-key"],
      },
      jaccardDeps,
    );

    expect(r.subjects).toHaveLength(2);
    expect(r.keys).toHaveLength(2);
    expect(r.keys[0].disposition).toBe("reuse");
    expect(r.keys[0].suggestions[0].existing).toBe("status.deploy");
    expect(r.keys[1].disposition).toBe("new");
  });

  it("every match carries scored suggestions, top-limit, sorted desc", async () => {
    const session = freshSession();
    session.createCorpus({ id: "c" });
    session.write("c", { subject: "project:alpha", key: "status", value: "active" });
    session.write("c", { subject: "project:alpha-beta", key: "status", value: "active" });
    session.write("c", { subject: "project:zzz-unrelated", key: "status", value: "active" });

    const r = await reconcile(session, { corpus: "c", subjects: ["project:alpha"], limit: 2 }, jaccardDeps);

    expect(r.subjects[0].suggestions.length).toBeLessThanOrEqual(2);
    const scores = r.subjects[0].suggestions.map((s) => s.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("unknown corpus: every candidate is new with no suggestions, plus a warning; corpus is NOT created", async () => {
    const session = freshSession();
    const r = await reconcile(
      session,
      { corpus: "never-seen", subjects: ["project:anything"], keys: ["some-key"] },
      jaccardDeps,
    );

    expect(r.subjects[0].disposition).toBe("new");
    expect(r.subjects[0].suggestions).toEqual([]);
    expect(r.keys[0].disposition).toBe("new");
    expect(r.keys[0].suggestions).toEqual([]);
    expect(r.warnings.some((w) => w.includes("does not exist"))).toBe(true);
    expect(session.listCorpora().map((c) => c.id)).not.toContain("never-seen");
  });

  it("empty candidates on both axes: returns empty matches, no warning about existence", async () => {
    const session = freshSession();
    session.createCorpus({ id: "c" });
    const r = await reconcile(session, { corpus: "c" }, jaccardDeps);
    expect(r.subjects).toEqual([]);
    expect(r.keys).toEqual([]);
  });

  it("never writes: claim count and corpus list unchanged after reconcile", async () => {
    const session = freshSession();
    session.createCorpus({ id: "c" });
    session.write("c", { subject: "project:crewtracks", key: "status", value: "active" });
    const before = session.mneme.read("c", { corpusId: "c" }).length;
    const corporaBefore = session.listCorpora().map((c) => c.id).sort();

    await reconcile(
      session,
      { corpus: "c", subjects: ["project:crewTracks", "division:traffic-control"], keys: ["status", "new-key"] },
      jaccardDeps,
    );

    const after = session.mneme.read("c", { corpusId: "c" }).length;
    const corporaAfter = session.listCorpora().map((c) => c.id).sort();
    expect(after).toBe(before);
    expect(corporaAfter).toEqual(corporaBefore);
  });

  it("composes a human-readable content string naming disposition and top suggestion", async () => {
    const session = freshSession();
    session.createCorpus({ id: "c" });
    session.write("c", { subject: "project:crewtracks", key: "status", value: "active" });

    const r = await reconcile(session, { corpus: "c", subjects: ["project:crewTracks"] }, jaccardDeps);
    expect(r.content).toContain("project:crewTracks");
    expect(r.content).toContain("reuse");
    expect(r.content).toContain("project:crewtracks");
  });
});
