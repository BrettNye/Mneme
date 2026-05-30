import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "./session.js";

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
