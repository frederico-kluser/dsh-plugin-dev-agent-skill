# Packaging, Publishing and CI for DeepSeek Harness Plugins

_Reference doc of the `dsh-plugin-dev-agent-skill` skill. This document teaches the full
release path of a Cordis plugin for DeepSeek Harness (DSH): how the source you
commit becomes a `.tgz` that `dsh plugin --profile web add <pkg>` activates,
and how to get that tarball to the npm registry safely and reproducibly._

Most facts below are verified in the real, shipped plugin package
`dsh-guarded-bot-orchestrator` at `/home/ondokai/Projects/deepseek-harness-mobile`
(truth = the files on disk). External claims about the npm registry carry their
official URL. Where a claim could not be verified it is marked `[UNVERIFIED]`.
Claims that measurement refuted are marked **refuted by real measurement** and
replaced by the correct fact — never taught as truth.

> **Preview mentality.** DSH is in *developer preview*. Every `0.x` release can
> break. This whole pipeline exists so that: (1) you never publish a broken
> source, (2) a break in the consumer is loud and attributable, and (3) the
> registry is the only source of truth for installs.

---

## 1. The full cycle: commit → build → pack → check → changelog → release → registry

The release path is **not** "commit and npm publish". It is a chain of gates,
each of which can fail independently, and each of which catches a class of
mistake the later ones cannot:

```
commit (trunk) → build (tsc, noEmitOnError) → pack (real tgz)
        ▲                                            │
        │                                            ▼
 prepublishOnly = build && package:check       package:check
        │                                     (publint && attw && check-tarball)
        │                                            │
        ▼                                            ▼
  changeset (version bump, changelog) ←── Conventional-commit title on PR
        │
        ▼
  release (OIDC trusted publishing) → malware-scan delay → poll w/ retry
        │
        ▼
  registry (npmjs.org) → consumer ; tarball: fallback
```

Ordering rules:

1. **`build` before `pack`.** `npm pack` wraps whatever `dist/` contains
   (`files: ["dist", …]`). If you pack before the build, you wrap stale or
   missing artifacts.
2. **`pack` before `check`.** Both `attw --pack .` and
   `scripts/check-tarball.mjs` consume the **real tarball**, not the source.
   `publint` lints the `package.json` surface. Order inside `package:check`
   matters mostly for fast failure: `publint` (cheapest) → `attw` (type
   resolution, needs a tarball) → `check-tarball` (filesystem assertion, needs
   a tarball).
3. **`check` before `publish`.** `prepublishOnly` runs when the npm CLI emits a
   publish; if it fails, no publish happens. This is your last chance to stop a
   broken tarball from reaching the registry.
4. **A changeset is a prerequisite of the *next* release, not of this build.**
   The author adds a changeset in the PR; `changeset version` (run by the
   release workflow) consumes pending changesets and produces the version bump
   + CHANGELOG entry.
5. **Release happens on merge to trunk, not on your branch.** Only the trunk
   has a `release` workflow (see §7, §8). Your branch only ever produces
   artifacts to verify, never publishes.

> The single most important mental model: **`dist/` is not "a build result", it
> is the release artifact.** If `dist/` is broken, you can publish a broken
> package and only find out on the consumer's machine. Every gate below exists
> to make that impossible, and **`noEmitOnError`** is the first and cheapest of
> them (§3).


---

## 2. The canonical package.json

This is the *whole* release-relevant surface. Every field has a reason; none is
decoration. See `/home/ondokai/Projects/deepseek-harness-mobile/package.json`
for the shipped original.

```json
{
  "name": "dsh-guarded-bot-orchestrator",
  "version": "0.1.0",
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/<owner>/<repo>.git"
  },
  "bugs": { "url": "https://github.com/<owner>/<repo>/issues" },
  "homepage": "https://github.com/<owner>/<repo>#readme",
  "files": [
    "dist",
    "cordis.patch.yml",
    "README.md",
    "LICENSE",
    "CHANGELOG.md"
  ],
  "engines": { "node": ">=24" },
  "os": ["linux", "darwin"],
  "packageManager": "pnpm@11.7.0",
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  },
  "scripts": {
    "lint": "oxlint . && eslint .",
    "typecheck": "tsc --noEmit",
    "build": "tsc -p tsconfig.build.json && tsc -p tsconfig.worker.json && tsc -p tsconfig.bin.json",
    "package:check": "publint && attw --pack . && node scripts/check-tarball.mjs",
    "prepublishOnly": "pnpm run build && pnpm run package:check"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": ">=4.0.0 <5"
  },
  "peerDependenciesMeta": {
    "@deepseek-ai/cordis": { "optional": true }
  }
}
```

Field-by-field rationale:

