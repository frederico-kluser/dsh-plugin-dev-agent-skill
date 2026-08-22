# Changing the DSH Interface from a Plugin — docs/interface.md

**Skill:** dsh-plugin-dev · **Audience:** plugin authors for the DeepSeek Harness (DSH) · **Status:** verified against the real packages (0.1.0-rc.7 .. 0.1.1-rc.1) and measured experiments.

This document answers one question: **how does a DSH plugin change the interface the user sees and talks to?** Every mechanism below is a *reversible effect*: it returns a disposer and is torn down automatically when the Cordis fiber that installed it is disposed (config reload, HMR replacement, plugin unload, or a crashed dependency). Nothing here teaches you to fork the harness — the whole point of the DSH design is that these surfaces are owned, not patched.

> **Reading conventions.** Every fact is either verified in the published packages (`verified in <package>@<version> <file>:<line>`, from the mirrored `.d.ts` tarballs in the mirrored `types/` tree in the reference repo `deepseek-harness-mobile`) or measured against a real running composition (`measured, deepseek-harness-mobile/docs/spikes/<file>.md S<k>`). Claims that are **not** confirmed are marked `[UNVERIFIED]`. Do not teach a claim that is refuted (see the honesty filter in §11/§12).

---

## 1. Four independent, reversible levers

A plugin never rewrites the host. Instead it flips one (or more) of four levers, each orthogonal to the others and each returning a disposer:

| # | Lever | Owner / where it runs | Signature the plugin uses | Reversible? |
|---|-------|------------------------|---------------------------|-------------|
| **L1** | HTTP routes on `ctx.webServer` | host (`node:http` server) | `ctx.webServer.register(route)`, `registerUpgrade(route)` | yes — disposer |
| **L2** | HTTP barrier (interception of *all* dispatch) | host (`node:http.Server`) | capture `listeners('request'|'upgrade')`, install a deciding delegating listener | yes — sync disposer |
| **L3** | `tapIndex` — injection into every served `index.html` | host, run by the fallback owner | `ctx.webServer.tapIndex(html => html)` | yes — disposer |
| **L4** | `ctx.slots` — client React UI (browser half) | client bundle | `ctx.slots.register(...)` | yes — disposer |

They are independent: you can contribute routes without a barrier, inject HTML without React, or run a client panel without touching the server tables. Which lever fits your goal:

- Want to serve **an API or a page at your own path** → **L1** (`register` / `registerUpgrade`).
- Want to **guard every request** crossing the harness (auth, allowlists, CSRF) → **L2** (the barrier).
- Want to **inject a small chrome into the SPA shell** without shipping React → **L3** (`tapIndex`).
- Want a **first-class typed React panel inside the Web UI** → **L4** (`ctx.slots`), or keep an independent page (recommended for robustness) with **L1** at your own prefix.

The real-world reference repo (a hardened gateway plugin) exercises L1 + L2 + L3 together: routes for a control panel at `/__guard/*`, an auth barrier over the whole dispatch, and a `tapIndex` chrome widget. L4 is the *client* plane and is described in §5.

---

## 2. Routes on `ctx.webServer` (L1)

The service is **`ctx.webServer`**, an instance of **`WebServer`** (which extends Cordis `Service`). The names `ctx.httpServer` / `HttpServerService` existed only in the abandoned `0.0.1-rc.1/rc.2` line whose `latest` tag is stagnant — the published harness uses `webServer` (`verified in @deepseek-ai/dsh-host-webserver@0.1.0-rc.7 lib/types/index.d.ts:25,59`; the diff between rc.1 and rc.8 is purely nominal, `measured, deepseek-harness-mobile/docs/spikes/interceptacao.md:41-59`).

### 2.1 The write API

All route registries live in the `WebServer` and are additive effects:

