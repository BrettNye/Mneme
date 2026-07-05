// scripts/smoke-external-consumer.mjs — run with: node scripts/smoke-external-consumer.mjs
//
// Proves @quarry-systems/mneme is externally consumable:
//   1. npm run build (dist emit, incl. dist/bin/mneme.js + dist/bin/mneme-mcp.js)
//   2. npm pack -> a tarball (prepack reruns build)
//   3. install that tarball into a scratch dir OUTSIDE this repo
//   4. tsc --noEmit (strict, NodeNext) against consumer.ts in the scratch dir
//   5. runtime: openSession -> remember -> recall, assert the written belief is recalled
//   6. the built MCP bin loads and prints its stdio banner without throwing
//   7. the full existing test suite (npm test) is still green
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = process.cwd();
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit", shell: true });

// ── 1. Build ─────────────────────────────────────────────────────────────────
run("npm", ["run", "build"], repo);

const binMneme = join(repo, "dist", "bin", "mneme.js");
const binMnemeMcp = join(repo, "dist", "bin", "mneme-mcp.js");
if (!existsSync(binMneme)) throw new Error(`missing ${binMneme}`);
if (!existsSync(binMnemeMcp)) throw new Error(`missing ${binMnemeMcp}`);
const mnemeShebang = readFileSync(binMneme, "utf8").split("\n")[0].trim();
if (mnemeShebang !== "#!/usr/bin/env node") {
  throw new Error(`dist/bin/mneme.js: expected node shebang, got "${mnemeShebang}"`);
}

// ── 2. Pack ──────────────────────────────────────────────────────────────────
run("npm", ["pack"], repo); // -> quarry-systems-mneme-<version>.tgz (prepack reruns build)
const tgz = readdirSync(repo).find(
  (f) => f.startsWith("quarry-systems-mneme-") && f.endsWith(".tgz"),
);
if (!tgz) throw new Error("npm pack did not produce a quarry-systems-mneme-*.tgz tarball");

// ── 3. Scratch install OUTSIDE the repo ─────────────────────────────────────
const scratch = mkdtempSync(join(tmpdir(), "mneme-smoke-"));
writeFileSync(
  join(scratch, "package.json"),
  JSON.stringify({ name: "smoke", private: true, type: "module" }, null, 2),
);
writeFileSync(
  join(scratch, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2022",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        // Explicit: this scratch tsconfig's automatic @types/* inclusion is
        // unreliable under NodeNext moduleResolution with a nested
        // node_modules/@types (observed with TypeScript 6.0.3) — name the
        // ambient type packages the consumer needs explicitly.
        types: ["node"],
      },
      include: ["consumer.ts"],
    },
    null,
    2,
  ),
);
writeFileSync(
  join(scratch, "consumer.ts"),
  `import { openSession } from "@quarry-systems/mneme/surface";
import type { Session } from "@quarry-systems/mneme/surface";
import { remember, recall, ensureCorpus, createSqliteAdapter, createMneme } from "@quarry-systems/mneme";
import type {
  RememberArgs,
  RememberResult,
  RecallArgs,
  RecallResult,
  RecallDeps,
  RecallMatch,
  Claim,
} from "@quarry-systems/mneme";

// Referenced (not just for their types) so the import is exercised, not dead code.
void createSqliteAdapter;
void createMneme;

async function main(): Promise<void> {
  const session: Session = openSession({ dbPath: ":memory:" });
  const corpus = "smoke";
  ensureCorpus(session, corpus);

  const rememberArgs: RememberArgs = {
    subject: "project:smoke",
    key: "status",
    value: "external consumer works",
    corpus,
    confidence: 0.9,
  };
  const rememberResult: RememberResult = remember(session, rememberArgs);
  if (rememberResult.status !== "committed") {
    throw new Error(\`expected committed, got \${rememberResult.status}\`);
  }

  const recallDeps: RecallDeps = { embeddings: { rankFn: "jaccard" } };
  const recallArgs: RecallArgs = {
    about: "external consumer works",
    corpus,
  };
  const recallResult: RecallResult = await recall(session, recallArgs, recallDeps);

  const match: RecallMatch | undefined = recallResult.matches.find(
    (m) => m.id === rememberResult.id,
  );
  if (!match) {
    throw new Error("the written belief was not recalled");
  }

  const claim: Claim | undefined = session.inspect(corpus, rememberResult.id);
  if (!claim || claim.value !== "external consumer works") {
    throw new Error("session.inspect did not return the written Claim");
  }

  session.close();
  console.log("SMOKE OK: recalled the written belief");
}

main().catch((e) => {
  console.error("SMOKE FAIL", e);
  process.exit(1);
});
`,
);

run("npm", ["install", join(repo, tgz), "typescript", "tsx", "@types/node"], scratch);

// ── 4. Type-check gate ───────────────────────────────────────────────────────
run("npx", ["tsc", "--noEmit"], scratch);

// ── 5. Runtime gate ──────────────────────────────────────────────────────────
run("npx", ["tsx", "consumer.ts"], scratch);

// ── 6. Built MCP bin loads and prints its stdio banner without throwing ────
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [binMnemeMcp], {
    cwd: scratch,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let settled = false;
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    child.kill();
    reject(new Error(`dist/bin/mneme-mcp.js did not print its banner within 10s. stderr so far:\n${stderr}`));
  }, 10_000);
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    if (!settled && stderr.includes("mneme MCP server on stdio")) {
      settled = true;
      clearTimeout(timeout);
      child.kill();
      resolve();
    }
  });
  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    reject(err);
  });
  child.on("exit", (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    reject(new Error(`dist/bin/mneme-mcp.js exited early (code=${code}, signal=${signal}) before printing its banner. stderr:\n${stderr}`));
  });
});
console.log("dist/bin/mneme-mcp.js: stdio banner printed without throwing");

// ── 7. Full existing suite stays green ──────────────────────────────────────
run("npm", ["test"], repo);

console.log("external-consumer smoke PASSED");
