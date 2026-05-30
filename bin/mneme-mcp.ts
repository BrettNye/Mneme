#!/usr/bin/env -S npx tsx
import { runStdio } from "../src/mcp/index.js";

runStdio().catch((err) => {
  console.error(err);
  process.exit(1);
});