| Method | Match kind | Returns | Duplicate behavior |
|--------|-----------|---------|--------------------|
| `ctx.webServer.register({ kind: 'exact', path, handler })` | exact full match | `() => void` (disposer) | **throws** `webserver: duplicate exact route "<path>"` |
| `ctx.webServer.register({ kind: 'prefix', path, handler })` | longest-prefix | `() => void` (disposer) | **throws** `webserver: duplicate prefix route "<path>"` |
| `ctx.webServer.registerUpgrade({ path, handler })` | **exact only** | `() => void` (disposer) | **throws** `webserver: duplicate upgrade route "<path>"` |
| `ctx.webServer.registerFallback(handler)` | last resort | `() => void` (disposer) | **throws** `webserver: fallback already registered` — single seat |

Verification: the dispatcher table logic is `route.kind === "exact" ? this.exact : this.prefixes`, duplicates throw at `:54-56`, upgrades at `:68`, fallback at `:83` (`verified in @deepseek-ai/dsh-host-webserver@0.1.0-rc.8 lib/index.js:54-83`). The signatures `register(route: WebRoute): () => void` (`:81`), `registerUpgrade` (`:88`), `registerFallback` (`:97`) come from `lib/types/index.d.ts` (`verified, deepseek-harness-mobile/docs/spikes/api-dsh.md:418`).

> ⚠️ **`kind` is mandatory.** The route table is split by kind; omitting it does not "default" to anything. Use TS inference from the `WebRoute` union so the compiler enforces it.

### 2.2 The matching order is fixed and immutable

`WebServer` resolves a request with a static, unchangeable priority (`verified in @deepseek-ai/dsh-host-webserver@0.1.0-rc.8 lib/index.js:295-306`, `measured, deepseek-harness-mobile/docs/spikes/api-dsh.md:291`):

```
1. exact  (this.exact.get(pathname))          — always wins
2. prefix (longest match length wins)
3. fallback (only if nothing above matched)
```

Conflicts are *fail loud at load-time*, not last-write-wins: the second registration of the same path+kind **throws during `apply()`**, so a bad plugin cannot silently shadow a route.

### 2.3 `registerFallback` is a single seat — do NOT claim it

The fallback seat belongs to `@deepseek-ai/dsh-host-frontend-static`, which renders `index.html` for the SPA (`verified in @deepseek-ai/dsh-host-frontend-static@0.1.0-rc.8 lib/index.js:72`, mounted by `web-runtime`). A second `registerFallback` **throws immediately** — measured: `second registerFallback => lancou: webserver: fallback already registered` (`measured, deepseek-harness-mobile/docs/spikes/superficie-ui.md:374-379`). Never attempt to take it; use your own route prefix instead.

### 2.4 Example — a simple route + a prefix API

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const name = 'my-interface'
export const inject = ['webServer']

