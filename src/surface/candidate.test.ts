import { describe, it, expect } from "vitest";
import { buildCandidateClaim } from "./candidate.js";
import { scalarConfidence } from "../core/confidence.js";
import { defaultConfidence, SURFACE_DEFAULTS } from "./types.js";

describe("buildCandidateClaim", () => {
  it("builds the identical candidate session.write built (schema string, defaults, coercion)", () => {
    const c = buildCandidateClaim(
      { subject: "s", key: "k", value: "v", confidence: 0.7 },
      { corpusId: "work", schemaVersion: "1" }
    );
    expect(c.schema).toBe("work@1");
    expect(c.confidence).toEqual(scalarConfidence(0.7));
    expect(c.workspace).toBe("work");
  });

  it("coerces a bare-number confidence via scalarConfidence", () => {
    const c = buildCandidateClaim(
      { subject: "s", key: "k", value: "v", confidence: 0.42 },
      { corpusId: "c", schemaVersion: "1" }
    );
    expect(c.confidence).toEqual(scalarConfidence(0.42));
  });

  it("passes a Confidence object through unchanged", () => {
    const conf = { distribution: "scalar" as const, parameters: { p: 0.9 }, raw: 0.9 };
    const c = buildCandidateClaim(
      { subject: "s", key: "k", value: "v", confidence: conf },
      { corpusId: "c", schemaVersion: "1" }
    );
    expect(c.confidence).toEqual(conf);
  });

  it("defaults confidence when omitted", () => {
    const c = buildCandidateClaim(
      { subject: "s", key: "k", value: "v" },
      { corpusId: "c", schemaVersion: "1" }
    );
    expect(c.confidence).toEqual(defaultConfidence());
  });

  it("uses custom profile/workspace/source from ctx when provided", () => {
    const c = buildCandidateClaim(
      { subject: "s", key: "k", value: "v" },
      { corpusId: "c", schemaVersion: "1", profile: "custom-profile", workspace: "custom-ws", source: "llm" }
    );
    expect(c.profile).toBe("custom-profile");
    expect(c.workspace).toBe("custom-ws");
    expect(c.source).toBe("llm");
  });

  it("defaults profile, workspace, and source when omitted from ctx", () => {
    const c = buildCandidateClaim(
      { subject: "s", key: "k", value: "v" },
      { corpusId: "corpus-x", schemaVersion: "1" }
    );
    expect(c.profile).toBe(SURFACE_DEFAULTS.profile);
    expect(c.workspace).toBe("corpus-x");
    expect(c.source).toBe(SURFACE_DEFAULTS.source);
  });

  it("record's own source overrides ctx.source", () => {
    const c = buildCandidateClaim(
      { subject: "s", key: "k", value: "v", source: "manual" },
      { corpusId: "c", schemaVersion: "1", source: "llm" }
    );
    expect(c.source).toBe("manual");
  });

  it("defaults valid interval when omitted", () => {
    const c = buildCandidateClaim(
      { subject: "s", key: "k", value: "v" },
      { corpusId: "c", schemaVersion: "1" }
    );
    expect(c.valid).toEqual(SURFACE_DEFAULTS.validInterval);
  });

  it("passes through scope, tags, and status", () => {
    const c = buildCandidateClaim(
      { subject: "s", key: "k", value: "v", scope: { project: "p" }, tags: ["a", "b"], status: "validated" },
      { corpusId: "c", schemaVersion: "1" }
    );
    expect(c.scope).toEqual({ project: "p" });
    expect(c.tags).toEqual(["a", "b"]);
    expect(c.status).toEqual("validated");
  });

  it("builds the corpusId@schemaVersion schema string from ctx", () => {
    const c = buildCandidateClaim(
      { subject: "s", key: "k", value: "v" },
      { corpusId: "myCorpus", schemaVersion: "42" }
    );
    expect(c.schema).toBe("myCorpus@42");
  });
});
