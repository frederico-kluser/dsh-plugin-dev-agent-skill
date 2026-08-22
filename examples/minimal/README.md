# examples/minimal — a minimal Cordis plugin for DeepSeek Harness

A tiny, **standalone, compilable** Cordis plugin that demonstrates the core concepts of the dsh-plugin-dev-agent-skill skill. It is not a finished DSH UI panel or tool — it is a deliberately small webServer plugin you can build and test on its own, in seconds, with zero DSH install.

## What it demonstrates

- The **function-topology** plugin manifest: name, inject, apply(ctx, config).
- **Dependency injection** via inject = ['webServer'] — the fiber stays PENDING until the HTTP carrier service is provided.
- **Temporal reversibility** via ctx.effect() — every unmanaged resource (a setInterval) is wrapped so Cordis can tear it down (LIFO) when the fiber unloads.
- **A route** served through ctx.webServer.register({ kind, path, handler }) (the real @deepseek-ai/dsh-host-webserver signature).
- **Fail-loud-at-load** config validation (throws a TypeError at apply time on bad config).
- **Module augmentation** — a declare module '@deepseek-ai/cordis' block adds a typed Events member (skill.example:ping) that ctx.emit accepts.

## Anatomy, piece by piece

| File | Role |
| --- | --- |
| src/index.ts | The plugin itself. Read the inline comments in order — each concept is explained where it appears. |
| test/smoke.test.ts | node:test smoke tests: module loads, invalid config throws, valid config registers. The fake Context exposes a dispose() to unload effects so node:test exits cleanly. |
| tsconfig.json | NodeNext ESM + strict TS config (module/moduleResolution NodeNext, target ES2023, types: [node], outDir dist, declaration). |
| package.json | Self-contained manifest. build runs tsc; test runs the compiled node:test suite. |
| cordis.patch.yml | **Illustrative only** — teaches the golden rules of DSH bundle patching (id collision, whole-entry replace, bundle/profile/home/overlay layers, bundle:{} not activating). It is never loaded by build/test. |
| .gitignore | Excludes dist/ and node_modules/ so only source + lockfile are tracked. |

A subtle but important typing detail in src/index.ts: the plugin type-imports WebRoute from @deepseek-ai/dsh-host-webserver. That import is what makes TypeScript load the package's ambient augmentation, where `Context.webServer` is actually declared (cordis itself does not know about webServer). Without referencing those types, `ctx.webServer` fails to type-check.

How it fits together in src/index.ts:

1. **Manifest** — export const name, export const inject, export function apply. This is what the Cordis loader looks up.
2. **Config** — export interface Config. Cordis validates and hot-reloads on config change.
3. **Fail loud** — apply validates the config eagerly and throws on malformed input (fiber → FAILED).
4. **Effect** — ctx.effect(() => { const h = setInterval(...); return () => clearInterval(h); }). The disposer guarantees no orphaned timer.
5. **Route** — ctx.webServer.register({ kind: 'exact', path: '/__skill-example', handler }). The handler owns the full response lifecycle and must res.end() itself.
6. **Events augmentation** — a declare module '@deepseek-ai/cordis' block adds 'skill.example:ping' to Events, so ctx.emit('skill.example:ping') type-checks.

## Run it

```bash
# from examples/minimal
pnpm install      # installs typescript, @types/node, @deepseek-ai/cordis, @deepseek-ai/dsh-host-webserver
pnpm build        # tsc -p tsconfig.json -> dist/ (must be green)
pnpm test         # node --test dist/test/smoke.test.js
pnpm start        # node dist/src/index.js — loads the module; no server is started (see honesty note)
```

## Honesty: what this does and does not prove

- **Compiled + smoke tested**: the example proves the types, the module shape and the fail-loud validation logic. build and test pass in seconds with no DSH running.
- **NOT activated in DSH here**: a setInterval and a real HTTP route need a live DSH Context that provides the webServer service. `pnpm start` only loads the exported module — because apply() is never called, no route and no interval are created, so it exits cleanly. That activation happens in a real profile, through the CLI:

```bash
dsh plugin --profile <name> add <path-or-package>
```

The smoke test uses a hand-rolled fake Context (see test/smoke.test.ts) so apply() can be exercised outside DSH; it does **not** spin up a real server. For a real route you must load the plugin into a DSH profile whose composition provides webServer.

## Anti-patterns this example deliberately avoids

- Calling ctx.logger (or any service) without declaring it in inject — keeps load order explicit.
- Creating a timer/socket without ctx.effect() (silent leak across HMR).
- Validating config lazily inside a request handler (fail-loud-at-load instead).
- Using bundle: {} to "activate" a plugin (it does not; activity follows service availability).
- Referencing ctx.webServer without also referencing the webserver package types (it would silently fail to type-check).

## Verified sources

- API names (WebServer, ctx.webServer, register({ kind, path, handler }), ctx.subprocess, module augmentation) verified against @deepseek-ai/cordis@4.0.1 and @deepseek-ai/dsh-host-webserver@0.1.1-rc.1 type declarations (range 0.1.0-rc.7..0.1.1-rc.1).
- Cordis lifecycle/effect semantics: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/02-lifecycle-and-effects.md
- Plugin fundamentals: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/01-first-plugin.md
