# Design: Publish mneme as a consumable built package (`@brettnye/mneme`)

**Date:** 2026-07-03
**Status:** Approved (brainstorm) — ready for planning
**Goal:** Make mneme a published, version-pinnable, built package so the sibling repo **ai-os** can depend on it as a normal external dependency (`@brettnye/mneme@<version>`), the way it depends on `@anthropic-ai/sdk`. Prerequisite for ai-os "George v2, Child 1, Slice 3 — the Mneme belief spoke" (Mneme embedded as read/write ports `recall`/`remember` over SQLite).

---

## 1. Problem (verified against the repo, 2026-07-03)

mneme is source-only and unconsumable by an external, ai-os-only CI checkout:

1. **No build output.** `package.json` `exports` point at raw `./src/*.ts` (`.`, `./surface`, `./cli`, `./mcp`, `./audit`, `./audit/aws`). `tsconfig.json` has `outDir: dist`/`rootDir: src` but **no `declaration`**, is not composite, has no build script, and `include: ["src/**/*.ts"]` pulls in the 123 colocated `*.test.ts` files plus `types: ["vitest/globals"]`. A consumer's strict `tsc -b` cannot type-check against raw `.ts` from `node_modules`.
2. **No `version` field** — cannot be published or version-pinned.
3. **`@types/better-sqlite3` is a devDependency**, but the root barrel (`src/index.ts` → `createSqliteAdapter` → `better-sqlite3`) leaks that type into the public API. Under a registry/`file:` install, devDeps are not installed → consumers hit "could not find a declaration file for 'better-sqlite3'." `better-sqlite3` is a native dep consumers must have, so it and its types must be real dependencies.
4. **Good constraint to preserve:** the heavy `@huggingface/transformers` is reached only via a dynamic `await import()` in `src/adapters/embedding/transformers-local.ts` and is re-exported by **no** barrel — so it stays out of the public type graph. Keep it lazy/dev-only; do **not** promote it into `dependencies`.

### Verified repo facts that shape the approach
- All 1019 relative imports in `src/` already use explicit `.js` extensions → plain `tsc` emit is clean; no bundler needed.
- `Session` and `openSession` **are** exported from `mneme/surface` (`src/surface/index.ts`) — the audit's worry was unfounded. They are not on the root barrel, which is fine: ai-os imports them from `mneme/surface`.
- Tests are colocated inside `src/` (123 `*.test.ts`, incl. `*.property.test.ts`) → the build **must** exclude them and drop `vitest/globals` types.
- The repo's own `.mcp.json` and the user's global Claude Code MCP config invoke `bin/mneme-mcp.ts` **directly via tsx** (`node --import tsx bin/mneme-mcp.ts`, absolute path in `docs/USING-MNEME.md`). `bin/mneme.smoke.test.ts` runs `tsx bin/mneme.ts bogus`. → **`bin/*.ts` must not be moved or deleted.**
- Git remote: `https://github.com/BrettNye/Mneme.git` (owner `BrettNye` → npm scope `@brettnye`).

---

## 2. Decisions settled in brainstorming

| Decision | Choice |
|---|---|
| Registry | **GitHub Packages, private**, scope/name **`@brettnye/mneme`** (matches repo owner). |
| Build strategy | **Plain `tsc` emit, non-composite.** No bundler. Dedicated `tsconfig.build.json`. |
| `better-sqlite3` | Stays a **regular `dependency`**; promote **`@types/better-sqlite3` → `dependencies`**. Not a peer. |
| `@types/*` promotion | Only `@types/better-sqlite3`. `@types/node` stays dev (consumers supply their own). |
| Ship raw src? | **Yes** — `files: ["dist", "src", "bin", "README.md"]` so declaration/source maps resolve. |
| Version | **`0.1.0`** (first pre-1.0 cut). |

---

## 3. Design