| Field | Value | Why |
| --- | --- | --- |
| `name` | scope-free, lowercase, kebab | npm publishes it as-is; reserve early (§10). |
| `version` | `0.x.y` while DSH is in preview | `1.0.0` is a promise you cannot keep before upstream exits preview (§6). |
| `type: "module"` | ESM | DSH is ESM-pure; CommonJS is rejected in `AGENTS.md`. The npm CLI has a CJS fallback only if you ship a `.cjs` entry. |
| `main` | `./dist/index.js` | The CJS resolver's default; harmless and expected by `publint`. |
| `types` | `./dist/index.d.ts` | The entry type. Points at the emitted `.d.ts`, never at the `types/` shims. |
| `exports` | **types-first, default-last** | `{ "types": …, "default": … }`. `types` must be the **first** key; a tool that stops at the first match finds the types. `default` is **last**. `publint`+`attw` exist to catch ordering mistakes. |
| `files` | `dist`, `cordis.patch.yml`, `README.md`, `LICENSE`, `CHANGELOG.md` | Exact allowlist that becomes the tarball. npm always adds `package.json`, `README`, `LICENSE`; declaring them is documentation. **`src/` and `types/` are deliberately out** (§4). |
| `engines.node` | `>=24` | Hard floor. pnpm 11 requires Node 22+; DSH targets Node 24+. Drives the DSH matrix too (§8). |
| `os` | `["linux","darwin"]` | Because a POSIX process-group supervisor (`detached` + `kill(-pid)`) is required; **Windows is out** on purpose (§8). |
| `packageManager` | `pnpm@<exact>` | Read by the CI `pnpm/setup` to pin the package manager. |
| `dsh.bundle.patch` | `"./cordis.patch.yml"` | **The** thing that makes `dsh plugin add` activate the bundle (§2.1). |
| `scripts.prepublishOnly` | `build && package:check` | Fires on `npm publish` / `changeset publish`; speaks to §1 gate order. |
| `scripts.package:check` | `publint && attw --pack . && node scripts/check-tarball.mjs` | The verification gate (§5). |
| `peerDependencies` | cordis range `>=4.0.0 <5` | Expresses the compatibility intent; `optional: true` because the host injects it, you don't install it. |
| `dependencies` | **one exact pin** (e.g. `{"grammy":"1.45.1"}`) | **Not** "zero dependencies of runtime". The honest claim is *one runtime dependency, loaded only by the worker process; the host plugin uses only `node:` builtins* (§9, anti-pattern "zero deps"). |
| `bin` | `{ "dsh-guard-setup": "./dist/bin/dsh-guard-setup.js" }` | Only if you ship a CLI. The target is the **emitted** artifact, never a `.ts` (a `.ts` bin is a symlink Node refuses to run). |

### 2.1 `dsh.bundle.patch`, _not_ `{}`

**Refuted by real measurement**: declaring `"dsh": { "bundle": {} }` does
**not** activate the bundle. Measured against `@deepseek-ai/dsh@0.1.0-rc.7` in a
clean `$DSH_HOME` (documented commit-by-commit in the real case):
`dsh/lib/plugin-9h8shc4d.js:32` decides activation on
`dsh?.bundle?.patch !== void 0`, and `dsh-app-boot/lib/index.js:548` **throws at
boot** when a listed bundle does not declare `.patch`. The registry's
`check-submission.mjs` gate accepts an empty object (`if (dsh.bundle) return {
ok: true }`), so `bundle:{}` would pass the *registry gate* and fail in the
*running product* — the worst combination. The working field is:

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" }
}
```

Verified at `/home/ondokai/Projects/deepseek-harness-mobile/package.json:61-64`.

### 2.2 Exports: types-first

Ordering is load-bearing, not style. `publint` and `attw` will flag you if you
get it wrong. The pattern for an ESM-only package:

```json
"exports": {
  ".": {
    "types": "./dist/index.d.ts",
    "default": "./dist/index.js"
  }
}
```


---

## 3. Build: multi-project `tsc`, and why `noEmitOnError` is critical

DSH plugins commonly have **more than one emission target**: the main entry
(`src/` → `dist/`), a separate worker process (`worker/` → `dist/worker/`), and
optionally a CLI (`bin/` → `dist/bin/`). A single `tsc -p tsconfig.build.json`
cannot emit all of them, because `tsc` computes each output path as
`outDir + (path − rootDir)`, and there is **no single `rootDir`** that maps
`src/index.ts → dist/index.js`, `worker/telegram-bot.ts →
dist/worker/telegram-bot.js` and `bin/x.ts → dist/bin/x.js` at once. Trying to
fold a second root into one project yields `TS6059: File is not under
'rootDir'` — measured. The correct build is chained invocations:

```json
"build": "tsc -p tsconfig.build.json && tsc -p tsconfig.worker.json && tsc -p tsconfig.bin.json"
```

| Project | Emits | `rootDir` | declarations? | Notes |
| --- | --- | --- | --- | --- |
| `tsconfig.build.json` | `src/**` → `dist/` | `"src"` | `true` + `declarationMap` | so `src/index.ts` → `dist/index.js` (the published entry). |
| `tsconfig.worker.json` | `worker/**` → `dist/worker/` | `"."` | `false` | the worker is an executable, not public surface; its exports are not exposed. `rootDir:"."` lets it import `src/contracts/ipc.ts` → emitted `dist/src/contracts/ipc.js`. |
| `tsconfig.bin.json` | `bin/**` → `dist/bin/` | `"."` | `false` | the CLI, target of the `bin` field; `rootDir:"."` lets it import `src/**`. |

### 3.1 `noEmitOnError: true` — non-negotiable

**This is the single most important flag in the build.** By default `tsc`
**still emits** when there are type errors: it exits non-zero *and* writes
`dist/` anyway. The reference project measured this: with `src/index.ts`
reporting 4 type errors, `pnpm build` exited 2 and still left 232 files in
`dist/` — including a 73 kB `dist/index.js`. Because `npm pack` wraps whatever
`dist/` has (`files: ["dist", …]`), that broken artifact becomes a
**publishable tarball built from broken source**, and `check-tarball` would find
the three expected files and approve it.

With `noEmitOnError: true`, a red build leaves **no artifact behind**. Verify
this flag on every emission project (build, worker, bin):

```jsonc
// tsconfig.build.json (and worker/bin equivalents)
{
  "compilerOptions": {
    "noEmit": false,
    "noEmitOnError": true,   // red build ⇒ no dist/ ⇒ npm pack wraps nothing stale
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test", "worker", "bin"]
}
```

Verified at `/home/ondokai/Projects/deepseek-harness-mobile/tsconfig.build.json:50-62`.

- **declaration + sourceMap**: ship the `.d.ts` (types surface) and sourcemaps
  (debuggability). Don't ship `.ts` source — consumers get the `.d.ts`, and
  `src/` lives in the repo.
- **shebang**: a `bin/*.ts` is only executable if the **source** starts with
  `#!/usr/bin/env node`. `tsc` *preserves* a shebang on emit (line 1 of the
  `.js`), but never invents one. Without it, `npm i -g` creates the symlink and
  `exec` fails with "Exec format error" — only on the consumer's machine.


---

## 4. The tarball: what must be in it, what must not

The tarball **is** the product. `scripts/check-tarball.mjs` asserts it in both
directions (require presence and forbid absence).

**REQUIRED** (missing ⇒ fail):

- `dist/index.js`
- `dist/index.d.ts`
- `dist/worker/*.js` (the separate worker process, e.g. `dist/worker/telegram-bot.js`)
- `dist/bin/*.js` (the `bin` field target, if you ship a CLI)
- `dist/src/contracts/ipc.js` (the one `dist/src/*` file the worker needs at runtime if it imports a shared contract)
- `cordis.patch.yml` (the injection manifest — without it the package is useless)
- `README.md`, `LICENSE`, `CHANGELOG.md`

**FORBIDDEN** (present under one of these ⇒ fail):

- `src/`
- `types/`
- `test/`
- `docs/`
- `.env`

### 4.1 Why `src/` and `types/` are forbidden

- **`src/` is useless inside `node_modules`.** Node refuses to type-strip `.ts`
  inside `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). A
  published `src/` neither runs nor helps; it only bloats the tarball and leaks
  an un-minified copy of your code.
- **`types/` are shims, not your types.** `types/` in a DSH plugin is typically
  the **generated mirror** of third-party `@deepseek-ai/*` `.d.ts` used to
  *compile locally* (§11). Publishing them can **collide** with the consumer's
  own copies of the same packages and turn one build into two. Your published
  types are `dist/*.d.ts`, not `types/**/*.d.ts`.

### 4.2 `check-tarball` uses the **real pack**, never `--dry-run`

`--dry-run` prints what npm *would* emit. It does not prove the tarball exists,
decompresses, or that what's inside is what a consumer gets. The real gate runs
`pnpm pack --pack-destination <tmp>`, decompresses the `.tgz` with `tar -xzf`,
walks the `package/` root, and asserts the two lists **both ways** — it fails
whether a required file is missing *or* a forbidden prefix appears. A sketch:

```js
// scripts/check-tarball.mjs (skeleton; full version in the reference repo)
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const REQUIRED = [
  'dist/index.js',
  'dist/index.d.ts',
  'dist/worker/telegram-bot.js',
  'dist/bin/dsh-guard-setup.js',
  'dist/src/contracts/ipc.js',   // runtime need of the worker
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
]
const FORBIDDEN_PREFIXES = ['src/', 'types/', 'test/', 'docs/', '.env']

