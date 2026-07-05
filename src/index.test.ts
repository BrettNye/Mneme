// Barrel smoke tests – verify the public root re-exports are present and functional.
//
// NOTE: Several AST constructor names clash with existing mneme.js stage-builder exports
// (leaf, sigma, tau, delta, rho, gamma, kappa).  Those are re-exported under an `ast`
// prefix to avoid duplicate-export errors (see src/index.ts for the aliasing).

import { describe, it, expect } from "vitest";

import {
  // AST constructors — aliased to avoid collision with existing stage-builder exports
  astLeaf,
  astSigma,
  astTau,
  astDelta,
  astRho,
  astGamma,
  astKappa,
  // Non-conflicting AST constructors — exported under their canonical names
  pi,
  combine,
  synthesize,
  resolve,
  aggregate,
  // Serialize / parse
  serializeExpr,
  parseExpr,
  // Replay
  replayStatus,
  // Async surface
  createMnemeAsync,
  createPostgresAdapter,
  rowLevelRouter,
  schemaPerTenantRouter,
  dbPerTenantRouter,
} from "./index.js";

describe("replay re-execution engine barrel re-exports", () => {
  it("exports aliased AST constructors (previously-conflicting names) as functions", () => {
    expect(typeof astLeaf).toBe("function");
    expect(typeof astSigma).toBe("function");
    expect(typeof astTau).toBe("function");
    expect(typeof astDelta).toBe("function");
    expect(typeof astRho).toBe("function");
    expect(typeof astGamma).toBe("function");
    expect(typeof astKappa).toBe("function");
  });

  it("exports non-conflicting AST constructors as functions", () => {
    expect(typeof pi).toBe("function");
    expect(typeof combine).toBe("function");
    expect(typeof synthesize).toBe("function");
    expect(typeof resolve).toBe("function");
    expect(typeof aggregate).toBe("function");
  });

  it("exports serializeExpr and parseExpr as functions", () => {
    expect(typeof serializeExpr).toBe("function");
    expect(typeof parseExpr).toBe("function");
  });

  it("exports replayStatus as a function", () => {
    expect(typeof replayStatus).toBe("function");
  });

  it("round-trips a leaf node through serializeExpr / parseExpr", () => {
    const node = astLeaf("test-corpus");
    const serialized = serializeExpr(node);
    const parsed = parseExpr(serialized);
    expect(parsed).toEqual(node);
  });

  it("round-trips a nested sigma node through serializeExpr / parseExpr", () => {
    const node = astSigma({ op: "subjectEq", value: "hello" }, astLeaf("c"));
    const serialized = serializeExpr(node);
    const parsed = parseExpr(serialized);
    expect(parsed).toEqual(node);
  });
});

describe("async surface barrel re-exports", () => {
  it("re-exports the async surface", () => {
    for (const f of [createMnemeAsync, createPostgresAdapter, rowLevelRouter, schemaPerTenantRouter, dbPerTenantRouter]) {
      expect(typeof f).toBe("function");
    }
  });
});