### 3.1 Build pipeline — `tsconfig.build.json`
New file extending `tsconfig.json`, overriding:
```jsonc
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "types": []            // drop vitest/globals (test-only)
  },
  "include": ["src/**/*.ts"],
  "exclude": ["**/*.test.ts", "**/*.property.test.ts", "bench", "examples", "node_modules", "dist"]
}
```
- Inherits `target ES2022`, `module/moduleResolution NodeNext`, `strict`, `skipLibCheck: true` (required so the transformers `.d.ts` self-check does not fail the build), `outDir: dist`, `rootDir: src`.
- Emit is 1:1: `src/index.ts → dist/index.js` + `dist/index.d.ts`; `src/surface/index.ts → dist/surface/index.js` + `.d.ts`; likewise `cli`, `mcp`, `audit`, `audit/aws`.
- **Constraint #4 preserved:** `src/adapters/embedding/transformers-local.ts` compiles to `dist/adapters/embedding/transformers-local.{js,d.ts}` but is exported by no barrel, so no public subpath `.d.ts` traverses into `@huggingface/transformers`. It remains out of the consumer type graph and out of `dependencies`.

### 3.2 package.json scripts
- `"build": "tsc -p tsconfig.build.json"`
- `"clean": "node -e \"require('fs').rmSync('dist',{recursive:true,force:true})\""` (no new dependency)
- `"prepack": "npm run clean && npm run build"` — every `npm pack`/`npm publish` rebuilds fresh.
- Existing scripts (`test`, `typecheck`, `mneme`, `mneme-mcp`, eval/pressure) are unchanged.

### 3.3 Bins that work from the build
- Add `src/bin/mneme.ts` and `src/bin/mneme-mcp.ts`:
  - Shebang `#!/usr/bin/env node` (tsc preserves a leading shebang).
  - Import from `../cli/index.js` / `../mcp/index.js` (same rootDir=src, so they emit to `dist/bin/*.js` importing `../cli/index.js` → `dist/cli/index.js`).
  - Body identical to the existing `bin/*.ts` shims; a comment cross-references the tsx-dev twin.
