---
name: dsh-plugin-dev
description: Create, extend and publish plugins for the DeepSeek Harness (DSH). Use to build new functionality, change the web interface, integrate services, write tests, or publish a Cordis plugin for DSH — covering architecture, frontend (dsh-host-webserver), backend, IPC, security, testing and packaging, based on verified official materials. Triggers: "DSH plugin", "create a plugin for DeepSeek Harness", "change the DSH interface", "add functionality to DSH".
---

# dsh-plugin-dev — Build, extend and publish DeepSeek Harness plugins

Everything in DeepSeek Harness (DSH) is a plugin, including the agent loop itself. The user-facing extension path is *never* a pull request against the official repo (the maintainers do not accept external PRs) and *always* a Cordis plugin you publish yourself and tag with the GitHub topic "dsh-plugin". This skill tells you how to build, extend and publish such a plugin against the real, measured API surface — not against prose.

## What you will learn

1. The Cordis mental model: Context ("ctx"), inject, apply, fibers and reversible effects, so a plugin is loaded, hot-replaced and unloaded without corrupting host state.
2. How to verify the **real** DSH API against published .d.ts/tarballs before writing code (API names drift; prose and READMEs lag or lie).
3. The four ways to contribute to the web interface — webServer routes (exact/prefix/upgrade/fallback), tapIndex/applyIndexTaps, the slot system, and a client export (exports["./client"]).
4. Backend extension: typed events (waterfall/parallel/on), ctx.effect disposers, ControlIntent with requestId + nonce, subprocesses and long-polling workers, and tunnels.
5. Security baseline for a control-plane-facing plugin: the credential **and** the boundary, fail-closed defaults, and what a sandbox does *not* protect.
6. A testing strategy that actually guards security behavior, and where coverage does and does not help.
7. Packaging and publishing: pre-compiled bundles, allowlist files, package checks, changesets, and a CI gate.
8. The refuted and unverified claims that circulate about DSH, so you never teach them as truth.

## How to install

The whole repository is the skill directory — the root SKILL.md, docs/, examples/ and scripts/. Symlink the repository into the skills directory:

```bash
ln -s <path-to-repository> ~/.agents/skills/dsh-plugin-dev
```

The root SKILL.md is the entry point. docs/ are canonical references loaded on demand by section; you do not read them all up front. examples/ and scripts/ provide skeletons and validation tooling.

## How this skill is organized

| File | Covers | Load when |
| --- | --- | --- |
| SKILL.md (this file) | end-to-end recipe, API truth, security/testing/packaging essentials, anti-patterns, min-viable workflow | always — start here |
| docs/arquitetura.md | Cordis in DSH: Context, fibers, effects, events, merge layers | you write the apply() wiring |
| docs/interface.md | frontend: webServer routes, tapIndex, slots, client exports | you change the UI / web surface |
| docs/funcionalidade.md | typed events, ControlIntent, tunnels, Telegram worker, subprocesses | you add backend behavior |
| docs/seguranca.md | boundary + credential, allowlists, nonce, audit, rate limit | any plugin that guards a control plane |
| docs/testes.md | test runners, pyramid, adversarial suite, mutation, coverage | you design or run tests |
| docs/empacotamento.md | build, tarball, publint/attw/check-tarball, changesets, CI, publish | you package or release |
| examples/minimal/ | a runnable skeleton plugin | you bootstrap a new plugin |

## Creating a plugin

Workflow from empty repo to published package. Code is TypeScript (ESM only, "type": "module"); DSH refuses CommonJS and boots with "node --import tsx/esm" (verified in the official AGENTS.md).

### 0. Validate the API against .d.ts / tarballs, never prose (Q-1)

Prose is not the API. Every signature below is read from the .d.ts inside a published tarball whose sha256 you record, not from a README or a blog. Pin the version line the harness *actually resolves*, not the latest npm dist-tag: for every @deepseek-ai/dsh-* subpackage, latest points at the oldest publication while the live line is next (verified in the reference plugin repo: github.com/frederico-kluser/deepseek-harness-mobile, docs/spikes/api-dsh.md).

Verified names in the supported range 0.1.0-rc.7 .. 0.1.1-rc.1 (verified in the reference plugin repo: github.com/frederico-kluser/deepseek-harness-mobile, docs/spikes/api-dsh.md and mobile dsh-compat.yml):

