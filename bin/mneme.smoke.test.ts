import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

describe("cli bin smoke", () => {
  it("runs via tsx and reports a nonzero exit on an unknown command", () => {
    let code = 0;
    try { execFileSync("npx", ["tsx", "bin/mneme.ts", "bogus"], { stdio: "pipe", shell: true }); }
    catch (e) { code = (e as { status?: number }).status ?? 1; }
    expect(code).toBe(1);
  });
});