- `package.json` `"bin"` → `{ "mneme": "./dist/bin/mneme.js", "mneme-mcp": "./dist/bin/mneme-mcp.js" }`.
- **Unchanged and still working:** `bin/mneme.ts`, `bin/mneme-mcp.ts` (tsx-dev + repo `.mcp.json` + user's global MCP config), dev scripts `"mneme"/"mneme-mcp"`, `bin/mneme.smoke.test.ts`.
- Rationale for the ~3-line duplication: the dev entrypoints run via `tsx` (shebang `#!/usr/bin/env -S npx tsx`, relative base `bin/`); the published entrypoints run via compiled `node` (shebang `#!/usr/bin/env node`, relative base `src/bin/`). Different runtime + different import base → genuinely distinct artifacts. Consolidating would break the user's live MCP config.

### 3.4 package.json metadata & exports
- `"name": "@brettnye/mneme"`, `"version": "0.1.0"`.
- `"main": "./dist/index.js"`, `"types": "./dist/index.d.ts"`, `"type": "module"` (unchanged).
- `exports` (each subpath gains `types` + `import`; `types` first per NodeNext ordering):
```jsonc
"exports": {
  ".":          { "types": "./dist/index.d.ts",          "import": "./dist/index.js" },
  "./surface":  { "types": "./dist/surface/index.d.ts",  "import": "./dist/surface/index.js" },
  "./cli":      { "types": "./dist/cli/index.d.ts",      "import": "./dist/cli/index.js" },
  "./mcp":      { "types": "./dist/mcp/index.d.ts",       "import": "./dist/mcp/index.js" },
  "./audit":    { "types": "./dist/audit/index.d.ts",     "import": "./dist/audit/index.js" },
  "./audit/aws":{ "types": "./dist/audit/aws/index.d.ts", "import": "./dist/audit/aws/index.js" }
}
```
- Dependencies:
  - **`dependencies`:** `@modelcontextprotocol/sdk`, `better-sqlite3`, `zod`, **`@types/better-sqlite3` (moved from dev)**.
  - **`devDependencies`:** `@huggingface/transformers`, `@types/node`, `fast-check`, `tsx`, `typescript`, `vitest`.
  - **`peerDependencies` / meta:** `@aws-sdk/client-kms`, `@aws-sdk/client-s3` (optional) — unchanged.
- `"files": ["dist", "src", "bin", "README.md"]`.
- `"repository": { "type": "git", "url": "git+https://github.com/BrettNye/Mneme.git" }`.
- `"publishConfig": { "registry": "https://npm.pkg.github.com" }` (contains no secret — safe to commit).

### 3.5 Publish to GitHub Packages (gated on a credential)
- `npm publish` to GitHub Packages requires a GitHub PAT with `write:packages` — **a secret the implementing agent does not hold.**
- The plan makes the package fully publish-ready and **stops at a gate**: the user runs the publish (e.g. `! npm publish` with the token in an uncommitted `.npmrc` or `NODE_AUTH_TOKEN` env), or supplies a token for the agent to use. The token is **never committed**; `.npmrc` containing a token must be gitignored if created.
- Deliverable for the consumer side (documented, not built here) — the ai-os `.npmrc`:
  ```
  @brettnye:registry=https://npm.pkg.github.com
  //npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}   # token needs read:packages
  ```
  Then ai-os pins `"@brettnye/mneme": "0.1.0"`.

### 3.6 External-consumer smoke proof (the acceptance gate — no registry needed)
Independent of the publish/token step:
1. `npm run build` then `npm pack` → `brettnye-mneme-0.1.0.tgz`.
2. In a scratch dir **outside the repo**, `npm install <tarball>` (compiles native `better-sqlite3`; pulls `@modelcontextprotocol/sdk`, `zod`, `@types/better-sqlite3`).
3. Write `consumer.ts` importing the exact ai-os API:
   - from `@brettnye/mneme/surface`: `openSession`, type `Session`.
   - from `@brettnye/mneme`: `remember`, `recall`, `ensureCorpus`, `createSqliteAdapter`, `createMneme`, and types `RememberArgs`, `RememberResult`, `RecallArgs`, `RecallResult`, `RecallDeps`, and belief-equivalent types `RecallMatch` / `Claim`.
   - Plus a minimal `tsconfig.json` (`strict`, `module/moduleResolution NodeNext`, `noEmit`).
4. **Type-check gate:** `npx tsc --noEmit` passes → proves types (incl. `better-sqlite3`) resolve for an external consumer.
5. **Runtime gate:** run `consumer.ts` (via `tsx`): `openSession(':memory:')` → `ensureCorpus` → `remember(...)` → `recall(...)`; assert the written belief is returned.

### 3.7 Regression guarantees
- The full existing test suite (~3286 tests) stays green — the change is additive (new build config, dependency move, new `src/bin/*`, `package.json` metadata); **no runtime source under `src/` changes semantics.**
- CLI and MCP still run via the unchanged `bin/*.ts` (dev) and now also via `dist/bin/*.js` (published).

---

## 4. Acceptance criteria (traceable)

- [ ] mneme builds to `dist` with `.d.ts` for all exported subpaths (`.`, `./surface`, `./cli`, `./mcp`, `./audit`, `./audit/aws`); `exports`/`types`/`main` point at built output; bins (`mneme`, `mneme-mcp`) run from the build.
- [ ] The ai-os-consumed API type-checks cleanly for an **external** consumer: `openSession`, `remember`, `recall`, `ensureCorpus`, `createSqliteAdapter`/`createMneme`, and types `Session`, `RememberArgs`/`RememberResult`, `RecallArgs`/`RecallResult`/`RecallDeps`, belief-equivalents. `Session` + recall-deps types confirmed exported from a public barrel (`mneme/surface`).
- [ ] `better-sqlite3` + its types resolve for an external consumer (real dep); `@huggingface/transformers` stays lazy/out of the type graph and out of `dependencies`.
- [ ] `version` set (`0.1.0`); package prepared and published to GitHub Packages `@brettnye/mneme` (publish gated on the user's token).
- [ ] Full existing test suite (~3286) green; CLI + MCP still run.
- [ ] Smoke check passes: from a scratch dir outside the repo, install the built/packed package, `tsc --noEmit`, and run `openSession(':memory:')` → `remember` → `recall`.
- [ ] Reported to the user: final package **name + version** for pinning in ai-os slice 3, plus the ai-os `.npmrc` snippet.

## 5. Out of scope / YAGNI
- No bundler, no composite/project-references, no monorepo restructure.
- No changes to Mneme's runtime algebra, surface API, or MCP tool set.
- No CI workflow authoring (publish is a gated manual step this cycle); a `publish.yml` GitHub Action can follow later if desired.
- No relocation/removal of `bin/*.ts` (would break the live MCP config).
