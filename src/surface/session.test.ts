import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "./session.js";
import { betaFromRaw } from "../write/source-weight.js";
import type { ClaimSchema } from "../catalog/schema.js";

describe("session persistence", () => {
  it("persists corpora and claims across reopen of the same db", () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "s.db");
    const s1 = openSession({ dbPath: db });
    s1.createCorpus({ id: "c", subjects: ["host:a"] });
    const out = s1.write("c", { subject: "host:a", key: "status", value: "healthy" });
    expect(out.status).toBe("committed");
    s1.close();

    const s2 = openSession({ dbPath: db });
    const res = s2.q("c", `where subject = host:a | as text 1000`) as { content: string };
    expect(res.content).toContain("healthy");
  });
});

describe("openSession", () => {
  it("returns a session with mneme facade", () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "t.db");
    const s = openSession({ dbPath: db });
    expect(s.mneme).toBeDefined();
    expect(typeof s.createCorpus).toBe("function");
    expect(typeof s.write).toBe("function");
    expect(typeof s.writeMany).toBe("function");
    expect(typeof s.q).toBe("function");
    expect(typeof s.listCorpora).toBe("function");
    expect(typeof s.inspectCorpus).toBe("function");
    expect(typeof s.inspect).toBe("function");
    expect(typeof s.replay).toBe("function");
    expect(typeof s.close).toBe("function");
  });

  it("listCorpora returns created corpora", () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "t.db");
    const s = openSession({ dbPath: db });
    s.createCorpus({ id: "corp1", displayName: "Corp One", subjects: [] });
    const list = s.listCorpora();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("corp1");
    expect(list[0].displayName).toBe("Corp One");
  });

  it("write fills defaults for confidence when omitted", () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "t.db");
    const s = openSession({ dbPath: db });
    s.createCorpus({ id: "c2", subjects: [] });
    const out = s.write("c2", { subject: "x", key: "y", value: "v" });
    expect(out.status).toBe("committed");
    const claim = s.inspect("c2", out.id);
    expect(claim).toBeDefined();
    expect(claim!.confidence.distribution).toBe("scalar");
    expect(claim!.confidence.raw).toBe(1);
  });

  it("write converts bare number confidence to scalar", () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "t.db");
    const s = openSession({ dbPath: db });
    s.createCorpus({ id: "c3", subjects: [] });
    const out = s.write("c3", { subject: "x", key: "y", value: "v", confidence: 0.7 });
    expect(out.status).toBe("committed");
    const claim = s.inspect("c3", out.id);
    expect(claim!.confidence.distribution).toBe("scalar");
    expect(claim!.confidence.raw).toBe(0.7);
    expect((claim!.confidence.parameters as { p: number }).p).toBe(0.7);
  });

  it("write sets schema as corpusId@version", () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "t.db");
    const s = openSession({ dbPath: db });
    s.createCorpus({ id: "c4", schemaVersion: "2", subjects: [] });
    const out = s.write("c4", { subject: "x", key: "y", value: "v" });
    const claim = s.inspect("c4", out.id);
    expect(claim!.schema).toBe("c4@2");
  });

  it("writeMany returns ImportStats with accurate counts", () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "t.db");
    const s = openSession({ dbPath: db });
    s.createCorpus({ id: "c5", subjects: [] });
    const records = [
      { subject: "x", key: "k1", value: "v1" },
      { subject: "x", key: "k2", value: "v2" },
      { subject: "x", key: "k3", value: "v3" },
    ];
    const stats = s.writeMany("c5", records);
    expect(stats.total).toBe(3);
    expect(stats.committed).toBe(3);
    expect(stats.rejected).toBe(0);
    expect(stats.duplicate).toBe(0);
    expect(stats.skipped).toBe(0);
    expect(stats.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(stats.claimsPerSec).toBeGreaterThanOrEqual(0);
  });

  it("replay returns missing status for unknown claimId", () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "t.db");
    const s = openSession({ dbPath: db });
    s.createCorpus({ id: "c6", subjects: [] });
    const result = s.replay("c6", "nonexistent-id");
    expect(result.status).toBe("missing");
  });

  it("inspect returns undefined for unknown claimId", () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "t.db");
    const s = openSession({ dbPath: db });
    s.createCorpus({ id: "c7", subjects: [] });
    const result = s.inspect("c7", "nonexistent-id");
    expect(result).toBeUndefined();
  });

  it("inspectCorpus returns the corpus def", () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "t.db");
    const s = openSession({ dbPath: db });
    s.createCorpus({ id: "c8", displayName: "Test Corp", subjects: [] });
    const corpusDef = s.inspectCorpus("c8");
    expect(corpusDef).toBeDefined();
    expect((corpusDef as { id: string }).id).toBe("c8");
  });

  it("q runs DSL pipeline and returns result", () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "t.db");
    const s = openSession({ dbPath: db });
    s.createCorpus({ id: "c9", subjects: [] });
    s.write("c9", { subject: "sub1", key: "k", value: "val1" });
    const result = s.q("c9", "where subject = sub1") as { claims: unknown[] };
    expect(result.claims).toHaveLength(1);
  });

  it("q with empty dsl returns all claims", () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "t.db");
    const s = openSession({ dbPath: db });
    s.createCorpus({ id: "c10", subjects: [] });
    s.write("c10", { subject: "sub1", key: "k1", value: "v1" });
    s.write("c10", { subject: "sub2", key: "k2", value: "v2" });
    const result = s.q("c10", "") as { claims: unknown[] };
    expect(result.claims).toHaveLength(2);
  });

  it("creates a missing parent directory for a nested dbPath", () => {
    const base = mkdtempSync(join(tmpdir(), "mneme-"));
    const db = join(base, "nested", "deep", "store.db"); // parent dirs do not exist yet
    const s = openSession({ dbPath: db });
    s.createCorpus({ id: "c", subjects: [] });
    const out = s.write("c", { subject: "x", key: "y", value: "v" });
    expect(out.status).toBe("committed");
    s.close();
  });

  it("threads a reject_on_contradiction policy into the corpus default", () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "t.db");
    const s = openSession({ dbPath: db });
    s.createCorpus({ id: "c11", subjects: [], contradictionPolicy: { kind: "reject_on_contradiction" } });
    const first = s.write("c11", { subject: "host:a", key: "status", value: "healthy" });
    expect(first.status).toBe("committed");
    // Same (subject,key,scope) with a different value contradicts the first.
    const second = s.write("c11", { subject: "host:a", key: "status", value: "degraded" });
    expect(second.status).toBe("rejected");
  });
});

