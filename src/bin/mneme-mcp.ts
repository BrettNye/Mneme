#!/usr/bin/env node
import { runStdio } from "../mcp/index.js";

runStdio().catch((err) => {
  console.error(err);
  process.exit(1);
});