export function apply(ctx: Context) {
  // Exact route: only GET /ping matches.
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/ping',
      handler: (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, service: ctx.webServer.host }))
      },
    }),
  )

  // Prefix route: mounts a whole API sub-tree under /my-api/** .
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: '/my-api',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        // dispatch on req.url yourself; this handler owns /my-api/**
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
      },
    }),
  )
}
```

Every `register*` returns a disposer; wrapping them in `ctx.effect` makes the leak window impossible — the fiber removes the route when it unloads. In the reference plugin the panel mounts as `ctx.webServer.register({ kind: 'prefix', path: '/__guard', handler: createPanelRouter(...) })`, and `register` returns the disposer stored as `desregistrarPainel` (`reference in deepseek-harness-mobile/src/index.ts:957-996`).

### 2.5 There is NO public API to enumerate registered routes

Do not write code that "lists which routes exist to pick one". `measured, deepseek-harness-mobile/docs/spikes/superficie-ui.md:76-78`: "Não há API pública de listagem" — enumeration is only possible by reading the private tables at runtime (a `.d.ts` comment restates it: "nada que permita enumerar rotas já registadas", `verified in @deepseek-ai/dsh-host-webserver README.md:55`). If you need to discover routes, design around your own prefix, not introspection.

---

## 3. The HTTP barrier: swap the dispatch owner (L2)

### 3.1 What the barrier is for

A route barrier only covers *your* routes. If you must guard the **whole HTTP surface** — the harness `/api` sub-route with its 60+ RPC endpoints, the SPA fallback, and the WebSocket upgrades — a `register`-level wrapper is not enough. The reference gateway exists precisely because the DSH `/api` control plane answered sockets without any credential (official advisory #853, `verified, deepseek-harness-mobile/docs/spikes/interceptacao.md`; the referenced discussion is https://github.com/deepseek-ai/deepseek-harness/discussions/853).

### 3.2 `ctx.intercept` is config-merge — NOT a method interceptor (refuted as a barrier)

The common (and tempting, and wrong-place-taught) approach is:

```ts
ctx.intercept('webServer', { registerFallback(handler) { /* wrap */ } })
```

**This does nothing.** The published Cordis body is:

```ts
// @deepseek-ai/cordis@4.0.1 src/context.ts:141-145
intercept(name: string, config: any) {
  const intercept = Object.create(this[symbols.intercept])
  intercept[name] = config
  return this.extend({ [symbols.intercept]: intercept })
}
```

`intercept` is a **per-service configuration merge**, read only by `Service[symbols.resolveConfig]` and passed to plugins loaded *under* the interceptor. **No method is replaced** (`verified in deepseek-harness-mobile/docs/spikes/interceptacao.md:163-239` and `deepseek-harness-mobile/docs/spikes/interceptacao.md:384-410`). Measured consequences for the `webServer`:

- the overload `intercept(name: string, config: any): this` makes the wrong call **compile silently** (`types/cordis/context.d.ts:99`);
- for `WebServer` the typed overload collapses `config` to `never`, so only the `config: any` overload matches — compiles, does nothing;
- `grep -c resolveConfig` in the published `webServer` lib/**index.js** returns **0** — the service never even reads the intercept config (`measured, deepseek-harness-mobile/docs/spikes/interceptacao.md:221-239`). A `register` that throws when called was never called, and `/api/state` kept answering 200.

**The mechanism that works is dispatch-ownership swap** (see §3.3). The pt-BR corpus that teaches "wrap `registerFallback` via `ctx.intercept`" is wrong on this point; this skill inherits and keeps the measurement.

### 3.3 The mechanism that works: capture → decide → delegate → restore

`measured, deepseek-harness-mobile/docs/spikes/interceptacao.md S12` — 35 assertions, 7 real routes pass through 200 → 401 → 200 across a synchronous disposer. The `WebServer` real HTTP server is a `node:http.Server` created in its `[Service.init]` (`this.server = createServer(...)`, `lib/index.js:121-131`; upgrade listener at `:132-165`). The top of the dispatch is the two `EventEmitter` listener lists for `'request'` and `'upgrade'` — **everything** (`match()`, the fallback, the upgrade table) lives underneath them. Grabbing those two listeners therefore covers `register` (exact + prefix), `registerFallback`, and `registerUpgrade` at once, with no knowledge of any route, and — because the `EventEmitter` refetches the listener list per event — **no load-order requirement**.

The algorithm (`verified in deepseek-harness-mobile/src/http/intercept.ts` and `deepseek-harness-mobile/docs/spikes/interceptacao.md:439-462`):

1. **Resolve** the `node:http.Server` inside `webServer` (`this.server`; a runtime scan over `Object.getOwnPropertyNames` with `instanceof Server` is the safety net against field renames — it is the only `private` field this design couples to).
2. **Capture** `server.listeners('request')` and `server.listeners('upgrade')`.
3. **`removeAllListeners`** and install **one** owned listener per event that decides (auth/CSRF/allowlist) and then **delegates** to the captured originals.
4. Return a **synchronous, ownership-checked disposer** that reinstates the originals only if the dispatch is still ours (so two barriers cannot double-write the same `res`).

> ⚠️ Three hard-won rules (all `measured, deepseek-harness-mobile/docs/spikes/interceptacao.md`):
> **one barrier per server** — stacking a second is refused at install (`BARRIER_ALREADY_INSTALLED`), because out-of-LIFO reversal would run two dispatches over one `res` and raise an uncatchable `ERR_HTTP_HEADERS_SENT`;
> **never `prependListener`** — Node's `EventEmitter` has no veto; a prepended listener runs first but does not stop the rest, so it cannot *block*. Only being the owner blocks;
> **only wrap `'upgrade'` if it already exists** — with zero upgrade listeners, Node routes the socket through `request` (which your barrier already guards); installing one where none existed changes server semantics and would hang authorized upgrades.

### 3.4 Example — a reversible dispatch-owner barrier

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

export const inject = ['webServer']

export function apply(ctx: Context) {
  ctx.effect(() => {
    const server = resolveHttpServer(ctx.webServer)       // your adapter
    const originalRequest: any[] = server.listeners('request')
    const originalUpgrade: any[] = server.listeners('upgrade')

    async function decide(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      if (!req.headers.authorization) {                    // example policy
        res.writeHead(401, { 'www-authenticate': 'Basic realm="gate"' })
        res.end('Intercepted')
        return false
      }
      return true
    }

    const onRequest = (req: IncomingMessage, res: ServerResponse) => {
      const outcome = decide(req, res)
      if (outcome instanceof Promise) outcome.then((ok) => ok && serve()).catch(() => {})
      else if (outcome) serve()
      function serve() {
        for (const l of originalRequest) l.call(server, req, res)
      }
    }
    // mark ownership, removeAllListeners('request'), server.on('request', onRequest) …

    return () => {
      server.removeListener('request', onRequest)
      for (const l of originalRequest) server.on('request', l)
    }
  })
}
```