describe("scalarPseudocount defaults (Appendix A.1)", () => {
  it("spec test 1: betaFromRaw succeeds for all six sources on a surface-created corpus", () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "t.db");
    const s = openSession({ dbPath: db });
    s.createCorpus({ id: "pc", subjects: [] });
    const def = s.inspectCorpus("pc") as { schema: ClaimSchema };
    const sources = ["manual", "verification", "workflow", "heuristic", "llm", "imported"] as const;
    for (const src of sources) {
      expect(() => betaFromRaw(0.8, src, def.schema)).not.toThrow();
    }
  });

  it("spec test 2: scalarPseudocount override merges over A.1 defaults", () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "t.db");
    const s = openSession({ dbPath: db });
    s.createCorpus({ id: "pc2", subjects: [], scalarPseudocount: { llm: 4 } });
    const def = s.inspectCorpus("pc2") as { schema: ClaimSchema };
    const pc = def.schema.scalarPseudocount;
    expect(pc.llm).toBe(4);
    expect(pc.manual).toBe(10);
    expect(pc.verification).toBe(10);
    expect(pc.workflow).toBe(5);
    expect(pc.heuristic).toBe(5);
    expect(pc.imported).toBe(2);
  });

  it("spec test 3: persisted sidecar has scalarPseudocount with exactly six numeric keys", () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "t.db");
    const s = openSession({ dbPath: db });
    s.createCorpus({ id: "pc3", subjects: [] });
    const sidecar = JSON.parse(readFileSync(`${db}.corpora.json`, "utf8")) as { schema: { scalarPseudocount: Record<string, number> } }[];
    const pc = sidecar[0].schema.scalarPseudocount;
    const keys = Object.keys(pc);
    expect(keys).toHaveLength(6);
    for (const k of keys) {
      expect(Number.isFinite(pc[k])).toBe(true);
    }
  });

  it("spec test 3b: explicit undefined in override does not overwrite default", () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "t.db");
    const s = openSession({ dbPath: db });
    s.createCorpus({ id: "pc4", subjects: [], scalarPseudocount: { llm: undefined } });
    const def = s.inspectCorpus("pc4") as { schema: ClaimSchema };
    expect(def.schema.scalarPseudocount.llm).toBe(2);
    const sidecar = JSON.parse(readFileSync(`${db}.corpora.json`, "utf8")) as { schema: { scalarPseudocount: Record<string, number> } }[];
    const pc = sidecar[0].schema.scalarPseudocount;
    expect(Object.keys(pc)).toHaveLength(6);
    for (const k of Object.keys(pc)) {
      expect(typeof pc[k]).toBe("number");
    }
  });

  it("spec test 3c: createCorpus throws for NaN, Infinity, and negative overrides; accepts 0", () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "t.db");
    const s = openSession({ dbPath: db });
    expect(() => s.createCorpus({ id: "bad1", subjects: [], scalarPseudocount: { llm: NaN } }))
      .toThrow(/scalarPseudocount.*llm.*NaN|llm.*scalarPseudocount/);
    expect(() => s.createCorpus({ id: "bad2", subjects: [], scalarPseudocount: { llm: Infinity } }))
      .toThrow(/scalarPseudocount.*llm|llm.*scalarPseudocount/);
    expect(() => s.createCorpus({ id: "bad3", subjects: [], scalarPseudocount: { llm: -1 } }))
      .toThrow(/scalarPseudocount.*llm|llm.*scalarPseudocount/);
    // 0 must be accepted
    expect(() => s.createCorpus({ id: "ok1", subjects: [], scalarPseudocount: { llm: 0 } })).not.toThrow();
    const def = s.inspectCorpus("ok1") as { schema: ClaimSchema };
    expect(def.schema.scalarPseudocount.llm).toBe(0);
  });
});