// 1. pnpm pack --pack-destination <work>   → the ONE .tgz it prints (absolute)
// 2. tar -xzf <tgz> -C <work>              → root dir is <work>/package
// 3. walk <work>/package and collect present set
// 4. every REQUIRED must be present; every FORBIDDEN prefix must be absent
```

The gate also **checks the target of the `bin` field**: if `bin` points at
`dist/bin/x.js` and that file is not in the tarball, the consumer's `npm i -g`
creates a broken symlink. Including the bin target in REQUIRED catches it.


---

## 5. Verification: `publint` and `attw` (and the tarball smoke)

`package:check` runs three independent checkers so a mistake in any one layer
surfaces:

```json
"package:check": "publint && attw --pack . && node scripts/check-tarball.mjs"
```

| Check | What it catches |
| --- | --- |
| `publint` | `exports` shape/order, `main`/`types`/`exports` consistency, missing `files`, "type" mismatch, bad `bin`, bad `engines`/`packageManager`. Detects the package manager and uses `pnpm pack`. Exits 1 on any error-level message. |
| `attw --pack .` | **AreTheTypesWrong**, a **compiler-driven** check against the **real tarball**. It runs `npm pack` in the folder, analyzes the resulting tarball (not `src/`), and deletes it. Catches `CJSResolvesToESM`, `FalseESM`, and missing type resolution from a consumer's perspective — including whether TypeScript can actually resolve your `exports` from `node_modules`. |
| `check-tarball.mjs` | Filesystem presence/absence assertion (§4), including `dist/src/contracts/ipc.js` as a runtime requirement and the `bin` target. |

### 5.1 The `esm-only` attw profile

For a deliberately **ESM-only** package, the default `strict` profile fails you
on one benign warning: a CJS `require()` resolving to an ESM file
(`CJSResolvesToESM`). That warning *describes the decision*, not a defect; a CJS
consumer can use dynamic `import()`. The reference repo sets this in
`.attw.json` (read automatically by the binary), because the canonical script
carries no flags:

```json
{ "profile": "esm-only" }
```

Measured: without it `attw --pack .` exits 1; with it, 0. There is no `.cjs`
entry for this package, and one is intentionally absent.

### 5.2 Smoke of the published artifact

Unit tests import the workspace. They cannot catch a `files`, `exports`, or ESM
error that only appears when a **consumer** imports the package from
`node_modules`. The reference CI does an install-and-import smoke of the
**tarball**, never the workspace:

```sh
pnpm pack --pack-destination /tmp
mkdir -p /tmp/smoke && cd /tmp/smoke && npm init -y >/dev/null
npm i /tmp/<name>-*.tgz
node --input-type=module -e "const p = await import('<name>'); \
  if (typeof p.apply !== 'function') { console.error('no apply()'); process.exit(1) }"