Keep the policy (basic auth, CSRF, origin/Host allowlists, session) inside the *deciding* handler, and let the captured originals do the *serving*. The reference implementation's disposer closes the auth stack *before* restoring the dispatch (fail-closed order) and refuses to reinstall if ownership was lost (`deepseek-harness-mobile/src/http/intercept.ts`).

---

## 4. `tapIndex` / `applyIndexTaps` — inject into the served `index.html` (L3)

`tapIndex(transform: (html: string) => string): () => void` is part of `WebServer` (`verified in @deepseek-ai/dsh-host-webserver@0.1.0-rc.8 lib/types/index.d.ts:95`). The fallback owner runs the taps in order on **every** index response:

```ts
// dsh-host-frontend-static/lib/index.js:72 (owner of the fallback seat)
const renderIndex = async () => ctx.webServer.applyIndexTaps(await readFile(distIndex, 'utf8'))
```

`measured, deepseek-harness-mobile/docs/spikes/superficie-ui.md:292-316` on the real published composition:

- on `GET /` there were already **2 host taps** registered: `dsh-client-modules` (injects the `window.__DSH_BOOT__` manifest, `lib/index.js:292`) and `dsh-client-ui-theme` (injects the pre-first-paint theme bootstrap, `lib/index.js:76`);
- your tap composes **in the same queue** (index went 1745 → 1795 bytes, the extra chrome rendered in the Web UI) and is fully reversible by the disposer (`GET / after disposer: reversible = SIM`).

**Contract for a tap:** keep it unambitious. Prefer adding a `<script src="/your-path/client.js" defer>` and markup with your own `id` namespace before `</body>` — never rewrite the rest of the document, never interpolate tunnel URLs (inject by `textContent` + a route). Most importantly: **whoever serves the index must keep calling `applyIndexTaps`**; if a tap dies, it takes the two host taps with it (`measured, deepseek-harness-mobile/docs/spikes/superficie-ui.md:418`).

Example:

```ts
ctx.effect(() =>
  ctx.webServer.tapIndex((html: string) => {
    if (html.includes('id="my-widget"')) return html        // idempotent
    const pos = html.lastIndexOf('</body>')
    const widget = '<div id="my-widget">status</div>' +
      '<script src="/my-api/client.js" defer></script>'
    return pos === -1 ? html + widget : html.slice(0, pos) + widget + html.slice(pos)
  }),
)
```