describe("keyCardinality on CorpusSpec", () => {
  it("createCorpus persists keyCardinality and round-trips across reopen", () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "t.db");
    const s1 = openSession({ dbPath: db });
    s1.createCorpus({ id: "c", keyCardinality: { status: "single", tags: "multi" } });
    s1.close();
    const s2 = openSession({ dbPath: db });
    const def = s2.inspectCorpus("c") as { schema: { keyCardinality?: Record<string, string> } };
    expect(def.schema.keyCardinality).toEqual({ status: "single", tags: "multi" });
    s2.close();
  });

  it("createCorpus rejects an invalid cardinality value", () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "t.db");
    const s = openSession({ dbPath: db });
    expect(() => s.createCorpus({ id: "x", keyCardinality: { k: "many" as "single" } }))
      .toThrow(/invalid keyCardinality/);
    s.close();
  });

  it("leaves keyCardinality absent from the persisted schema when omitted", () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "t.db");
    const s = openSession({ dbPath: db });
    s.createCorpus({ id: "y", subjects: [] });
    const def = s.inspectCorpus("y") as { schema: { keyCardinality?: unknown } };
    expect(def.schema.keyCardinality).toBeUndefined();
    s.close();
  });
});

describe("declareCardinality", () => {
  it("merges into an existing corpus and preserves claims + other schema fields", () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "t.db");
    const s = openSession({ dbPath: db, writer: "test" });
    s.createCorpus({ id: "c", subjects: ["client:x"], keyCardinality: { status: "single" } });
    s.write("c", { subject: "client:x", key: "plan", value: "alpha" });
    const eff = s.declareCardinality("c", { plan: "multi" });
    expect(eff).toEqual({ status: "single", plan: "multi" }); // merged, not replaced
    const def = s.inspectCorpus("c") as { schema: { keyCardinality: Record<string, string>; subjects: string[] } };
    expect(def.schema.keyCardinality).toEqual({ status: "single", plan: "multi" });
    expect(def.schema.subjects).toEqual(["client:x"]); // other schema fields intact
    const claims = s.mneme.read("c", { corpusId: "c" });
    expect(claims.some((cl) => cl.value === "alpha")).toBe(true); // claim survives the def re-create
    s.close();
  });

  it("creates the corpus when absent; invalid value throws", () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "t.db");
    const s = openSession({ dbPath: db, writer: "test" });
    s.declareCardinality("fresh", { plan: "multi" });
    expect((s.inspectCorpus("fresh") as { schema: { keyCardinality: Record<string, string> } }).schema.keyCardinality)
      .toEqual({ plan: "multi" });
    expect(() => s.declareCardinality("fresh", { k: "many" as "single" })).toThrow(/invalid keyCardinality/);
    s.close();
  });
});