```


---

## 6. Versioning: changesets over semantic-release

**Choose `@changesets/cli`.** The deciding factor is who answers "is this
breaking?":

| Criterion | Changesets | semantic-release |
| --- | --- | --- |
| Who decides the bump | The **author**, explicitly, in a changeset | Inferred from the commit prefix |
| Changelog | Written in prose, per change | Generated from commit messages |
| Prerelease / `0.x` tracking an rc upstream | First-class | Possible, but plugin configuration |
| Grouped / delayed releases | Natural (accumulates changesets, versions when you want) | Publishes on every merge |
| Human approval flow | "Version Packages" PR is reviewable | None |

For a **security surface** plugin this matters. Changing a gate from `401` to
`403`, or changing a secret-hash format, *is* breaking for existing installs
even if the commit says `fix:`. A commit prefix cannot decide that; an explicit
changeset can.

Two more project-specific reasons:

- **The plugin version is coupled to the upstream rc (§11).** The most common
  change is "no code changed, but the compatible rc range changed" — a `patch`
  changeset with prose. semantic-release cannot infer that from a commit.
- **A readable CHANGELOG matters more than average**, because updating a
  security plugin touches what's exposed on the user's internet-facing surface.

### 6.1 Conventional Commits — enforced on the PR title, not locally

With squash-merge, the commit entering trunk **is the PR title**. So the
enforcement is a **PR-title lint job**, not a local `commitlint` hook (a hook
only disciplines whoever remembers to install it). Types (a project-local
convention): `feat`, `fix`, `sec` (security impact — deliberate extension so
security changes are greppable), `perf`, `docs`, `test`, `build`, `ci`,
`refactor`, `chore`.

### 6.2 Version scheme while upstream is in preview

The plugin lives in `0.x.y` **while DSH is in developer preview**:

| Change | Bump |
| --- | --- |
| Breaking for existing installs (config, secret format, gate behavior, patch schema) | **minor** — in `0.x`, minor IS the major |
| Adaptation to a new rc that does not break the user | patch |
| New backward-compatible feature | patch (or minor if it changes the config surface) |
| Security fix | patch + a `SECURITY:` line in the CHANGELOG + advisory if a CVE exists |

`1.0.0` only when DSH exits developer preview. While the upstream README says
"expect breaking changes", `1.0.0` would be a promise you cannot keep.

### 6.3 A changeset is mandatory for any PR touching `src/` or `cordis.patch.yml`

Two hard rules:

1. **Every PR that modifies `src/` (public surface) or `cordis.patch.yml`
   requires a changeset.** `cordis.patch.yml` is especially load-bearing: it is
   the *installation surface* — changed patch ⇒ the user must reinstall. A PR
   without a changeset when package files changed is rejected by the CI
   `changeset-gate` job (verified: `changeset status --since=<base>` exits 1
   with "Some packages have been changed but no changesets were found" when the
   PR touched package files without a changeset).
2. **Conventional-commit the title.** `feat:`/`fix:`/`sec:`/`docs:` already
   communicates intent to reviewers and feeds the changelog.


---

## 7. Publishing: OIDC trusted publishing, no `NPM_TOKEN`

### 7.1 The registry terrain changed

The era of "paste an `NPM_TOKEN` in a GitHub secret and forget it" is over:

| Fact | Date | Consequence |
| --- | --- | --- |
| npm **classic** tokens permanently revoked | **09/12/2025** (official: github.blog changelog 2025-12-09) | There is no `NPM_TOKEN` path anymore; granular tokens only. |
| Granular tokens max **90-day** lifetime | — | A token in a secret means quarterly rotation — one more reason for OIDC. |
| `npm login` gives a **2 h** session | — | Manual publishing is the exception, not the process. |
| **2FA on by default** for new packages | — | Configure 2FA *before* the first publish. |
| **Malware scanning** at publish time | since 28/07/2026 (github.blog changelog 2026-07-28) | Typical delay ~5 min, up to 15+. Post-publish automation needs **retry**, not a fixed `sleep`. |

**Decision: Trusted Publishing (OIDC), with no `NPM_TOKEN` anywhere.**

### 7.2 Trusted publishing — prerequisites

All verifiable up front (official: docs.npmjs.com/trusted-publishers):

1. **npm CLI ≥ 11.5.1** on the runner (and Node ≥ 22.14.0).
2. `permissions: { id-token: write }` on the **publish** job only.
3. `repository` in `package.json` matching the repo **exactly**.
4. Per-package configuration at `npmjs.com/package/<name>/access`, pointing the
   trusted publisher at owner / repo / workflow.
5. **Cloud runner** (self-hosted runners are not supported for trusted publishing).

### 7.3 Provenance

Under trusted publishing on GitHub Actions, **provenance attestations are
published by default** (github.blog changelog 2025-07-31). The reference
workflow still sets `NPM_CONFIG_PROVENANCE: 'true'` explicitly —
belt-and-suspenders that makes the contract explicit and survives a toolchain
change. Provenance links the tarball to the commit and workflow that produced
it (SLSA, §9).

### 7.4 The release workflow (reference)

Reference: `/home/ondokai/Projects/deepseek-harness-mobile/.github/workflows/release.yml`.

```yaml
name: release
on:
  push:
    branches: [main]        # trigger = trunk (if your trunk is master, use that)
  pull_request:            # for the changeset-gate job
  workflow_dispatch:

permissions: {}            # no ambient token; each job asks for exactly what it needs

env:
  HUSKY: '0'