| Concept | Dead name (0.0.1-rc.1/rc.2) | **Real name (supported range)** |
| --- | --- | --- |
| web context seat | ctx.httpServer / HttpServerService | ctx.webServer / WebServer (since 0.0.1-rc.3) |
| subprocess seat | SubprocessService | ctx.subprocess / SubprocessRuntime (since 0.0.1-rc.5) |
| spawn | spawn(command, args, options) | spawn(spec: SubprocessSpawnSpec) |
| host subprocess package | @deepseek-ai/dsh-host-subprocess (404) | @deepseek-ai/dsh-subprocess (+ -local) |
| static frontend package | @deepseek-ai/dsh-host-frontend (404) | @deepseek-ai/dsh-host-frontend-static |

Mirror the .d.ts of the real packages into types/ with a provenance header (source, sha256, supported range) and assert them in a contract test so drift is caught.

### 1. package.json with a real dsh.bundle.patch

A blank dsh.bundle: {} does **not** activate anything. The product decides activation by dsh?.bundle?.patch !== void 0, and dsh-app-boot throws at boot if a bundle listed in a profile lacks .patch (measured on @deepseek-ai/dsh@0.1.0-rc.7). Use:

```json
{
  "name": "dsh-<your-plugin>",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist", "cordis.patch.yml", "README.md", "LICENSE", "CHANGELOG.md"],
  "engines": { "node": ">=24" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": { "@deepseek-ai/cordis": ">=4.0.0 <5" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "test": "node --test 'test/unit/**/*.test.ts' 'test/integration/**/*.test.ts'",
    "prepublishOnly": "pnpm run build && publint && attw --pack . && node scripts/check-tarball.mjs"
  },
  "keywords": ["dsh-plugin", "dsh", "cordis", "deepseek-harness"]
}
```

dsh.bundle.patch is the same declaration @deepseek-ai/dsh-base and @deepseek-ai/dsh-web-app make; it is why "dsh plugin --profile web add <your-package>" activates your layer by itself. Add the dsh-plugin GitHub topic to your repo for discovery.

### 2. cordis.patch.yml — insert with your own id

The patch is a **bundle-layer** file applied automatically to whoever installs you. Rules measured on dsh@0.1.0-rc.7:

- The resolution is **whole-entry replace**, not deep merge: targeting another line's id deletes the whole entry and can silently create a *second* instance of a host service. Never aim at another package's id.
- Row order carries **no** load semantics; activation is service-driven (inject). Do not design around load order.
- A bundle patch must never throw on load: a throwing !!js makes dsh fail to boot for everyone who ran "dsh plugin add". Missing values become empty; the plugin treats empty as not configured, which is a legitimate documented state.

```yaml
# cordis.patch.yml — bundle layer
- insert:
    - id: <your-plugin-id>          # your own id, never another line's id
      name: '<your-npm-package-name>'
      config:
        realm: 'Secure DSH Interface'
        trustedRemotes:
          - '127.0.0.1'
```

There are four precedence layers: **Bundle** (this file, lowest) < **Profile** ($DSH_HOME/profiles/<name>/cordis.patch.yml) < **Home** ($DSH_HOME/cordis.patch.yml) < **CLI overlay** (dsh --patch ./o.yml, absolute). Deeper layers override real entries by id.

### 3. src/index.ts — inject, apply, ctx.effect

A plugin is a module exporting an immutable name, the required-service array inject, and an optional Config interface. apply(ctx, config) runs only after every injected service exists and is discarded if one disappears.

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-my-plugin'
// webServer and subprocess are the REAL seat names (Q-1). NOT 'httpServer'.
// Do NOT inject 'logger': LoggerService is not a Cordis Service (it does not
// extend Service), so ctx.get('logger') is undefined and the fiber stays
// PENDING forever — apply() never runs, silently. Use ctx.logger directly.
export const inject = ['webServer']

export interface Config {
  realm: string
  trustedRemotes: string[]
}

export function apply(ctx: Context, config: Config): void {
  // a) fail loud at load: invalid config or insecure bind throws here, never
  //    silently falls back to a permissive default (explicit > implicit).
  assertValidConfig(config)

  // b) atomic, reversible registration: every ctx.on/ctx.waterfall/ctx.parallel
  //    registration and every out-of-Cordis resource (timers, sockets, child
  //    processes) must go through ctx.effect so the disposer runs on unload.
  ctx.effect(() =>
    ctx.on('http/auth-check', async (req, next) => {
      // Waterfall listener: calling next() delegates; returning false WITHOUT
      // next() is an irreversible veto.
      return next()
    }),
  )

  // c) host a route on the DSH server.
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: '/__guard',
      handler: (req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('guard up')
      },
    }),
  )
}
```

Topology: prefer a pure function plugin (export function apply(ctx)) for most cases; an object plugin (export const plugin = { apply }) to group metadata; a class extends Service only when you expose a formal service other plugins depend on.

### 4. Long-running worker: subprocess + JSONL IPC + dead-man's switch

For long-polling integrations (a Telegram bot, an MCP poller) keep the work out of the host event loop and out of the DSH HTTP pools. Use ctx.subprocess, not the raw child_process.spawn.

```ts
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

