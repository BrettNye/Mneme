import { describe, it, expect } from "vitest";
import { main } from "./conf-serving-sweep.js";

describe("conf-serving-sweep --smoke", () => {
  it("runs the gate logic network-free and exits 0", async () => {
    const code = await main(["--smoke"]);
    expect(code).toBe(0);
  });
});