jobs:
  # Reject a PR that changed package files without a changeset.
  changeset-gate:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@<SHA_pinned>
        with: { fetch-depth: 0 }          # changeset status needs history to the trunk
      - uses: pnpm/setup@<SHA_pinned>
        with:
          runtime: node@24
          install: false
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec changeset status --since=origin/main   # exit 1 ⇒ PR rejected

  release:
    if: github.event_name == 'push' || github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    permissions:
      contents: write        # create the tag + GitHub Release
      pull-requests: write   # open/update the "Version Packages" PR
      id-token: write        # the OIDC trusted publishing — the reason this job exists
    steps:
      - uses: actions/checkout@<SHA_pinned>
        with: { fetch-depth: 0 }
      - uses: pnpm/setup@<SHA_pinned>
        with: { runtime: node@24, install: false }
      - run: pnpm install --frozen-lockfile
      - run: pnpm run build            # build before publish (prepublishOnly would too, but fail early)

      - name: npm >= 11.5.1 (trusted-publishing requirement)
        run: npm i -g npm@latest && npm --version

      - name: Changesets version + publish (OIDC)
        uses: changesets/action@<SHA_pinned>
        with:
          version: pnpm exec changeset version
          publish: pnpm exec changeset publish
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # No NPM_TOKEN anywhere. Authentication is the job's OIDC token.
          NPM_CONFIG_PROVENANCE: 'true'

      - name: Package visible on registry (retry after malware scan)
        run: |
          set -eu
          pkg="$(python3 -c "import json;print(json.load(open('package.json'))['name'])")"
          ver="$(python3 -c "import json;print(json.load(open('package.json'))['version'])")"
          deadline=$(( $(date +%s) + 1260 ))   # ~21 min covers the 15+ min peak
          attempt=0
          while :; do
            attempt=$((attempt+1))
            if npm view "${pkg}@${ver}" version >/dev/null 2>&1; then
              echo "OK (tentativa ${attempt}): ${pkg}@${ver} visible."
              exit 0
            fi
            if [ "$(date +%s)" -ge "$deadline" ]; then
              echo "404 after the deadline == never published; investigate." >&2
              exit 1
            fi
            sleep 20
          done
