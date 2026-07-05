# Design: Publish mneme as a consumable built package (`@quarry-systems/mneme`)

**Date:** 2026-07-03
**Status:** Approved (brainstorm) + spec-audited (2026-07-03) — ready for planning
**Goal:** Make mneme a published, version-pinnable, built package so the sibling repo **ai-os** can depend on it as a normal external dependency (`@quarry-systems/mneme@<version>`), the way it depends on `@anthropic-ai/sdk`. Prerequisite for ai-os "George v2, Child 1, Slice 3 — the Mneme belief spoke" (Mneme embedded as read/write ports `recall`/`remember` over SQLite).

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
- Tests are colocated inside `src/` (123 `*.test.ts`, incl. `*.property.test.ts`) → the build **must** exclude them (and swap `vitest/globals` for `node` types — see audit finding A1).
- The repo's own `.mcp.json` and the user's global Claude Code MCP config invoke `bin/mneme-mcp.ts` **directly via tsx** (`node --import tsx bin/mneme-mcp.ts`, absolute path in `docs/USING-MNEME.md`). `bin/mneme.smoke.test.ts` runs `tsx bin/mneme.ts bogus`. → **`bin/*.ts` must not be moved or deleted.**
- Git remote: `https://github.com/BrettNye/Mneme.git`. **The repo is PUBLIC** — the built artifact exposes nothing the source doesn't already; privacy is achieved at the *registry* layer, not by hiding the artifact.

### Audit findings folded in (spec-audit, 2026-07-03)
Verified by an actual trial build + signature reads; corrections applied throughout:
- **A1 — `types: ["node"]`, not `types: []`.** Non-test `src` has 54 bare Node-global uses (`console`, `process`, …); `types: []` disables `@types/node` auto-inclusion and the build fails. With `types: ["node"]` the trial build exits 0 and emits all six subpath `.js`+`.d.ts` with **zero** test files in `dist`. (`@types/node` stays a devDep — used at build time, not shipped as a consumer dep.)
- **A2 — smoke call shape.** `openSession(opts: SessionOptions = {})` takes an object: use `openSession({ dbPath: ":memory:" })`, not `openSession(":memory:")`. `:memory:` is supported (`ensureDir` early-returns on it). `recall(session, args, deps)` and `remember(session, args)` confirmed as assumed.
- **A3 — build `exclude` simplifies** to `["**/*.test.ts"]` (`bench`/`examples` are outside `include: ["src/**/*.ts"]`; `*.property.test.ts` already matches `*.test.ts`).
- **A4 — self-reference will break the suite without a vitest alias.** `integrations/openclaw/memory-mneme/{index.ts,index.test.ts}` import `from "mneme/mcp"`, which today self-resolves to `src/mcp` via `exports`. When `exports` flips to `dist`, they resolve to `dist/mcp` (unbuilt/stale) → suite breaks. Fix = a vitest `resolve.alias` mapping `mneme/mcp` → `src/mcp/index.ts` (new task §3.8).
- **A5 — shebang preservation proven.** `tsc` preserves a leading `#!/usr/bin/env node` in emit (isolated scratch test).
- **A6 — transformers isolation proven.** In the trial `dist`, `@huggingface/transformers` appears in exactly one `.d.ts` (its own adapter), re-exported by no barrel, reachable by no public subpath → out of the consumer type graph. Constraint #4 holds.
- **A7 — publish hygiene gaps:** no `license` field / LICENSE file (publish warns); `.npmrc` not gitignored (token could be committed); no `engines`. All addressed in §3.4 / §3.8.

---

## 2. Decisions settled in brainstorming

