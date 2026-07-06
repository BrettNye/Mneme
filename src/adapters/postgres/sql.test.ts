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
  it("leads with tenant_id = $1 (empty tenantId), then forces corpus_id, and orders by id COLLATE \"C\"", () => {
    const { text, params } = buildQuery("", { corpusId: "c1", subject: "s" }, { corpus: "c1" }, "");
    expect(text).toMatch(/tenant_id = \$1[\s\S]*corpus_id = \$2[\s\S]*subject = \$3/i);
    expect(text).toContain('ORDER BY recorded_seq ASC, id COLLATE "C" ASC');
    expect(params).toEqual(["", "c1", "s"]);
  });

  it("prepends the schemaPrefix to the table identifier", () => {
    const { text } = buildQuery("tenant_a.", { corpusId: "c1" }, undefined, "");
    expect(text).toContain("FROM tenant_a.claims");
  });

  it("with no force and no plan predicates still emits WHERE tenant_id = $1 (always present)", () => {
    const { text, params } = buildQuery(
      "",
      {} as unknown as Parameters<typeof buildQuery>[1],
      undefined,
      ""
    );
    expect(text).toContain("WHERE tenant_id = $1");
    expect(params).toEqual([""]);
  });

  it("adds forced profile predicate after corpus_id when present", () => {
    const { text, params } = buildQuery("", { corpusId: "c1" }, { corpus: "c1", profile: "p1" }, "");
    expect(text).toMatch(/tenant_id = \$1 AND corpus_id = \$2 AND profile = \$3/);
    expect(params).toEqual(["", "c1", "p1"]);
  });

  it("adds plan predicates in order: subject, key, scopeHash, recordedAtMost, status, runIds", () => {
    const { text, params } = buildQuery(
      "",
      {
        corpusId: "c1",
        subject: "s",
        key: "k",
        scopeHash: "h",
        recordedAtMost: 100,
        status: ["validated", "deprecated"],
        runIds: ["r1", "r2"],
      },
      undefined,
      ""
    );
    expect(text).toContain(
      "subject = $2 AND key = $3 AND scope_hash = $4 AND recorded <= $5 AND status IN ($6, $7) AND run_id IN ($8, $9)"
    );
    expect(params).toEqual(["", "s", "k", "h", 100, "validated", "deprecated", "r1", "r2"]);
  });

  it("with a real tenantId, leads with tenant_id = $1 and renumbers every following predicate", () => {
    const { text, params } = buildQuery(
      "",
      { corpusId: "c1", subject: "s", status: ["validated"] },
      { corpus: "c1", profile: "p1" },
      "acme"
    );
    expect(text).toContain(
      "WHERE tenant_id = $1 AND corpus_id = $2 AND profile = $3 AND subject = $4 AND status IN ($5)"
    );
    expect(params).toEqual(["acme", "c1", "p1", "s", "validated"]);
  });

  it("skips empty status/runIds arrays but still emits the leading tenant_id condition", () => {
    const { text, params } = buildQuery("", { corpusId: "c1", status: [], runIds: [] }, undefined, "");
    expect(text).toContain("WHERE tenant_id = $1");
    expect(text).not.toContain("status IN");
    expect(text).not.toContain("run_id IN");
    expect(params).toEqual([""]);
  });
});

describe("insertClaimSql", () => {
  it("uses INSERT ... ON CONFLICT (id) DO UPDATE, prepends the prefix, and includes tenant_id", () => {
    const sql = insertClaimSql("tenant_a.");
    expect(sql).toContain("INSERT INTO tenant_a.claims");
    expect(sql).toMatch(/ON CONFLICT\s*\(id\)\s*DO UPDATE/i);
    expect(sql).toContain("tenant_id");
    expect(sql).toContain("$27");
    expect(sql).toContain("tenant_id = EXCLUDED.tenant_id");
  });
});

describe("headHashSql", () => {
  it("selects entry_hash filtered by corpus_id and tenant_id, ordered by seq_pk descending limit 1", () => {
    const sql = headHashSql("tenant_a.");
    expect(sql).toContain("FROM tenant_a.claim_events");
    expect(sql).toContain("corpus_id = $1");
    expect(sql).toContain("AND tenant_id = $2");
    expect(sql.toLowerCase()).toContain("order by seq_pk desc limit 1");
    expect(sql).toContain("entry_hash");
  });
});

describe("appendEventSql", () => {
  it("inserts into claim_events with the prefix applied and includes tenant_id as the 12th column", () => {
    const sql = appendEventSql("tenant_a.");
    expect(sql).toContain("INSERT INTO tenant_a.claim_events");
    expect(sql).toContain("tenant_id");
    expect(sql).toContain("$12");
  });
});

describe("putIdempotencySql", () => {
  it("uses ON CONFLICT (scope, key, tenant_id) DO NOTHING", () => {
    const sql = putIdempotencySql("tenant_a.");
    expect(sql).toContain("INSERT INTO tenant_a.idempotency");
    expect(sql).toContain("tenant_id");
    expect(sql).toMatch(/ON CONFLICT\s*\(scope,\s*key,\s*tenant_id\)\s*DO NOTHING/i);
  });
});

describe("putAnchorSql", () => {
  it("uses ON CONFLICT (tenant_id, corpus_id, epoch_id) DO UPDATE", () => {
    const sql = putAnchorSql("tenant_a.");
    expect(sql).toContain("INSERT INTO tenant_a.audit_anchors");
    expect(sql).toContain("tenant_id");
    expect(sql).toMatch(/ON CONFLICT\s*\(tenant_id,\s*corpus_id,\s*epoch_id\)\s*DO UPDATE/i);
  });
});