```

Key points:

- **`permissions: {}` at the top.** The GitHub token is born permissionless;
  each job requests exactly what it needs. (Scorecard `Token-Permissions`
  check; the difference between a compromised workflow writing to your repo or
  not.)
- **SHA-pinned actions**, never tags (a tag is movable; a SHA is not).
- **No `continue-on-error`.** A step that exits non-zero fails the job; a
  failed job fails the check.
- **Post-publish poll with retry (~21 min).** The npm malware scan delays
  visibility (~5 min typical, 15+ in peak). An **immediate 404 is expected and
  does not fail**; only a 404 **after the ~21 min deadline** means "never
  published" — fail then.
- **Trigger is the trunk branch.** Use the actual trunk name. A `master`
  trigger on a `main` repo would never fire.
- **Staged publishing (optional, evaluate after the first release):**
  `npm stage publish` → `npm stage list/view/download` → `npm stage approve`
  (with 2FA; npm CLI ≥ 11.15.0, Node ≥ 22.14.0). The CI publishes, a human
  approves. Right model for a security plugin mid-term; adds a manual step
  before there's a routine. Official: docs.npmjs.com/staged-publishing.


---

## 8. CI — the PR gate and the matrix

Reference: `/home/ondokai/Projects/deepseek-harness-mobile/.github/workflows/ci.yml`.

### 8.1 Principles (shared with release.yml)

1. `permissions: {}` at the top; each job asks for `contents: read`.
2. Actions **pinned by SHA**.
3. **No `continue-on-error`** anywhere — a typecheck break can never "report
   only".
4. **CI calls the canonical scripts**, never the bare binaries. The wave gate
   runs `pnpm lint && pnpm typecheck && pnpm build && pnpm test`, and CI must
   measure exactly the same thing (script policy lives in config files, e.g.
   `.oxlintrc.json`, `eslint.config.js`, because the canonical script takes no
   flags).

### 8.2 `--frozen-lockfile` + committed lockfile

Every install in CI is `pnpm install --frozen-lockfile`. The `pnpm-lock.yaml`
is **committed**. Without it, CI and a developer install different trees. A
frozen install fails rather than drifts.

### 8.3 The matrix

The canonical Node/OS matrix is:

- `ubuntu-latest` × **Node 24**
- `ubuntu-latest` × **Node 26**
- `macos-latest` × **Node 24**

**Node 22 is out** — `engines.node >= 24`, so testing on 22 is noise, not
coverage. **Windows is out** — `"os": ["linux","darwin"]`, because the
supervisor depends on POSIX process groups (`detached` + `kill(-pid)`); the
macOS leg exists because `detached`/reparenting has darwin-specific semantics.

Use `fail-fast: false` so you see **all** broken combinations, not just the
first.

### 8.4 Required jobs

The canonical required status checks:

`lint`, `typecheck`, `build`, `test (ubuntu-latest, 24)`,
`test (ubuntu-latest, 26)`, `test (macos-latest, 24)`, `test-contract`,
`test-security`, `test-e2e`, `coverage`, `changeset`, `secrets-scan`.

**Not** required (they need real network or are informational): `dsh-compat`
(nightly, failure opens an issue), `live` (real network, `workflow_dispatch`),
`scorecard`, `codeql`, `example-smoke`.

Notes:

- `test` = unit + integration only. Coverage is a **separate job**
  (`coverage`); a test that also measures coverage is two commands disguised
  as one.
- `test:security` is the adversarial suite; it's the core of a security
  plugin, so a PR that breaks it cannot merge.
- **No PR job requires a secret.** If a job needs a secret it's a release/live
  job (not a PR gate).
- `secrets-scan` runs `gitleaks-action` over the full history — a Telegram
  bot token travels in the URL (`bot<n>:<token>`) and is trivial to commit by
  accident.

### 8.5 Build job extras

The `build` job verifies the D13 layout (`dist/index.js`,
`dist/index.d.ts`, `dist/worker/telegram-bot.js` exist) plus runs `publint`,
`attw --pack .`, and the tarball smoke (§5).


---

## 9. Supply chain

| Control | How | Why |
| --- | --- | --- |
| **Lockfile** | committed `pnpm-lock.yaml`, `--frozen-lockfile` everywhere | CI and dev test the same tree. |
| **One exact runtime dep** | `"dependencies": {"grammy": "1.45.1"}` | Exact pin; any addition beyond it requires a written justification in the PR. Honest claim = one runtime dep, loaded only by the worker; the host uses only `node:` builtins. ("Zero runtime deps" is refused — see honesty list at the end.) |
| **`minimumReleaseAge` (1440 min)** | pnpm 11 default; explicit 24 h window | Blocks a freshly-published compromised package; pnpm 11 also has `blockExoticSubdeps: true` by default. Don't lower it. Interacts with Renovate: a fresh-release PR stays blocked a day — intentional. |
| **SBOM / audit** | `pnpm audit` (non-blocking) in CI; `npm sbom --sbom-format cyclonedx` attached to the Release; `npm audit signatures` post-publish | What a corporate adopter asks for. |
| **OpenSSF Scorecard** | weekly workflow + badge | 23 checks; aim for: `Branch-Protection`, `Token-Permissions`, `Pinned-Dependencies`, `Dangerous-Workflow`, `Signed-Releases`, `Dependency-Update-Tool`. |
| **Provenance (SLSA)** | automatic under trusted publishing | Binds the tarball to the commit + workflow. |
| **`allowBuilds` (build scripts)** | pnpm 10/11 block dependency build scripts by default (`allowBuilds` explicit); npm v12 uses `npm approve-scripts` | A dependency `postinstall` runs **outside the sandbox** — a supply-chain vector. → **publish precompiled, never install-by-git** (§9.1). |
| **Vendoring** | copy Cordis/aux libs into `vendor/`, renamed to `@deepseek-ai/*`; `verify-vendored-links` ensures no external copy loads | The DSH repo itself vendors its core framework; total auditability. |

### 9.1 Publish precompiled — never install-by-git

Four reasons, in strength order:

1. **`pnpm >= 10` does not run dependency build scripts by default** — pnpm
   11 hardened more (`allowBuilds` explicit). Installing by
   `github:owner/repo` means the `prepare` that compiles TypeScript **never
   runs**, and the consumer gets a package **without `dist/`** — silent and
   confusing. Same for npm v12's `npm approve-scripts --allow-scripts-pending`.
2. **It's the ecosystem's canonical path:** `dsh plugin --profile web add
   <pkg-npm>` over the ~1.6k+ entries in the curated registry. Git install is
   the exception path.
3. **Speed and determinism:** seconds vs a clone; immutable tarball vs movable
   branch.
4. **Provenance:** only an npm-published package carries the SLSA attestation;
   a `github:owner/repo` install carries no provenance.

The `cordis.patch.yml` and the patch config live **inside** the tarball, so
`dsh plugin add` activates everything from the registry alone — no manual `cp`
of a manifest.


---

## 10. LICENSE / README / hygiene

### 10.1 LICENSE

Full **MIT** text at the repo root (`LICENSE`), included in the tarball
(`files`). The `license: "MIT"` field in `package.json` plus the file. For a
security/trust-sensitive plugin, pick MIT (the DSH upstream is MIT) unless you
have a specific reason not to.

### 10.2 README — four badges, above the fold

- **Exactly four badges**: **CI status**, **npm version**, **npm downloads**,
  **OpenSSF Scorecard**. npm downloads via shields `dw`/`dm`/`dy`/`d18m`.
- **No** license badge (GitHub already shows it), **no** stars/forks (the
  ecosystem median is ~2 stars; the real number demotivates), **no**
  "PRs Welcome" / "Made with ❤️" / **"Maintained: yes"** (that one ages and
  starts to lie).
- One-line install:

  ```sh
  dsh plugin --profile web add <pkg>
  ```

- **Above the fold** (first ~25 lines): the single-sentence benefit + the 4
  badges + the demo **GIF** + the one-line install + the **threat model in a
  few lines** (for a security surface, before any feature).

### 10.3 Hygiene files

- `SECURITY.md` — the *critical* file for a security plugin: supported range,
  how to report privately, safe-harbor, scope.
- `CONTRIBUTING.md` — contribution rules; includes "never edit `types/` by
  hand" (they're generated, §11).
- `CODE_OF_CONDUCT.md`.
- Issue/PR templates (including a `02-compat-break` template driven by §11).

### 10.4 Discovery: npm keyword + GitHub topics

- npm keyword `dsh-plugin` (the one deepseek.com/harness links as "Community
  Plugins"; ~1.9k packages use it at time of writing) plus `dsh`, `cordis`,
  `cordis-plugin`, `deepseek-harness`, `telegram-bot`, `cloudflare-tunnel`,
  `authentication`.
- GitHub **topics**: `dsh-plugin`, `dsh`, `cordis`, `deepseek-harness`,
  `telegram-bot`, `cloudflare-tunnel`, `self-hosted`. Constraints: max 20
  topics, ≤50 chars each, lowercase/digits/hyphens, only admins add them
  (GitHub docs).

### 10.5 Reserve the name early

Publish a **stub `0.0.1`** (documented, no functional code) as soon as you
commit to the name — the real risk is name-squatting between an announcement
and a real release, and reserving costs a 2-minute publish. Verify the name is
free first (`npm view <name>` → 404 in the registry).


---

## 11. Compatibility with an upstream in developer preview

### 11.1 `types/` is **generated**, never written by hand

The `.d.ts` in `types/` are a **literal mirror** of the published
`@deepseek-ai/*` tarballs, not a transcription of markdown.
`scripts/fetch-dsh-types.mjs`:

- downloads tarballs **pinned by exact version**,
- verifies each by **sha256** (a changed digest aborts without touching types/),
- extracts `package/lib/types/*.d.ts` into `types/<scope>/`,
- `--check` mode only verifies and fails on drift.

`types/` goes in `.gitattributes` as `linguist-generated=true`; hand-editing
it is a review failure. This is what made the reference project correct the
wrong hand-written shims (`@deepseek-ai/dsh-host-subprocess` was a 404 on npm;
the real package is `@deepseek-ai/dsh-subprocess` +
`@deepseek-ai/dsh-subprocess-local`).

### 11.2 Declare the supported range

Three layers:

1. **`peerDependencies` with `optional: true`** on `@deepseek-ai/cordis`,
   `>=4.0.0 <5`. Expresses intent; appears on npm; does not force an install
   of something the host injects. Do **not** peer-pin a `dsh-host-webserver`
   to a specific rc — an exact rc peer turns every upstream rc into an install
   failure for the user. The exact pin lives in `fetch-dsh-types.mjs`
   (build-time), not in `peerDependencies`.
2. **`docs/COMPATIBILITY.md`, generated.** A table `plugin version × DSH rc
   range × status (supported/deprecated/eol)`, produced by
   `scripts/gen-compat-table.mjs` from `dsh-compat.yml`. It is the source of
   truth cited by README and SECURITY.md. N/N-1 policy: the current upstream rc
   line + the previous one.
3. **Runtime assertion by *shape*, not by version string.** In `apply()`, the
   adapter checks the services have the expected shape:

   ```ts
   if (typeof ctx.webServer?.registerFallback !== 'function') {
     throw new Error('missing webServer.registerFallback — supported DSH: <range>')
   }
   ```

   Cheaper and more robust than a version-string check, because upstream
   renames services without bumping major (it is in `0.x`).

**Important — there is NO declarative compatibility field.** The candidate
`dsh.compatibility` / `engines.dsh` does **not exist** `[UNVERIFIED]`
(verified against the `.d.ts` and READMEs in the reference range
`0.1.0-rc.7 .. 0.1.1-rc.1`). The supported range is **documentation + runtime
assertion**, not a declarative contract.

### 11.3 Runbook: upstream broke

The reference project keeps a decision table (trigger: compatibility job fails
at night, or a `02-compat-break` issue arrives):

| Break class | Signal | Action |
| --- | --- | --- |
| Service renamed (`webServer` → `httpServer`) | `test:contract` flags missing symbol | Adjust **only** the adapter; `patch` changeset; update COMPATIBILITY.md. |
| Signature changed (`spawn(cmd,args,opts)` → `spawn(spec)`) | Typecheck fails against new `.d.ts` | Adjust adapter; if the **user** notices a difference, bump is `minor`. |
| Event removed (e.g. `http/auth-check`) | Contract breaks; integration turns falsely green | Highest priority: a waterfall that doesn't run is a gate that doesn't protect. |
| `cordis.patch.yml` schema changed | DSH rejects boot | **minor** bump (the user must reinstall the manifest), highlighted CHANGELOG warning. |
| Package added/removed in `@deepseek-ai` scope | `fetch-dsh-types.mjs` fails | Update pins; investigate if there's a new capability seam. |


---

## 12. Anti-patterns to avoid

| Anti-pattern | Why it's wrong | The correct move |
| --- | --- | --- |
| `"dsh": { "bundle": {} }` | **Refuted by measurement**: passes the registry gate, fails in the running product (`dsh?.bundle?.patch !== void 0` decides activation; `app-boot` throws without `.patch`). | `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` (§2.1). |
| `npm pack --dry-run` as the gate | Lists only what npm *would* emit; proves nothing about the real `.tgz`. | Run the **real pack**, decompress, assert both lists (check-tarball, §4.2). |
| Publishing `src/` / `types/` | `src/` is useless in `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`); `types/` are shims that collide in the consumer. | Keep them out of `files`; ship `dist/*.d.ts` (§4.1). |
| No `noEmitOnError` | A red build still writes `dist/`; `npm pack` wraps it → publishable broken source. | `noEmitOnError: true` on every emission project (§3.1). |
| `NPM_TOKEN` in a secret | Classic tokens are permanently revoked (09/12/2025); granular tokens cap at 90 days. | Trusted publishing / OIDC, `id-token: write` (§7). |
| semantic-release for a security plugin | "Is this breaking?" can't be inferred from a commit prefix. | `@changesets/cli`, author-declared bumps (§6). |
| Node 22 in the test matrix | Package declares `>=24`; testing on 22 is noise. | Matrix: ubuntu 24/26 + macos 24; Node 22 and Windows out (§8.3). |
| A badge shelf | Ten badges read as filler; license/stars/"maintained:yes" add nothing or lie. | Exactly CI, npm version, npm downloads, Scorecard (§10.2). |
| install-by-git (`github:owner/repo`) | pnpm ≥ 10 doesn't run dep build scripts; consumer gets no `dist/`. | Publish precompiled to npm (§9.1). |
| Literal secret in `cordis.patch.yml` | A manifest is versioned and shareable; a secret there is a commit away from leaking. | Generate secrets in the plugin (CSPRNG → `0600` state file); `!!js` **only** for non-sensitive config values. |
| An `insert` whose `id` collides | **Fail-open, silent**: produces two rows with the same id, exit 0, no warning. | Insert only your own plugin's id, which no other package declares (§12.1). |
| An `override` whose `id` doesn't match | **Fail-open, silent**: skipped with a stderr note and exit 0 — the thing you wanted to configure just doesn't happen. | Know the target id; verify. |

### 12.1 `cordis.patch.yml` golden rules (security of the bundle)

A **bundle** `cordis.patch.yml` is applied **automatically to everyone who
installs the package**. A throwing expression there isn't "a bad config" — it
produces a `dsh` that **won't boot** for a user who only ran
`dsh plugin add`. Rules:

1. **No bundle-patch expression throws.** Missing value → empty value; the
   plugin treats "empty" as "not configured" (a legitimate, documented state).
   `fail loud at load` stays — but inside the plugin (`assertSecureBind`,
   `assertUsableCredential`), and in **Layer 2 (Profile)**, which is an
   operator's explicit choice.
2. **`!!js` only for non-sensitive values.** Never derive a credential from it
   via the environment (the old `Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`)`
   pattern failed open: with both vars missing it interpolated "undefined" and
   produced a valid, fixed, derivable credential). Credentials are generated by
   the plugin and their digest lives in a `0600` state file.
3. **Row order carries no semantics.** `@deepseek-ai/dsh-base/cordis.patch.yml`
   says literally "Row order carries no load semantics (activation is
   service-availability driven)". Activation is driven by `inject` service
   availability, not by YAML order. Do not build anything that depends on order.

The two silent failure modes above (collision and non-match) make the golden
rule concrete: **never target another package's `id` from a bundle patch**.

---

## Claims this doc explicitly rejects as facts

These appear in community materials and were **refuted by real measurement or
are not confirmed** — if you read them, treat them as wrong until proven:

- `"dsh": { "bundle": {} }` activates → **refuted** (activation requires
  `.patch`; `app-boot` throws without it). Correct: `dsh.bundle.patch` (§2.1).
- "Zero runtime dependencies" → **refuted** for an honest plugin: it has **one**
  runtime dep (`grammy`), loaded only by the worker; the host uses only
  `node:` builtins (§9). "N runtime deps on the host" is likewise not a
  universally true claim — the host plugin can be dependency-free.
- There is a `package.json` compatibility field (`engines.dsh`,
  `dsh.compatibility`) → **not confirmed** (nothing in the verified `.d.ts`
  or READMEs). The supported range is docs + runtime assertion (§11.2).
- `npm pack --dry-run` is a valid gate → **refuted**; use the real pack
  (§4.2).

---

## Verified sources

_In-repo (real, shipped plugin) — cite by file path + line where needed; every
fact above is traceable to one of these_

- `/home/ondokai/Projects/deepseek-harness-mobile/package.json` (canonical
  fields; `dsh.bundle.patch` at L61-64; scripts L55-56; `files` L28).
- `/home/ondokai/Projects/deepseek-harness-mobile/tsconfig.build.json` /
  `tsconfig.worker.json` / `tsconfig.bin.json` (`noEmitOnError`, `rootDir`
  rationale, shebang warning).
- `/home/ondokai/Projects/deepseek-harness-mobile/scripts/check-tarball.mjs`
  (REQUIRED / FORBIDDEN lists, real-pack rationale).
- `/home/ondokai/Projects/deepseek-harness-mobile/.github/workflows/release.yml`
  (OIDC, provenance, post-publish poll; changeset-gate).
- `/home/ondokai/Projects/deepseek-harness-mobile/.github/workflows/ci.yml`
  (matrix, required checks, `supply-chain` minimumReleaseAge job,
  secrets-scan).
- `/home/ondokai/Projects/deepseek-harness-mobile/cordis.patch.yml` (bundle
  patch golden rules: silent id-collision and override-non-match, `!!js`
  non-sensitive-only, no-row-order).
- `/home/ondokai/Projects/deepseek-harness-mobile/.changeset/config.json`
  (changesets config).
- `/home/ondokai/Projects/deepseek-harness-mobile/dsh-compat.yml` +
  `scripts/gen-compat-table.mjs` + `scripts/fetch-dsh-types.mjs`
  (compatibility generation).
- `/home/ondokai/Projects/deepseek-harness-mobile/docs/plano/06-REPO-E-CI.md`
  (§7 versioning, §8 publishing, §9 packaging, §10 supply chain, §11
  compatibility) and `09-DECISOES-CANONICAS.md` (D4 scripts, D12 matrix, D13
  tarball, D14 jobs, D18 pins, D19 secrets, D21 name reservation, D22 badges,
  D26 type-stripping remiss).

_Official / external (verified via web search; URLs in text)_

- npm trusted publishing requirements (npm CLI ≥ 11.5.1, Node ≥ 22.14.0, cloud
  runner, `id-token: write`): https://docs.npmjs.com/trusted-publishers
- npm classic tokens revoked 09/12/2025:
  https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available
- npm publish-time malware scanning:
  https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata
- npm provenance automatic under trusted publishing:
  https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available
- npm staged publishing: https://docs.npmjs.com/staged-publishing
- pnpm build-script/approve-builds policy: https://pnpm.io/cli/approve-builds
- GitHub topics constraints:
  https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics

---

_This document is part of the `dsh-plugin-dev-agent-skill` skill. Cross-references:
`docs/arquitetura.md` (Cordis model), `docs/funcionalidade.md` (plugin
surface), `docs/seguranca.md` (threat model, secrets), `docs/testes.md` (test
suites). The packaging recipes assume the build/type surface defined in the
sibling docs._