| Decision | Choice |
|---|---|
| Registry | **Private npm, org scope `@quarry-systems/mneme`** (post-audit switch from GitHub Packages: repo is public so GH-Packages "private" was moot; private npm is genuinely private, uses the mainstream registry → simpler ai-os CI, and matches the Quarry portfolio brand). |
| Access | `publishConfig.access: "restricted"` (private; guards against accidental public publish of a scoped package). |
| Build strategy | **Plain `tsc` emit, non-composite.** No bundler. Dedicated `tsconfig.build.json`. |
| `better-sqlite3` | Stays a **regular `dependency`**; promote **`@types/better-sqlite3` → `dependencies`**. Not a peer. |
| `@types/*` promotion | Only `@types/better-sqlite3`. `@types/node` stays dev (build-time only; consumers supply their own). |
| Ship raw src? | **Yes** — `files: ["dist", "src", "bin", "README.md"]` so declaration/source maps resolve. |
| Version | **`0.1.0`** (first pre-1.0 cut). |
| License | **`UNLICENSED`** for now — accurate for a private package, silences the publish warning, fully reversible. The adoption-vs-ROI license choice (AGPL+dual-license / BSL / FSL / Elastic v2) is **deferred** and separable; revisit only if/when mneme is opened for external adoption. |

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
    "types": ["node"]      // swap vitest/globals → node: build needs @types/node ambient (54 bare Node-global uses), NOT vitest. [audit A1]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["**/*.test.ts"]   // [audit A3] bench/examples aren't in include; *.property.test.ts already matches
}
```
- Inherits `target ES2022`, `module/moduleResolution NodeNext`, `strict`, `skipLibCheck: true` (required so the transformers `.d.ts` self-check does not fail the build), `outDir: dist`, `rootDir: src`.
- **Proven:** the trial build (`tsc -p tsconfig.build.json`) exits 0; emits all six subpath `.js`+`.d.ts`; zero `*.test.*` in `dist`.
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
- `"name": "@quarry-systems/mneme"`, `"version": "0.1.0"`, `"license": "UNLICENSED"`.
- `"engines": { "node": ">=18" }` (matches `@modelcontextprotocol/sdk`; `better-sqlite3` unpinned). [audit A7]
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
- `"publishConfig": { "registry": "https://registry.npmjs.org", "access": "restricted" }` (default npm registry; `restricted` = private, guards against accidental public publish; no secret — safe to commit).

### 3.5 Publish to private npm (gated on a credential)
- `npm publish` of `@quarry-systems/mneme` requires an npm auth token with **publish** rights to the `@quarry-systems` org — **a secret the implementing agent does not hold.**
- The plan makes the package fully publish-ready and **stops at a gate**: the user runs the publish (`! npm publish` after `npm login`, or with `NODE_AUTH_TOKEN`/an uncommitted `.npmrc`), or supplies a token for the agent to use. The token is **never committed**; `.npmrc` is gitignored (§3.8).
- Deliverable for the consumer side (documented, not built here) — the ai-os `.npmrc` (private scoped install off the default registry):
  ```
  //registry.npmjs.org/:_authToken=${NPM_TOKEN}   # token needs read access to @quarry-systems
  ```
  Then ai-os pins `"@quarry-systems/mneme": "0.1.0"`.

### 3.6 External-consumer smoke proof (the acceptance gate — no registry needed)
Independent of the publish/token step:
1. `npm run build` then `npm pack` → `quarry-systems-mneme-0.1.0.tgz`.
2. In a scratch dir **outside the repo**, `npm install <tarball>` (compiles native `better-sqlite3`; pulls `@modelcontextprotocol/sdk`, `zod`, `@types/better-sqlite3`).
3. Write `consumer.ts` importing the exact ai-os API:
   - from `@quarry-systems/mneme/surface`: `openSession`, type `Session`.
   - from `@quarry-systems/mneme`: `remember`, `recall`, `ensureCorpus`, `createSqliteAdapter`, `createMneme`, and types `RememberArgs`, `RememberResult`, `RecallArgs`, `RecallResult`, `RecallDeps`, and belief-equivalent types `RecallMatch` / `Claim`.
   - Plus a minimal `tsconfig.json` (`strict`, `module/moduleResolution NodeNext`, `noEmit`).
4. **Type-check gate:** `npx tsc --noEmit` passes → proves types (incl. `better-sqlite3`) resolve for an external consumer.
5. **Runtime gate:** run `consumer.ts` (via `tsx`): `openSession({ dbPath: ":memory:" })` → `ensureCorpus(session, "test")` → `remember(session, …)` → `recall(session, …, deps)`; assert the written belief is returned. [audit A2 — object arg, not positional string]

### 3.7 Regression guarantees
- The full existing test suite (~3286 tests) stays green — the change is additive (new build config, dependency move, new `src/bin/*`, `package.json` metadata, vitest alias §3.8); **no runtime source under `src/` changes semantics.**
- CLI and MCP still run via the unchanged `bin/*.ts` (dev) and now also via `dist/bin/*.js` (published).

### 3.8 Keep the test suite green after `exports` → `dist` (audit A4) + publish hygiene (A7)
- **vitest `resolve.alias`.** `integrations/openclaw/memory-mneme/{index.ts,index.test.ts}` import `from "mneme/mcp"` — today a package self-reference resolving to `src/mcp` via `exports`; after the flip it would resolve to `dist/mcp` (unbuilt/stale). Add to `vitest.config.ts`:
  ```ts
  import path from "node:path";
  // …
  resolve: { alias: { "mneme/mcp": path.resolve(__dirname, "src/mcp/index.ts") } }
  ```
  This restores the exact resolution the tests have today (→ `src`), independent of the published `exports`. (Only `mneme/mcp` is self-referenced in real code; bare `mneme` appears only in JSDoc.)
- **`.gitignore`.** Add `.npmrc` (so a publish token can never be committed). `dist/` is already ignored.
- **No LICENSE file needed** for `UNLICENSED`; the `license` field suffices.

---

## 4. Acceptance criteria (traceable)

- [ ] mneme builds to `dist` with `.d.ts` for all exported subpaths (`.`, `./surface`, `./cli`, `./mcp`, `./audit`, `./audit/aws`); `exports`/`types`/`main` point at built output; bins (`mneme`, `mneme-mcp`) run from the build.
- [ ] The ai-os-consumed API type-checks cleanly for an **external** consumer: `openSession`, `remember`, `recall`, `ensureCorpus`, `createSqliteAdapter`/`createMneme`, and types `Session`, `RememberArgs`/`RememberResult`, `RecallArgs`/`RecallResult`/`RecallDeps`, belief-equivalents. `Session` + recall-deps types confirmed exported from a public barrel (`mneme/surface`).
- [ ] `better-sqlite3` + its types resolve for an external consumer (real dep); `@huggingface/transformers` stays lazy/out of the type graph and out of `dependencies`.
- [ ] `version` set (`0.1.0`), `license` set (`UNLICENSED`); package prepared and published to private npm `@quarry-systems/mneme` (publish gated on the user's npm token).
- [ ] Full existing test suite (~3286) green (incl. the vitest-alias fix so the openclaw self-reference still resolves to `src`); CLI + MCP still run.
- [ ] Smoke check passes: from a scratch dir outside the repo, install the built/packed package, `tsc --noEmit`, and run `openSession({ dbPath: ":memory:" })` → `remember` → `recall`.
- [ ] Reported to the user: final package **name + version** for pinning in ai-os slice 3, plus the ai-os `.npmrc` snippet.

## 5. Out of scope / YAGNI
- No bundler, no composite/project-references, no monorepo restructure.
- No changes to Mneme's runtime algebra, surface API, or MCP tool set.
- No CI workflow authoring (publish is a gated manual step this cycle); a `publish.yml` GitHub Action can follow later if desired.
- No relocation/removal of `bin/*.ts` (would break the live MCP config).
- **License business-model decision deferred** — `UNLICENSED` now; AGPL+dual-license / BSL / FSL / Elastic v2 evaluated only if/when mneme is opened for external adoption.