describe("C7 backfill on session re-open", () => {
  it("spec test 4: backfills an empty scalarPseudocount on load, persists, and announces", () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "t.db");
    const s1 = openSession({ dbPath: db });
    s1.createCorpus({ id: "legacy", subjects: [] });
    s1.close();
    // Simulate the pre-fix bug state in the sidecar.
    const sidecar = `${db}.corpora.json`;
    const defs = JSON.parse(readFileSync(sidecar, "utf8"));
    defs[0].schema.scalarPseudocount = {};
    writeFileSync(sidecar, JSON.stringify(defs), "utf8");

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    openSession({ dbPath: db }).close();
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0][0]).toContain("C7 repair");
    const persisted = JSON.parse(readFileSync(sidecar, "utf8"));
    expect(Object.keys(persisted[0].schema.scalarPseudocount)).toHaveLength(6);
    errSpy.mockRestore();

    // Idempotency pin: a third open after the repair emits no stderr.
    const errSpy2 = vi.spyOn(console, "error").mockImplementation(() => {});
    const contentBefore = readFileSync(sidecar, "utf8");
    openSession({ dbPath: db }).close();
    expect(errSpy2).not.toHaveBeenCalled();
    const contentAfter = readFileSync(sidecar, "utf8");
    expect(contentAfter).toBe(contentBefore);
    errSpy2.mockRestore();
  });

  it("spec test 5: backfills a missing scalarPseudocount field (field deleted entirely)", () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "t.db");
    const s1 = openSession({ dbPath: db });
    s1.createCorpus({ id: "missing-pc", subjects: [] });
    s1.close();
    // Simulate older sidecar with the field deleted entirely.
    const sidecar = `${db}.corpora.json`;
    const defs = JSON.parse(readFileSync(sidecar, "utf8"));
    delete defs[0].schema.scalarPseudocount;
    writeFileSync(sidecar, JSON.stringify(defs), "utf8");

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    openSession({ dbPath: db }).close();
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0][0]).toContain("C7 repair");
    const persisted = JSON.parse(readFileSync(sidecar, "utf8"));
    expect(Object.keys(persisted[0].schema.scalarPseudocount)).toHaveLength(6);
    errSpy.mockRestore();
  });

  it("spec test 6: stderr fires once per repaired corpus; healthy load emits no stderr and does not rewrite sidecar", () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "t.db");
    const s1 = openSession({ dbPath: db });
    s1.createCorpus({ id: "corp-a", subjects: [] });
    s1.createCorpus({ id: "corp-b", subjects: [] });
    s1.close();
    // Corrupt only the first corpus.
    const sidecar = `${db}.corpora.json`;
    const defs = JSON.parse(readFileSync(sidecar, "utf8"));
    defs[0].schema.scalarPseudocount = {};
    writeFileSync(sidecar, JSON.stringify(defs), "utf8");

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    openSession({ dbPath: db }).close();
    // Exactly one stderr line for the one repaired corpus.
    expect(errSpy).toHaveBeenCalledTimes(1);
    const msg = errSpy.mock.calls[0][0] as string;
    expect(msg).toMatch(new RegExp(`${sidecar.replace(/\\/g, "\\\\").replace(/\./g, "\\.")}.*backfilled.*C7 repair`));
    errSpy.mockRestore();

    // Now healthy — re-open must emit no stderr and not rewrite sidecar.
    const contentBefore = readFileSync(sidecar, "utf8");
    const errSpy2 = vi.spyOn(console, "error").mockImplementation(() => {});
    openSession({ dbPath: db }).close();
    expect(errSpy2).not.toHaveBeenCalled();
    const contentAfter = readFileSync(sidecar, "utf8");
    expect(contentAfter).toBe(contentBefore);
    errSpy2.mockRestore();
  });

  it("spec test 7: persisted non-empty map loads verbatim — no merge, no rewrite, no stderr", () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "t.db");
    const s1 = openSession({ dbPath: db });
    s1.createCorpus({ id: "custom-pc", subjects: [] });
    s1.close();
    // Overwrite the sidecar with a partial but non-empty map (simulating a custom config).
    const sidecar = `${db}.corpora.json`;
    const defs = JSON.parse(readFileSync(sidecar, "utf8"));
    defs[0].schema.scalarPseudocount = { workflow: 4, manual: 8 };
    writeFileSync(sidecar, JSON.stringify(defs), "utf8");

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const s2 = openSession({ dbPath: db });
    expect(errSpy).not.toHaveBeenCalled();
    const persisted = JSON.parse(readFileSync(sidecar, "utf8"));
    expect(persisted[0].schema.scalarPseudocount).toEqual({ workflow: 4, manual: 8 });
    s2.close();
    errSpy.mockRestore();
  });
});
