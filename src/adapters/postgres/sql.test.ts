import { describe, it, expect } from "vitest";
import {
  buildQuery,
  insertClaimSql,
  headHashSql,
  appendEventSql,
  putIdempotencySql,
  putAnchorSql,
} from "./sql.js";

describe("buildQuery", () => {
  it("forces corpus_id first and orders by id COLLATE \"C\"", () => {
    const { text, params } = buildQuery("", { corpusId: "c1", subject: "s" }, { corpus: "c1" });
    expect(text).toMatch(/corpus_id = \$1[\s\S]*subject = \$2/i);
    expect(text.toLowerCase()).toContain('order by recorded_seq asc, id collate "c" asc');
    expect(params).toEqual(["c1", "s"]);
  });

  it("prepends the schemaPrefix to the table identifier", () => {
    const { text } = buildQuery("tenant_a.", { corpusId: "c1" });
    expect(text).toContain("FROM tenant_a.claims");
  });

  it("with no force and no plan predicates emits no WHERE clause", () => {
    const { text, params } = buildQuery("", {} as unknown as Parameters<typeof buildQuery>[1]);
    expect(text).not.toContain("WHERE");
    expect(params).toEqual([]);
  });

  it("adds forced profile predicate after corpus_id when present", () => {
    const { text, params } = buildQuery("", { corpusId: "c1" }, { corpus: "c1", profile: "p1" });
    expect(text).toMatch(/corpus_id = \$1 AND profile = \$2/);
    expect(params).toEqual(["c1", "p1"]);
  });

  it("adds plan predicates in order: subject, key, scopeHash, recordedAtMost, status, runIds", () => {
    const { text, params } = buildQuery("", {
      corpusId: "c1",
      subject: "s",
      key: "k",
      scopeHash: "h",
      recordedAtMost: 100,
      status: ["validated", "deprecated"],
      runIds: ["r1", "r2"],
    });
    expect(text).toContain(
      "subject = $1 AND key = $2 AND scope_hash = $3 AND recorded <= $4 AND status IN ($5, $6) AND run_id IN ($7, $8)"
    );
    expect(params).toEqual(["s", "k", "h", 100, "validated", "deprecated", "r1", "r2"]);
  });

  it("appends the optional tenantPredicate last, after plan predicates", () => {
    const { text, params } = buildQuery(
      "",
      { corpusId: "c1", subject: "s" },
      undefined,
      { sql: "tenant_id = $N", params: ["t1"] }
    );
    expect(text).toContain("subject = $1 AND tenant_id = $2");
    expect(params).toEqual(["s", "t1"]);
  });

  it("combines forced scope, plan predicates, and tenantPredicate in the right order and numbering", () => {
    const { text, params } = buildQuery(
      "",
      { corpusId: "c1", subject: "s", status: ["validated"] },
      { corpus: "c1", profile: "p1" },
      { sql: "tenant_id = $N", params: ["t1"] }
    );
    expect(text).toContain(
      "WHERE corpus_id = $1 AND profile = $2 AND subject = $3 AND status IN ($4) AND tenant_id = $5"
    );
    expect(params).toEqual(["c1", "p1", "s", "validated", "t1"]);
  });

  it("skips empty status/runIds arrays", () => {
    const { text, params } = buildQuery("", { corpusId: "c1", status: [], runIds: [] });
    expect(text).not.toContain("WHERE");
    expect(params).toEqual([]);
  });
});

describe("insertClaimSql", () => {
  it("uses INSERT ... ON CONFLICT (id) DO UPDATE and prepends the prefix", () => {
    const sql = insertClaimSql("tenant_a.");
    expect(sql).toContain("INSERT INTO tenant_a.claims");
    expect(sql).toMatch(/ON CONFLICT\s*\(id\)\s*DO UPDATE/i);
  });
});

describe("headHashSql", () => {
  it("selects entry_hash ordered by seq_pk descending limit 1", () => {
    const sql = headHashSql("tenant_a.");
    expect(sql).toContain("FROM tenant_a.claim_events");
    expect(sql.toLowerCase()).toContain("order by seq_pk desc limit 1");
    expect(sql).toContain("entry_hash");
  });
});

describe("appendEventSql", () => {
  it("inserts into claim_events with the prefix applied", () => {
    const sql = appendEventSql("tenant_a.");
    expect(sql).toContain("INSERT INTO tenant_a.claim_events");
  });
});

describe("putIdempotencySql", () => {
  it("uses ON CONFLICT (scope, key) DO NOTHING", () => {
    const sql = putIdempotencySql("tenant_a.");
    expect(sql).toContain("INSERT INTO tenant_a.idempotency");
    expect(sql).toMatch(/ON CONFLICT\s*\(scope,\s*key\)\s*DO NOTHING/i);
  });
});

describe("putAnchorSql", () => {
  it("uses ON CONFLICT (corpus_id, epoch_id) DO UPDATE", () => {
    const sql = putAnchorSql("tenant_a.");
    expect(sql).toContain("INSERT INTO tenant_a.audit_anchors");
    expect(sql).toMatch(/ON CONFLICT\s*\(corpus_id,\s*epoch_id\)\s*DO UPDATE/i);
  });
});
