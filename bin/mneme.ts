#!/usr/bin/env -S npx tsx
import { run } from "../src/cli/index.js";
run(process.argv.slice(2)).then((code) => process.exit(code));
