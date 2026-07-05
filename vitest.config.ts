import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts", "test/**/*.test.ts", "examples/**/*.test.ts", "bin/**/*.test.ts", "bench/**/*.test.ts", "integrations/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // audit A4: keep the `from "mneme/mcp"` self-reference resolving to src,
      // independent of the published exports (which point at dist post-manifest).
      "mneme/mcp": fileURLToPath(new URL("./src/mcp/index.ts", import.meta.url)),
    },
  },
});