`[UNVERIFIED]` The byte-count figures (1745/1795) are specific to the measured composition.

---

## 5. `ctx.slots` — first-class client React UI (L4)

The DSH ships a full, typed browser UI plugin system. This is the "proper" way to contribute React to the Web UI.

### 5.1 How a plugin reaches the browser

1. Declare `dsh.client` in `package.json` and export `./client`:
```json
"dsh":     { "client": { "inject": ["@deepseek-ai/dsh-client-runtime"], "platform": "web" } },
"exports": { "./client": { "default": "./lib/client.js" } }
```
   The parser lives in `dsh-client-modules/lib/index.js:119-145` (fields: `platform`, `inject`, `external`, `immediately`).
2. `ClientModuleRegistry` scans loader entries, composes `window.__DSH_BOOT__`, and serves the bundle at `/plugins/<package>/client.js?rev=<hash>` (`dsh-client-modules/lib/index.js:282,413`).
3. In the browser the client half calls `ctx.slots.register(...)`. `ctx.slots` is `SlotRegistry` (`@deepseek-ai/dsh-client-runtime@0.1.0-rc.8 lib/types/client/index.d.ts:109`); `register` has two overloads (`@deepseek-ai/dsh-client-ui-slots@0.1.0-rc.8 lib/types/index.d.ts:562,575`) and **returns a disposer**.

Verified against an official published example — `@deepseek-ai/dsh-client-ui-message-feedback@0.1.0-rc.8` (*"Per-message feedback controls contributed to the assistant-message action strip"*):

```js
// dsh-client-ui-message-feedback/lib/client.js:695
ctx.slots.inject("conversation.chat.assistant-actions", () => {
  const dispose = ctx.slots.register({
    name: "conversation.chat.assistant-actions", id: "feedback", order: 10,
    locale: NS, inject: (sessionId) => { /* ... */ }
  }, MessageFeedbackActions)
  return () => { dispose(); /* ... */ }
})
```

### 5.2 Versioning via `SlotMap`

Slot names are **typed and versioned**: the set of valid `name`s comes from `SlotMap`, extended by `declaration merging` of the versioned `dsh-client-ui-*` packages (`measured, deepseek-harness-mobile/docs/spikes/superficie-ui.md:369-371`). A plugin's client half only compiles against slots its declared host UI packages expose — that is the compatibility seam. Because it also depends on React and the host slot map, a slot-registered panel breaks on a host major change.

### 5.3 Scope is NOT filtered

`ClientModuleRegistry` iterates `ctx.loader.entries()` with **no restriction to `@deepseek-ai`** (`measured, deepseek-harness-mobile/docs/spikes/superficie-ui.md:360-364`). Any package the Loader loads that declares `dsh.client` and exports `./client` enters the graph — third parties genuinely can extend the Web UI, not by accident.

### 5.4 Keep your own panel (recommended)

The reference gateway deliberately keeps a **self-owned panel at `/__guard`** (L1 routes + L3 tap) as the surface that *survives* host upgrades, because slot registration depends on `SlotMap` and React, while `tapIndex` depends only on the fallback owner continuing to call `applyIndexTaps` (`measured, deepseek-harness-mobile/docs/spikes/superficie-ui.md:366-372`). For robust plugins that must outlive host restructures, do both: serve your backed API + HTML at your own prefix, and optionally mirror knobs as slots.

---

## 6. Activation: `dsh.bundle` and dependency-driven startup

### 6.1 `dsh.bundle.patch` is the real activation switch

A plugin is listed as an installable bundle through the `dsh` field in `package.json`. **What actually activates it is `dsh.bundle.patch`:**

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