ctx.effect((): Disposable => {
  const abortController = new AbortController()
  // spawn(spec) — a single spec object, never (cmd, args, opts).
  const spec: SubprocessSpawnSpec = {
    argv: [process.execPath, '/abs/path/dist/worker.js'],
    cwd: '/abs/worker-dir',
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 3000,       // SIGTERM, then SIGKILL after this window
    signal: abortController.signal,
    // Inherit a minimal env ALLOWLIST (PATH, HOME, TMPDIR, ...), never the whole
    // process.env: a worker that talks to the internet must not hold the host's
    // control-plane secrets (readable via /proc/<pid>/environ).
    env: buildAllowedEnv(),
  }
  const child = ctx.subprocess.spawn(spec)      // => SubprocessHandle

  // JSONL IPC over stdio: stdout is exclusively JSON lines to the handler;
  // all human logs go to stderr. Protocol versioned (IPC_PROTOCOL_VERSION).
  child.stdout.on('data', parseJsonlLine)

  // DEAD-MAN'S SWITCH: host killed with SIGKILL cannot run a disposer, but the
  // kernel closes our descriptors; the worker sees EOF on stdin and exits itself.
  void child.done.then((outcome) => {
    if (!abortController.signal.aborted) scheduleBackoffRestart(outcome)
  })

  // Disposer: abort, then tree-kill. Signal the worker first (graceMs), and
  // terminate the whole process tree — never just 'kill' the pid and assume the
  // shell grandchildren died.
  return () => {
    abortController.abort()
    child.terminate()      // tree scope on all platforms
    clearTimeout(restartTimer)
  }
})
```

Notes measured in the mobile case:
- SubprocessHandle is **not** an EventEmitter: it has a done: Promise<SubprocessOutcome> and terminate(), not on('exit')/removeListener()/killed.
- **close vs exit**: on POSIX, close fires only after stdio streams drain, not on process exit. Base restarts/health on done, and prove termination with ps, never with child.killed.
- Worker cwd is the **host's**, not the package's; resolve the entrypoint from import.meta.url, never a relative path.
- Use exponential backoff with jitter added on top of a floor, reset after a stable uptime window (resetAfterMs), with a finite attempt budget that reaches an explicit terminal state instead of inventing a self-deregister API that does not exist.

## Interface (frontend)

Four levers, increasing intimacy with the host. Full detail in docs/interface.md.

1. **webServer routes** (assets already owned): register({kind:'exact'|'prefix', ...}), registerUpgrade (exact-only, for Connection: Upgrade), registerFallback (single seat). A duplicate (kind, path) **throws** at load. In a real web composition the named tables are: prefix /plugins (client-modules), exact /plugins/events (client-hmr), prefix /api + upgrades api/events.mux and api/events.host (client-connection); the fallback seat is owned by dsh-host-frontend-static (verified in the superficie-ui spike). **A fallback barrier never covers /api** — named tables are matched first. To guard *everything* (SPA + /api + upgrades) take the dispatch on the underlying node:http.Server (capture request/upgrade listeners, install one deciding listener, return a disposer that restores them).
2. **tapIndex(transform)** / applyIndexTaps(html) — transform the index.html the fallback serves (e.g. inject a script). Returns a disposer.
3. **ctx.intercept(name, config)** — measured to be **config merge, not method interception**; for webServer (extends Service) the typed overload collapses config to never, so a methods object compiles via any and does **nothing** (silent). Do not use it to wrap methods; use dispatch takeover + ctx.effect. ([UNVERIFIED] whether a future line restores method interception.)
4. **Slots / client exports** — browser-half plugins contribute via a slot system (ctx.slots.register) and, for UI packages, an exports["./client"] export; no global DOM injection. Own panels vs slots trade-off is in docs/interface.md.

## Functionality (backend)

- **Typed events** (verified in the cordis event API): ctx.waterfall(name, ...args, next) (around-middleware; omit next() to veto), ctx.parallel(...), and ctx.on(...). Extend the global declare module '@deepseek-ai/cordis' interface Events for your own event names, with special /** @mode waterfall */ events integral to the augmentation.
- **ControlIntent**: for a control plane (start/stop/rotate), send an intent carrying a requestId + a **nonce** issued through a confirmation service, and re-verify identity against persisted pairing inside the host process — the process that talks to the internet is the first to be compromised.
- **Tunnels**: quick (auto onboarding) vs named (requires a token file, never --token on argv). TTL expiry must fall the tunnel, invalidate all sessions, audit, then notify the owner — in that order. Always a fail-closed probe against the origin before trusting a tunnel is up.
- **Telegram**: run grammY as the long-polling subprocess (Section 4), not in the host; the worker is the only process allowed to touch the bot token.

## Security

The credential **and** the boundary. A DSH sandbox (workspace-write via bwrap) is a *spatial* fence, not an authentication boundary — a documented escape (#1769) uses mount -o remount,rw / inside the bwrap namespace, and the control-plane RCE #853 can inject /permission danger-full-access. Never treat sandboxed as nobody-else-can-reach-me.

- Secrets never in the manifest, the config, or the chat: generate the credential in the plugin via CSPRNG (>=128 bits), print it once at boot, store only a **digest** in state (0600); authenticate users via derived one-time-token (OTT) or magic links, not by pasting the secret into a channel that logs it.
- Constant-time credential comparison (crypto.timingSafeEqual) over the digest — never a plain string === on the secret.
- **Two allowlist axes, kept distinct**: trustedRemotes = allowlist of the origin (req.socket.remoteAddress, evaluated first; out of list -> 403) and allowedHosts = allowlist of the **bind address** (reject 0.0.0.0/:: at load). A third, guardedPrefixes, is the route inventory.
- Guard the WebSocket **upgrade** too: WebSockets are not subject to same-origin policy; anyone could open ws://localhost:... from a pinned page.
- **Nonce-deputy confirmation**: destructive actions need a two-step confirmation keyed by a nonce obtained out-of-band, so a confused deputy cannot be replayed.
- Append-only audit of every permit/deny, and NIST-ceiling rate limiting (lock out after an explicit failure budget, recover only locally) — a ban must not become an oracle.
- Run checks in a fixed order (origin -> Host -> credential); reversing order is a security regression, and the denial bodies must be byte-identical to avoid information leaks.

## Testing

- **Runner**: node:test is fully valid for a DSH plugin (zero test-runtime deps); Vitest is used upstream and is fine too. Own the scripts so the gate is lint && typecheck && build && test.
- **Six-layer pyramid**, each proving something different: unit (pure core) -> integration (Cordis wiring against a real webServer on port 0) -> **security/adversarial** (tries to breach the gate and must fail) -> **contract** (your mirrored types/ byte-match the real npm .d.ts; needs network) -> e2e (real processes/sockets, fake tunnel binary) -> live/manual (real Telegram/Cloudflare, never CI). Add lint/typecheck/build as the cheapest layers.
- **Doubles with a contract**: fake the tunnel binary and the Telegram server by stubbing only by behavior contract, so a version swap breaks the test loudly.
- **Adversarial suite** should attempt: route/canonicalization bypass, Host-header DNS rebinding, cross-site WebSocket hijacking (CWE-1385), credential forgery, secret-leak canary by value, and statistical constant-time proof.
- **Mutation**: Stryker has no native node:test runner — use the tap-runner and drive acceptance by a **manual mutant checklist**, not the tool score (the score informs; it does not gate).
- **Coverage with purpose**: set floors per module, run the security suite during coverage, keep a coverage-ratchet. Coverage proves exercised lines, **not** that the behavior is secure — the adversarial suite is the proof.
- **Determinism**: CI runs no retry; a flaky test is a bug. No sleep, fixed ports, or Math.random; prove a process died with ps, not child.killed. Inject an injectable clock everywhere (no bare Date.now() reads).

## Packaging & publishing

- Always **pre-compiled**: publish dist/ JavaScript, never a source/TypeScript install. Installs from Git require the operator to approve allowBuilds in pnpm-workspace.yaml, and build scripts run with full privileges outside the sandbox — an avoidable supply-chain risk. A pre-built npm tarball (or pnpm pack .tgz) sidesteps it entirely.
- **Allowlist the tarball**: files only what must ship (dist, cordis.patch.yml, README, LICENSE, CHANGELOG). Never ship worker/ source if the built artifact is in dist/worker/; check your exact tree.
- Gate with **publint + attw --pack . (Are The Types Wrong) + a check-tarball** script that inspects the emitted tarball (entrypoints, dist/worker present, files respected) before publish, plus a contract test for the mirrored types.
- **Changesets** for release notes; in 0.x, a **minor** is breaking — version accordingly and state the supported DSH rc range.
- Sign the publish with **OIDC** provenance and gate releases on a **CI** that runs the full test matrix and the package checks.

## Anti-patterns to avoid

These are refuted by real measurement or are unconfirmed. Do **not** teach them as truth. When you see them, say "refuted by real measurement" (or mark [UNVERIFIED]) and give the correct alternative.

| # | Refuted / unconfirmed claim | Verified correct behavior |
| --- | --- | --- |
| P-01 | The web seat is ctx.httpServer / HttpServerService | ctx.webServer / WebServer (since 0.0.1-rc.3; verified in api-dsh spike) |
| P-02 | Subprocesses spawn via spawn(command, args, options) | ctx.subprocess.spawn(spec: SubprocessSpawnSpec) — one spec object (verified) |
| P-03 | Subprocess package is @deepseek-ai/dsh-host-subprocess | It 404s on all versions; the real package is @deepseek-ai/dsh-subprocess (+ -local) |
| P-04 | A static-frontend package named dsh-host-frontend exists | 404; the real one is @deepseek-ai/dsh-host-frontend-static |
| P-05 | ctx.intercept('webServer', { methods }) wraps the server's methods | intercept(name, config) is config merge; inert for webServer (verified) |
| P-06 | dsh.bundle: {} activates the plugin | Only dsh.bundle.patch activates; blank bundle: {} passes review but boots nothing (measured on rc.7) |
| P-07 | child.kill() alone is enough when launching through a shell/pipeline | Must tree/group-terminate + signal/grace; prove death via ps/done, not killed |
| P-08 | Plugins need N runtime deps or zero runtime deps by decree | Runtime deps are a design choice; keep minimal but honest (the mobile case needs exactly one: grammy) |
| P-09 | Relying on logger injection | logger is not a Cordis Service; inject: ['logger'] leaves the fiber PENDING forever (measured) |
| P-10 | The workspace-write sandbox is a trustworthy boundary alone | It is escapable #1769 and the control plane can bypass it (RCE #853); the app boundary + auth is what guards |
| P-11 | Quick-tunnel URLs are private / a credential | They are discoverable by sampling; obscure hostname is not access control |
| P-12 | drop_pending_updates is a getUpdates parameter that bypasses allowlists | Unconfirmed / verify identity at the boundary; the bot token does not bypass an allowlist |
| P-13 | A compatibility field exists in package.json, or ASVS/benchmark claims let you skip Argon2 / real tests | No such field; hashing and perf claims must be verified — see docs/seguranca.md |

## Min-viable workflow (one page)

1. **Validate the API** — download the real tarballs; read .d.ts; record sha256; confirm ctx.webServer / SubprocessRuntime / spawn(spec) in your supported rc range. Never code from a README alone.
2. **Bootstrap** — copy examples/minimal/; set package.json with dsh.bundle.patch, ESM, files allowlist, engines.node>=24.
3. **Wire the manifest** — cordis.patch.yml single insert with your own id; no !!js that throws; no aiming at another line's id.
4. **Implement** — src/index.ts: name, inject, optional Config, apply that asserts config, registers via ctx.effect, mounts any route on ctx.webServer, spawns workers through ctx.subprocess.
5. **Test** — six-layer pyramid; adversarial suite must attempt to breach the gate; contract test pins your mirrored types/; node:test runner, no flakes, deterministic clocks.
6. **Package** — build dist/; publint + attw --pack . + check-tarball; inspect the tarball; changeset; OIDC provenance.
7. **Publish** — CI gate green, then pnpm publish; tag the repo dsh-plugin.

## Verified sources

- GitHub deepseek-ai/deepseek-harness (master) — architecture.md, CONTRIBUTING.md, AGENTS.md, docs/subsystems/web-server.md, docs/cordis-tutorial/*, docs/user/develop/basic/{tool,config,publish}.md: <https://github.com/deepseek-ai/deepseek-harness>
- docs/subsystems/web-server.md — the webServer service surface: <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/web-server.md>
- Security discussions verified upstream: unauthenticated control-plane RCE (#853): <https://github.com/deepseek-ai/deepseek-harness/discussions/853> ; bwrap workspace-write escape (#1769): <https://github.com/deepseek-ai/deepseek-harness/discussions/1769> ; silent sandbox denials (#3144): <https://github.com/deepseek-ai/deepseek-harness/discussions/3144>
- Exported package surfaces measured from npm tarballs @deepseek-ai/dsh-host-webserver, @deepseek-ai/dsh-subprocess, @deepseek-ai/dsh-host-frontend-static, @deepseek-ai/cordis — see docs/arquitetura.md and the types/ headers mirrored in the reference repo deepseek-harness-mobile.

> Everything asserted as verified above was measured against the real published DSH packages in the active development range; any claim that was only reproduced or is not yet confirmed is explicitly marked [UNVERIFIED].
