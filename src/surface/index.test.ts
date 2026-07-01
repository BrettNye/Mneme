import { describe, it, expect } from "vitest";
import * as surface from "./index.js";

describe("surface barrel", () => {
  it("exposes the public surface as runtime values", () => {
    expect(typeof surface.openSession).toBe("function");
    expect(typeof surface.parseDsl).toBe("function");
    expect(typeof surface.importFile).toBe("function");
    expect(typeof surface.mappers).toBe("object");
    expect(typeof surface.formatQueryResult).toBe("function");
    expect(typeof surface.formatClaim).toBe("function");
  });

  it("does not expose corpus-store internals", () => {
    expect((surface as Record<string, unknown>).loadCorpora).toBeUndefined();
    expect((surface as Record<string, unknown>).saveCorpora).toBeUndefined();
  });

  it("exports explainRecall from the surface barrel", async () => {
    const mod = await import("./index.js");
    expect(typeof mod.explainRecall).toBe("function");
  });
});