Empty `bundle: {}` does **not** activate. Measured against `@deepseek-ai/dsh@0.1.0-rc.7` in a clean `$DSH_HOME`: activation is decided by `dsh?.bundle?.patch !== void 0` (dsh `lib/plugin-*.js:32`), and `dsh-app-boot` throws at boot if a listed bundle does not declare `.patch` (`lib/index.js:548`) — so `bundle: {}` would pass the registry gate and then silently do nothing at runtime (`reference, deepseek-harness-mobile/package.json:60`, and `cordis.patch.yml:7-13`).

### 6.2 Precedence layers (4)

The plugin's own `cordis.patch.yml` is **layer 1 (bundle)** — minimum priority, applied automatically to anyone who installs the package (`reference, deepseek-harness-mobile/cordis.patch.yml:22-33`):

| Layer | Source | Priority |
|-------|--------|----------|
| 1 — Bundle | declared `dsh.bundle.patch` (this package), `dsh-base` first | **minimum** |
| 2 — Profile | `$DSH_HOME/profiles/<profile>/cordis.patch.yml` | overrides 1 |
| 3 — Home | `$DSH_HOME/cordis.patch.yml` | overrides 2 |
| 4 — Overlay | `dsh --patch ./overlay.yml` | **absolute** |

Resolution is **whole-entry replace, not deep merge** (`reference, deepseek-harness-mobile/src/config/schema.ts:101-103`): targeting an existing `id` from a higher layer discards the whole entry, so re-write all parallel nodes you want to keep.

### 6.3 Activation is by service availability, not YAML order

A plugin that declares `export const inject = ['webServer']` stays **PENDING** until `ctx.webServer` exists, then runs `apply`. Position in the patch YAML carries **no load semantics** (`measured/verified in dsh-base@0.1.0-rc.7/cordis.patch.yml:12-13` — literal comment "Row order carries no load semantics"; also `reference, deepseek-harness-mobile/src/index.ts:365`). This is why the barrier's precondition is guaranteed: because it waits for the service, `webServer` has already passed `[Service.init]` and is listening, so the dispatch is there to take.

> ⚠️ **A trap measured with `logger`:** only services that extend `Service` enter the injectable store. A plugin injecting `'logger'` (a LoggerService that does **not** extend `Service`) becomes PENDING **forever** — `apply()` never runs, no error, no log (`measured, deepseek-harness-mobile/src/index.ts:344-363`). Prefer the direct `ctx.logger` property, as published DSH packages do. The same class of silent failure applies to unknown strings — use type-verified service names.

---

## 7. ESM is mandatory; CommonJS is refused

The harness boots with `node --import tsx/esm` (`verified in the Guia de Contribuição`, and the reference project pins ESM-only semantics on the same boot path). Consequences for any plugin you ship:

- `package.json` must declare `"type": "module"`.
- Build with `module`/`moduleResolution: NodeNext` and real `.js` (or `.ts` under tsx) relative-import extensions; a mismatch breaks boot with `ERR_MODULE_NOT_FOUND`, not a compile error (`verified in deepseek-harness-mobile/docs/plano/05-QUALIDADE-CODIGO.md:358-379`).
- Never author a CJS plugin entry; `require(ESM)` is unflagged on supported Node (`>=20.19/22.12/23`) making ESM-only the correct default (`verified, deepseek-harness-mobile/docs/plano/08-PESQUISA-E-FONTES.md:673-675`).

---

## 8. Downlink to the client: WebSocket, not SSE over `/api`

A plugin pushing live state to the browser should use a **WebSocket**, not a Server-Sent Events endpoint under `/api`. The DSH design already concluded this (official architecture note: *"WebSocket carrier for browser downlinks"* — https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-08-04-websocket-downlink-carrier.md), and the reference harness uses WebSocket for its own downlink (`reference, deepseek-harness-mobile/src/index.ts:935`; registered through `registerUpgrade`, handshake guardable — `verified, deepseek-harness-mobile/docs/spikes/api-dsh.md:418`).

Why not SSE:

- HTTP/1.1 browsers cap around **6 concurrent connections per origin**; each hung SSE occupies one forever, exhausting the pool and stalling the harness's own `/api` RPCs (narrative in the Plugin-Cordis material; the DSH moved its persistent channels to a dedicated WebSocket).
- Over a Cloudflare quick tunnel, SSE via **GET** is buffered by the edge (cloudflared issue #1449) while WebSocket streams bidirectionally end-to-end (`measured, deepseek-harness-mobile/docs/spikes/cloudflared.md S3:204-234`).

If you must hold a channel open, hold a WebSocket and register it with `ctx.webServer.registerUpgrade({ path, handler })` (exact match only, §2.1). Guard the upgrade handshake inside your own dispatch (L2) so cross-site WebSocket hijacking is rejected (`reference, deepseek-harness-mobile/docs/TESTING.md:49`, CWE-1385).

---

## 9. HMR and `dsh-client-hmr`

The harness hot-replaces plugin code while running:

- `@deepseek-ai/dsh-client-hmr` registers `exact /plugins/events` and mounts the Web UI's live reload. It only becomes active if **you run the dev watcher** — `pnpm run dev:web` (`reference, deepseek-harness-mobile/docs/spikes/superficie-ui.md:89-97,233-241`; official README https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/hmr/README.md).
- **Plain packages** — the web shell in `apps/web` and the client packages in `packages/client` — do **not** reactively reload. Editing them **requires `pnpm run build` followed by a page refresh** to re-emit the module table the boot injects. (Client-plugin bundles rebuild only while `pnpm run dev:web` runs.)
- HMR has **no safe rollback**: a broken client module lands as FAILED and nothing restores the previous artifact — fix forward, manually. Do not start a stray Vite server on another port to "test" UI; without the injected `window.__DSH_BOOT__` context it will not behave (the harness's own post-mortem documents this class of mistake).

---

## 10. Securing the surface you expose

Any route or barrier you add is security surface. Minimum set (all patterns come from the reference gateway and its threat model):

- **Bind:** keep `ctx.webServer.host` on `127.0.0.1` unless you really need more; enforce it at boot (`assertSecureBind`, refuse `0.0.0.0` by default — `reference, deepseek-harness-mobile/src/config/bind.ts`). On a LAN/tunnel exposure this is exactly where a missing allowlist becomes a public hole (advisory #853).
- **Session:** use signed cookies, `HttpOnly`, `SameSite=Lax`/`Strict`, `Path=/`, regenerate the id on privilege change/invalidation. Never send the session secret to the browser.
- **CSRF:** the reference emits a fresh per-render CSRF nonce in a `<meta>` and requires it on every mutating POST (`x-dsh-csrf` header), with `SameSite` cookies as the outer layer (`deepseek-harness-mobile/src/panel/csrf.ts`, `src/ui-contrib/html.ts`).
- **Cookie `Secure`/`__Host-` WORKS on loopback — the belief "Secure fails on http://127.0.0.1" is refuted.** `measured, deepseek-harness-mobile/docs/spikes/superficie-ui.md S10:470-501`: Firefox 149 and Brave 149 both accept and **resend** `__Host-dsh_sid=<v>; Secure; HttpOnly; Path=/; SameSite=Strict` from `http://127.0.0.1` and `http://localhost`, and both *reject* it from a non-loopback HTTP origin (`http://192.168.122.1`). So use `__Host-` cookies with `Secure` even in local-loopback mode — the browser treats loopback as a trusted origin, and the `__Host-` prefix rule is still enforced.
- **Host header:** the `WebServer` router ignores `Host`, but the trust gate in `dsh-web-app` validates it (`measured, deepseek-harness-mobile/docs/spikes/superficie-ui.md:155-203`): a loopback or `trustedHosts` host passes, an `attacker.example.com` or random `*.trycloudflare.com` gets 403, and DNS-rebinding is the reason it matters.

---

## 11. Anti-patterns to avoid

| # | Claim / habit | Reality |
|---|---------------|---------|
| AP-1 | "Install the barrier with `ctx.intercept('webServer', { registerFallback(...) })`" | **Refuted by measurement.** `intercept` is config-merge, inert for `webServer` (no `resolveConfig` reads). Real mechanism: dispatch-ownership swap (S12). |
| AP-2 | "There is a public API to enumerate registered routes" | **Does not exist.** Only private-table runtime enumeration (`superficie-ui.md:76-78`). |
| AP-3 | "`cookie Secure` doesn't work on loopback" | **Refuted (S10).** Works and is recommended on `127.0.0.1`/`localhost`. |
| AP-4 | "There is a declarative runtime-compat field in `package.json`" | **No.** `dsh.client` declares a *client bundle*; "compatibility" is the typed `SlotMap` + inject dependencies. Do not invent a field. |
| AP-5 | "YAML order = load order" | **No load semantics** (`dsh-base` patch comment). Activation is by inject availability. |
| AP-6 | "A plugin can take the fallback seat for its SPA" | **Throws.** Single seat owned by `dsh-host-frontend-static`. |
| AP-7 | `prependListener` as a barrier "veto" | Node has no listener veto; prepend runs first but can't block the rest. Only ownership blocks. |
| AP-8 | SSE over `/api` for the downlink | **Wrong direction.** Exhausts the ~6 HTTP/1.1 channels/origin and is buffered by quick-tunnel GET. Use a WebSocket via `registerUpgrade`. |

The unrelated claims in the honesty filter (Zero Trust 50-user limit, jcode benchmarks, the `pi2dsh` package, "quick tunnel doesn't support SSE", "bot token bypasses the allowlist", and the rest) are **refuted by real measurement or unconfirmed** — none are taught here as truth; see the sibling research docs.

---

## 12. Verified sources

- `@deepseek-ai/dsh-host-webserver@0.1.0-rc.7 / rc.8` — `lib/types/index.d.ts` (service `webServer`, `register`/`registerUpgrade`/`registerFallback`/`tapIndex`/`applyIndexTaps` signatures) and `lib/index.js` (route tables, duplicate throws, `match()` order, `this.server = createServer`). sha256 `b5fee946...` (`deepseek-harness-mobile/docs/spikes/api-dsh.md:418`).
- `@deepseek-ai/cordis@4.0.1` — `src/context.ts:141-145` (`intercept` body = config merge), `src/service.ts:86-93` (`resolveConfig`).
- `@deepseek-ai/dsh-host-frontend-static@0.1.0-rc.8` — `lib/index.js:72` (`applyIndexTaps`), mounted by `dsh-web-app` (`web-runtime`).
- `@deepseek-ai/dsh-client-ui-slots@0.1.0-rc.8` / `@deepseek-ai/dsh-client-runtime@0.1.0-rc.8` / `@deepseek-ai/dsh-client-modules@0.1.0-rc.8` — `ctx.slots` (`SlotRegistry`), slot register overloads, `dsh.client` parser, `ClientModuleRegistry` scope-free scan.
- Spikes (measured) — `deepseek-harness-mobile/docs/spikes/api-dsh.md` (API names, `ctx.intercept` §6), `deepseek-harness-mobile/docs/spikes/interceptacao.md` (S12 barrier, 35 assertions, 7 routes), `deepseek-harness-mobile/docs/spikes/superficie-ui.md` (S4 tapIndex, S10 cookie `Secure` on loopback, fallback single-seat, no route enumeration).
- Reference repository — `deepseek-harness-mobile`: `src/http/intercept.ts`, `src/dsh/adapter.ts`, `src/ui-contrib/{html,surface}.ts`, `src/index.ts`, `cordis.patch.yml`, `package.json`.
- Official public sources — `https://github.com/deepseek-ai/deepseek-harness` (advisory #853; architecture note "WebSocket carrier for browser downlinks"; `packages/client/hmr/README.md`; `packages/host/webserver`).

*Last updated with the DSH interface APIs as of `0.1.0-rc.7 .. 0.1.1-rc.1`. The DSH is in developer preview and its API is evolving fast; re-verify signatures against the pinned `.d.ts` mirrors before relying on this document.*
