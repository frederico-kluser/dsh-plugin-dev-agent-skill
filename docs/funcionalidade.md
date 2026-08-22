# dsh-plugin-dev — Building backend functionality in a DSH plugin

_Creating real, stateful backend behavior in a DeepSeek Harness plugin: the plugin anatomy, typed events, tooling, long-lived control machines, subprocesses, IPC, queues and the security discipline that keeps it safe._

This document is part of the **dsh-plugin-dev** skill. It assumes you have read
[docs/arquitetura.md] and [docs/interface.md]. Where this file says "measured" it means
_verified against the real DeepSeek Harness package_ (`@deepseek-ai/dsh@0.1.0-rc.7`
range) and the reference plugin **dsh-guarded-bot-orchestrator**; the exact source is
given as `verified in <path>:<line>` for every claim that carries it.

---

## 1. Everything is a plugin — the anatomy

DeepSeek Harness is built on Cordis v4. There is no privileged kernel and no global
"app object": every capability — the agent loop, tools, HTTP endpoints, a scheduler —
is a plugin loaded into a shared `Context` (`ctx`). A backend plugin is a single
module with three or four top-level exports:

| Export | Role | Required? |
| --- | --- | --- |
| `export const name: string` | Stable identity for the Cordis registry and the `cordis.yml`/patch `id`. | **YES** |
| `export interface Config` | The shape of the config object handed to `apply`. Validated at load (fail-loud). | **YES** for anything configurable |
| `export const inject: (keyof Context)[]` | Explicit services this module must have before `apply` runs. | Only if you depend on services |
| `export function apply(ctx, config): void` | The activation body. Declares effects, handlers, subscriptions. | **YES** |

### 1.1 The canonical minimal shell

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-backend-plugin'

export interface Config {
  /** Every runtime-tunable knob lives here. Nothing is hard-coded in the module. */
  maxRetries: number
  /** A value you refuse to guess: absent is a load error, never a silent default. */
  bindingHost: string
}

export const inject = ['webServer', 'subprocess']

export function apply(ctx: Context, config: Config): void {
  // Activate here. Guardrails first, effects last.
}
```

### 1.2 `Config` is replaced whole, not deep-merged

The patch engine's `replace` is a **shallow merge of the entry's top-level keys**; the
`config` object itself, when present, is replaced **entirely**
(`verified in dsh-guarded-bot-orchestrator/src/config/schema.ts:5-13`). Consequence:
**a key omitted inside `config` is a key deleted, not inherited.** Every mandatory key
must be present in the object you ship, or your `apply` gets an incomplete object.

### 1.3 Fail loud at load

Invalid config must **throw in `apply`**, at activation time, so the failure is
audible immediately — never a silent `?? default` that turns on in some unrelated
code path hours later (`verified in src/index.ts:42-44`, `src/config/schema.ts:220-226`).
See [docs/seguranca.md] for the full rule; the short version:

```ts
export function assertValidConfig(config: Config): void {
  if (config.ttlMinutes === undefined || config.ttlMinutes <= 0 || config.ttlMinutes > 480) {
    throw new Error(`[${name}] tunnel.ttlMinutes invalid: ${config.ttlMinutes}`)
  }
  // NEVER clamp. A 10080 silently reduced to 480 tells the user they got a week.
}
```

### 1.4 `inject` vs `ctx.get()`

- `inject` **waits**: the fiber stays `PENDING` until every listed service exists, then `apply` runs once.
- `ctx.get('service')` **probes**: returns `undefined` if the service is absent. Use it only for optional, non-blocking features.

---

## 2. Typed events — `@mode` waterfall/parallel/on, and the veto

Cordis communicates via **typed events** declared by augmenting the global `Events`
map inside `declare module '@deepseek-ai/cordis'`. The compiler therefore validates
every dispatch (see `verified in dsh-guarded-bot-orchestrator/src/dsh/adapter.ts:87-94`).

### 2.1 Declare the event

```ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** @mode waterfall */
    'security/permission-elevate'(command: string, next: () => Promise<boolean>): Promise<boolean>
  }
}
```

### 2.2 Waterfall = around-middleware, and the veto

`ctx.waterfall` is the interception primitive. Each listener receives the event args
plus a continuation `next()`. **Calling `next()` passes control onward; returning
without calling it short-circuits (vetoes) the rest of the chain**.

A veto example — refuse a dangerous permission elevation even to an authenticated caller:

```ts
ctx.waterfall(
  'security/permission-elevate',
  command,
  async (next) => {
    if (command === 'danger-full-access') return false // VETO: no next()
    return next()                                      // delegate onward
  },
)
```

### 2.3 Modes

| Event mode | Semantics | Use for |
| --- | --- | --- |
| `on` | Listeners run in parallel; return value ignored. | Observability, audit, fan-out. |
| `parallel` | Listeners run in parallel; all must settle; result is the array. | Coordinating independent checks. |
| `waterfall` | Sequential around-middleware; a listener short-circuits by not calling `next()`. | Auth barriers, vetoes, rewrite pipelines. |

> ⚠️ A waterfall listener that does unbounded `await` on a network call can hang the
> chain. In a waterfall, an infinite retry is an infinite freeze of every downstream
> subscriber.

---

## 3. The trap: never use `logger` in `inject`

`LoggerService` **does not extend `Service`**. It is not in the reflect store. The root `Context`
creates it as an own property (`this.logger = new LoggerService(self)`), so:

- `ctx.get('logger')` returns **`undefined`**;
- a fiber that declares `inject: ['logger']` stays **PENDING forever** — `apply` never runs,
  and there is no error and no log.

This was measured against real Cordis: adding `'logger'` to `inject: ['webServer','subprocess']`
flips the fiber `ACTIVE → PENDING`, and the endpoint silently answers 200 unauthenticated
(`verified in dsh-guarded-bot-orchestrator/src/index.ts:345-364`).

**Always use `ctx.logger`** — directly available without injection, which is how every
published DSH package does it.

---## 4. `ctx.tools` with Standard Schema — `execute(args)` vs `render`

Tools exposed to the model must be validated with a **Standard Schema** DSL (never hand-rolled
runtime checks). This both formats LLM hallucinations into structured errors and maps to strict
TypeScript type-checking.

Two responsibilities are split deliberately:

- **`execute(args)`** — the pure logic, returns a canonical value (JSON/memory).
- **`output.render`** — turns that canonical value into model-facing blocks, e.g. `[{ type: 'text', text: ... }]`. Bulk internal data never pollutes the model's token budget.

```ts
import { s } from 'schemastery' // Standard Schema DSL

export const tool = ctx.tool({
  name: 'status',
  schema: s.object({ verbose: s.boolean().default(false) }),
  async execute({ verbose }) {
    return verbose ? fullStatus() : { state: currentState() },
  },
  output: {
    render(result) {
      return [{ type: 'text', text: JSON.stringify(result) }],
    },
  },
})
```

> The precise `ctx.tools` registration surface changed across the preview range
> (`tools.register` vs `ctx.tool`). Pin a version and read its `.d.ts`; see [docs/empacotamento.md].

---

## 5. Commands / triggers — Telegram as the control surface

When the plugin owns a Telegram bot (via a long-polling worker, §9), command handling is a
two-stage machine: the **worker** normalizes the update, the **host** decides.

### 5.1 `setMyCommands`, the update funnel, and the "no intent" rule

- Publish the command list with **`setMyCommands`**; the command names are the contract your
  funnel matches (`verified in dsh-guarded-bot-orchestrator/src/contracts/ipc.ts:258-276`).
- Unknown input ⇒ **no intent** ⇒ ignore. Never guess.
- **`/start` is innocuous and does NOT pair anyone** (D8). Pairing resolves inside the worker;
  the host is only informed of the outcome. `/start` greeting is safe, and pairing is not part
  of the crossing channel (`verified in src/contracts/ipc.ts:269-272`, `worker/auth/pairing.ts`).

### 5.2 The funnel — worker normalizes, host decides

```ts
// worker side: normalize update -> typed intent -> IPC to host
const intent = { type: 'intent', intent: 'tunnel.up', requestId: ulid(), from, chat, nonce }
channel.send(JSON.stringify(intent))
```

The host re-checks identity (see §9/sessions), because a check that lives only in the
internet-facing process is the first to fall if that process is compromised (§11).

---

## 6. The ControlIntent state machine

Long-running exposure like a tunnel needs a **single, closed vocabulary** of state plus a
**single controller**. Six states are the vocabulary
(`verified in src/contracts/tunnel.ts:49-55`):

`STOPPED · STARTING · READY · DEGRADED · STOPPING · FAILED`

- `DEGRADED` — failed but budget remains: retries on its own with backoff.
- `FAILED` — terminal; exits **only** via an explicit `reset()` by the owner.

### 6.1 `ControlIntent` — action + idempotency + nonce

```ts
type ControlAction = 'start' | 'stop' | 'reset'

interface ControlIntent {
  readonly action: ControlAction
  readonly requestedBy: string            // e.g. 'telegram:123456' or 'panel:<hash>'
  readonly requestId: string              // ULID. IDEMPOTENCY KEY.
  readonly nonce?: string                 // only for actions that INCREASE exposure
  readonly at: number                     // injected clock, never Date.now()
}
```
(`verified in src/contracts/control.ts:99-119`)

- **`requestId` (ULID) is the idempotency key.** A repeated `requestId` returns the result of the
  first execution (ack `noop`); it never creates a second process (`verified in
  src/contracts/control.ts:90-93`, `src/contracts/ipc.ts:178-180`).
- **A nonce is required only for actions that increase exposure** (`start`, `reset`). `stop` and
  emergency actions **dispense** with it: in a panic the button must work on the first press
  (`verified in src/contracts/control.ts:160-164`, `src/contracts/ipc.ts:260-267`).

### 6.2 The one rule that keeps it safe: `start` in `STOPPING` is REJECTED

**A `start` received while the controller is `STOPPING` is REJECTED with
`SHUTDOWN_IN_PROGRESS` and never queued** (D29). Rejecting is fail-closed; queueing is fail-open:
if the owner hits `/emergencia`, watches the tunnel die, and it comes **back** because a queued
`start` fired, every temporal control in the system is fake (`verified in
src/contracts/ipc.ts:181-190`).

### 6.3 Serialized queue + reconciliation

- Intents are serialized on a **queue of one** — no concurrent state mutations.
- After the intent executes, the controller **reconciles** `desiredState` with the real process
  (`STARTING → READY` re-verifies the running process and its `seq`).
- State machine transitions are a frozen table, not scattered `if`s
  (`verified in src/contracts/control.ts:59-74`).

---

## 7. Sessions

### 7.1 Magic link — the one-time bearer

- `mk` = **128 bits CSPRNG** (16 bytes), TTL **120 s**, single use, **in memory only** — never
  persisted (`verified in src/session/magic.ts:1-9,55-59`).
- Carried in the URL **fragment** (`#`), never query (D3) (`verified in
  src/session/magic.ts:84`).
- `POST /__guard/magic` **consumes** the token once; `GET` is **inert** (`verified in
  src/index.ts:145,193-198` — only the listed unauthenticated prefixes precede a session).

The store's map is keyed by `sha256(mk)`, not the plaintext token — which also removes the
string-comparison timing oracle (`verified in src/session/magic.ts:111-119,179-200`).

### 7.2 Revocation

Revoke on: TTL expiry, the tunnel going down, restricted mode, or un-pairing. `revokeAll()`
clears the live set; `dispose()` is synchronous and idempotent (`verified in
src/session/magic.ts:189-196`). **A session dies with the tunnel.**

### 7.3 The order matters

When the TTL expires: **drop the tunnel → invalidate ALL sessions → audit → only then notify
the owner on Telegram**. The audit must never depend on the notify step, which can fail on the
network (`verified in src/contracts/tunnel.ts:228-236`).

---
## 8. Tunnels — quick vs named, and the fail-closed probe

### 8.1 `quick` (trycloudflare)

- Zero state on disk; a fresh random hostname every cycle; **no SLA**.
- **TTL 60 min** default, delivered via `ttlMinutes` in the patch; the code path has **no silent
  default and no clamp** (absent/0/negative/`> 480` are load errors) (`verified in
  src/contracts/tunnel.ts:204-241`).
- `~200` in-flight requests → 429 is expected (rate limiting at the edge).
- TLS terminates at the edge.
- **The public URL is NOT a secret** — it's discoverable in bulk and changes each restart
  (`verified in src/contracts/tunnel.ts:72-75`). It therefore buys nothing for auth; ALL
  authentication lives inside the plugin.
- **No Cloudflare Access in front** (Access needs `zone_id`).

### 8.2 `named` (your domain)

- Requires a domain + **`--token-file`** + Access policy. Token is delivered by file path,
  **never `--token` in argv** — argv is readable by any same-user process via
  `/proc/<pid>/cmdline` (`verified in src/tunnel/args.ts:23-28,196-211`).

### 8.3 The fail-closed probe — BEFORE the tunnel goes up

Before spawning `cloudflared`, run the local gate against `127.0.0.1:<port>` and refuse to
expose anything if it does not answer `401` where expected. Four probes, because proving `/`
does not prove `/api` (registration-order hazard) (`verified in src/contracts/tunnel.ts:110-124`):

| Probe | Path | Expect |
| --- | --- | --- |
| `spa-fallback` | `GET /` | `401` |
| `api-rpc` | `POST /api/<read rpc>` | `401` |
| `websocket-upgrade` | `GET /` with `Upgrade: websocket` | socket destroyed or `401` |
| `unguarded-canary` | `GET /__guard/probe-canary-<rand>` | `401` |

Fail-closed: `"the app responds" ≠ "the app responds 401 without a credential"` — confusing the
two is exactly what publicly exposed a real user's control plane for ~40 s during research
(`verified in src/contracts/tunnel.ts:393-419`).

### 8.4 Readiness vs probe — two different gates

- **Probe** answers "is the gate armed?" and runs **before** the tunnel.
- **Readiness** (`waitUntilUsable`) answers "is this URL usable?" and runs **after** the tunnel.

### 8.5 TTL expiry, and the "no renew" rule

- At expiry the whole tunnel is torn down and sessions invalidated (§7.3).
- `/status` or an access **does NOT extend the TTL**; only an explicit `start` opens a new window
  (TUN-026) (`verified in src/contracts/tunnel.ts:235-236`).
- **There is no renew.** Expiry is terminal until a fresh, explicit action.

---

## 9. Telegram — grammY as the only runtime dependency

- **grammY is the single runtime dependency of the plugin, and it lives only in the worker**
  (`verified in dsh-guarded-bot-orchestrator/package.json`: `dependencies: { grammy }`; the
  worker runs in a subprocess, §10).
- **Long-polling** with `getUpdates`. A **second instance polling the same token gets `409
  Conflict`** (`LONG_POLL_MAX_TIMEOUT` is 50 s server-side) (`verified in worker/lib/polling.ts:66-68,154-157`).
- **Environment is an allowlist**, not `process.env` inherited whole: PATH, HOME, TMPDIR, LANG,
  LC_*, TZ, TLS roots, plus the bot token. `NODE_OPTIONS` is deliberately excluded (it enables
  `--require`, i.e. arbitrary code load in the worker) (`verified in
  dsh-guarded-bot-orchestrator/cordis.patch.yml`, "AMBIENTE DO WORKER").
- **Button = text only.** `callback_data` is 1–64 bytes supplied by the client and is **never
  proof of authorization** (`verified in src/contracts/ipc.ts:113-120`). The anti-"confused
  deputy" defence is a **per-action nonce** issued and consumed host-side; the internet-facing
  worker merely transports it opaque (§11).

---

## 10. Subprocesses — `spawn(spec)`, tree-kill, and error semantics

### 10.1 The API: `spawn(spec)`, never `spawn(cmd, args, opts)`

The subprocess seam is **`ctx.subprocess`**; you call `ctx.subprocess.spawn(spec)` where spec is a
`SubprocessSpawnSpec`, and you get a `SubprocessHandle`
(`verified in dsh-guarded-bot-orchestrator/src/dsh/adapter.ts:29-34`,
`src/proc/supervisor.ts:7,264`). The `-local` implementation is tree-scoped on every platform
(`signalTree()` does `process.kill(-pid, sig)` on POSIX and `taskkill /T /F` on Windows).

```ts
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

const spec: SubprocessSpawnSpec = {
  argv: [process.execPath, entrypoint],          // resolved from import.meta.url, never cwd
  cwd: packagedWorkerDir,                        // or default from this module's location
  stdio: ['pipe', 'pipe', 'pipe'],               // stdin piped => dead-man's switch (§10.5)
  graceMs: 3000,                                 // required: the seam applies no defaults
  signal: abortController.signal,                // abort cascades the termination onto the tree
}
const child = ctx.subprocess.spawn(spec)
child.done.then((outcome) => { /* exitCode, signal */ })
```

`SubprocessHandle` gives you `{ done, terminate() }`. `terminate()` is idempotent and is a no-op
when the tree is gone; `done` collapses `'exit'` and `'error'` into one promise
(`verified in src/proc/supervisor.ts:27-36`).

### 10.2 Tree-kill via detached + `kill(-pid)`

The `!child.killed` guard that appears in documentation makes tree-kill **dead code** — Node sets
`child.killed = true` synchronously during `abort()`, before your next line runs. Kill the whole
**process group** with `kill(-pid, 'SIGKILL')` regardless of prior state so grandchildren die too
(`verified in src/proc/tree-kill.ts:8-31,82-105`). On Windows the seam's own `taskkill /T /F`
covers it.

### 10.3 `close` vs `exit` — ENOENT

On a spawn error like `ENOENT`, the sequence is `error → close` and **`'exit'` never fires**
(`child.pid === undefined`, `close` gets `(-2, null)`). A supervisor that waits on `'exit'` hangs
forever on the most common failure (missing binary). **Hook the `done` promise / `close`, never
`'exit'`** (`verified in src/proc/supervisor.ts:27-36`, `src/contracts/tunnel.ts:141-148`).

### 10.4 Supervisor + backoff + finite budget

- **Supervisor** owns spawn, tree-kill, stream wiring, and the "died on its own" vs "we killed it"
  distinction.
- **Backoff**: base 500 ms, doubling, capped at 10 s, jitter added **on top of** the base (never
  subtracted — the floor is the documented base) (`verified in src/proc/backoff.ts:16-38`).
- **Finite budget**: `maxAttempts`; exhaustion → **terminal state**, not infinite retry.
- **Non-retryable** (exit the loop immediately, do not consume budget): `ENOENT`, `EACCES`,
  invalid config (`verified in src/contracts/tunnel.ts:138-151`).
- The budget counters reset only after **healthy uptime** (`resetAfterMs`), never "per success" —
  otherwise a process dying every 5 minutes restarts forever with a zeroed backoff (SUP-004)
  (`verified in src/contracts/tunnel.ts:302-304`).

### 10.5 Dead-man's switch — EOF on stdin kills the worker

With `stdin: 'pipe'`, if the host is `SIGKILL`ed the kernel closes the worker's stdin; the worker
detects EOF and terminates itself. This is the **only** defence that survives a `SIGKILL` in the
host, because the disposer never runs. **But it requires the child to cooperate** — third-party
binaries like `cloudflared` do not cooperate, so the pipe dead-man's switch is for *your* worker
code, not for `cloudflared` (`verified in src/index.ts:1081-1091`,
`src/contracts/ipc.ts:39-53`).

### 10.6 Pipe backpressure

A child that writes to `stderr` with no durable reader stalls after **190 464 bytes**
(pipe buffer + Node internal queue). Attach a durable consumer to the stream before any
opportunistic reader, and remove it only on close (`verified in src/contracts/tunnel.ts:332-356`,
`src/proc/supervisor.ts:308-331`).

---
## 11. IPC — JSONL S1–S6, and the “worker keeps only the last seq” rule

Host ⇄ worker communication rides **bidirectional JSONL over the child's stdin/stdout**. No
socket, no port, no file — a new local port would be one more surface to guard. Six invariants
are contract, each owned by a test (S1–S6 invariants, `verified in src/contracts/ipc.ts:64-126`):

| # | Invariant |
| --- | --- |
| **S1** | One JSON message per `\n`-terminated line, UTF-8. |
| **S2** | **Flow discipline**: the worker writes *only* JSONL to `stdout`; all human log goes to `stderr`. |
| **S3** | **No secret in the payload** — password, digest, bot token, OTT, `mk`, absolute paths. (The tunnel URL *may* travel: it is not a secret.) |
| **S3-b** | The pairing-code digest is the single, named exception (10^6 space, 5 min TTL, reversible in ms; never leaves the machine). |
| **S4** | A malformed line is **discarded, the channel survives**. Never tear the channel down over one bad byte. |
| **S5** | **The worker does not validate the nonce** — the host issues and consumes it. A nonce validated in the internet-facing process is a variable, not a control. `callback_data` is never proof of authorization. |
| **S6** | The **identity allowlist lives in the worker**; the **nonce lives in the host**. They must not swap sides. |

**The worker keeps only the last `seq` it has seen** — the host is the single source of truth,
and the bot is a projection. `seq` is monotonic, so the worker discards out-of-order broadcasts
instead of moving the UI backwards during a tunnel flap (`verified in src/contracts/ipc.ts:148-158`).

```ts
// host -> worker broadcast
{ v: 1, type: 'state', state: 'READY', seq: 42, url: 'https://x.trycloudflare.com', expiresAt: 1756000000000 }
```

---

## 12. Queues and backoff — timeouts and budgets

| Setting | Value | Meaning |
| --- | --- | --- |
| Backoff base | 500 ms (doubling) | nominal `reconnect.initialDelayMs` |
| Backoff cap | 10 000 ms | nominal `reconnect.maxDelayMs` |
| Budget | finite (e.g. `maxAttempts: 10`) | exhaustion → terminal |
| `toolCallTimeoutMs` | 60 000 ms | sub-tool-call timeout cited for MCP |
| `DEGRADED` | failed but budget remains | retries on its own with backoff |
| `FAILED` | terminal | exits only via explicit `reset()` |

Attempts reset only after healthy uptime (§10.4). **`DEGRADED ≠ failed`**: it means the budget is
not exhausted, keep trying. `FAILED` is the only terminal state where the owner must act.

---

## 13. Security when exposing — the discipline

1. **Fail loud at load** — invalid config/bind throws in `apply`, never `?? default` on a
   security decision (`verified in src/index.ts:42-44`).
2. **Explicit > implicit** — every security policy comes from config; nothing is inferred.
3. **No `?? default` in a security decision.** The safe default for an *absent* field may be
   fine (e.g. missing `exposure` reads as the most closed `loopback`), but that must be the
   *closing* reading and it must be verbosed at boot (`verified in src/config/schema.ts:288-309`,
   `src/index.ts:477-486`).
4. **Empty list = closed and loud.** `trustedRemotes: []` denies everyone with a 403 *and* warns;
   `deniedPermissions: []` vetoes nothing and warns; `guardedPrefixes: []` declares no inventory
   and warns (`verified in src/index.ts:439-472`).
5. **`apply()` does no I/O — the auth/reporting stack is lazy.** It is assembled on first use, not
   at boot (the lazy-stack note in `recuperarBoot` and the controller effects).
6. **Path resolution fails loud at load.** Worker entrypoint/cwd are resolved from
   `import.meta.url` (never `process.cwd()`), and directory existence is asserted at activation —
   a fixed wrong path would break every npm install (`verified in src/config/schema.ts:167-211`).
7. **Defense in depth where the primary gate cannot reach.** The permission-elevation veto event
   is declared even though no documented DSH component emits it today — it is armed for the day it
   does. The primary close for the real threat (#853/#1769) is the auth barrier + origin allowlist
   + loopback bind (`verified in dsh-guarded-bot-orchestrator/cordis.patch.yml`, `deniedPermissions`).

---

## 14. Common traps (measured)

| Trap | Truth |
| --- | --- |
| `dist-tag latest vs next` | On this package `latest` is the **stale** `0.0.x` line; pin **`0.1.0-rc.7`**. Do not `npm i` unpinned. `[UNVERIFIED]` for the very latest numbers — pin and verify at install time. |
| `dsh.bundle: {}` | **Does not activate.** The registry accepts it but the product decides activation on `dsh?.bundle?.patch !== void 0`; `dsh plugin add` then activates nothing. Use `dsh.bundle.patch` (`verified in dsh-guarded-bot-orchestrator/package.json`, `//dsh`). |
| Entrypoint by `cwd` | Breaks: the host's cwd is the user's workspace, unrelated to where the package was installed. Resolve from `import.meta.url`. |
| Spawning a `.ts` from `node_modules` | **Impossible** — Node refuses type-stripping there (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, measured on v24.15.0). Compile to `.js` in `dist/`. |
| `ctx.intercept` for method-wrapping | **Refuted.** `ctx.intercept` is config merge, does not wrap methods, and is inert for `webServer`. Capturing dispatch on the underlying `node:http.Server` is what works (`verified in dsh-guarded-bot-orchestrator/cordis.patch.yml`, intercept section). |
| `ctx.waterfall` for a plain sum | Waterfall is an around-middleware with a veto — not run-handlers-and-sum. That is `parallel`. |
| `drop_pending_updates` on `getUpdates` | **Is not a parameter of `getUpdates`.** It is a parameter of `setWebhook`/`deleteWebhook`; grammY's `bot.start({ drop_pending_updates: true })` maps to a `deleteWebhook({ drop_pending_updates })` call (`verified in worker/lib/polling.ts:36-45`). |

---

## 15. Checklist — exposing backends safely

- [ ] `Config` keys are all present in the shipped patch (whole-`config` replace).
- [ ] `apply()` throws for invalid/insecure config (fail loud at load).
- [ ] `ctx.logger` is used; `logger` is never in `inject`.
- [ ] All typed events are declared via `declare module` with correct `@mode`.
- [ ] Waterfall vetoes actually short-circuit (no `next()` on refusal).
- [ ] `requestId` (ULID) dedupes; nonces only for exposure-increase actions.
- [ ] `start` during `STOPPING` is rejected, never queued.
- [ ] Probe (fail-closed, 4 probes) runs before the tunnel; readiness runs after.
- [ ] Sessions are revoked (TTL/orphan/emergency) and tied to the tunnel's life.
- [ ] TTL expiry order: tunnel down → sessions invalidated → audit → notify.
- [ ] No `--token` in argv; always `--token-file`.
- [ ] worker env is an allowlist; `NODE_OPTIONS` excluded.
- [ ] Spawn via `spawn(spec)`; exit handled on `done`/`close`, never `'exit'`.
- [ ] Tree-kill targets the process group; disposer is synchronous.
- [ ] IPC: JSONL over stdio, S2 discipline, S3 no secrets, dead-man's switch on stdin for *your* worker code.
- [ ] Finite budget + backoff (500ms→10s); counters reset only after healthy uptime; `DEGRADED` retries, `FAILED` is reset-only.
- [ ] Empty security lists are loud, not silent.
- [ ] `apply()` does no I/O; paths resolve from `import.meta.url` and fail loud.
- [ ] Entrypoint is compiled `.js` (`dist/`), never a source `.ts` under `node_modules`.

---

## Anti-patterns to avoid

1. `inject: ['logger']` — the silent PENDING-forever fiber. Use `ctx.logger`.
2. A silent default on a security decision (`??` on an auth field).
3. Waiting on `'exit'` — `ENOENT` never fires it.
4. `child.kill()` then assuming the tree is gone; or guarding tree-kill with `!child.killed`.
5. Letting the worker validate the nonce, or trusting `callback_data`.
6. Inheriting `process.env` wholesale into the worker.
7. Queueing a `start` behind a `STOPPING` — turns the kill switch into a coin flip.
8. Running the gate probe *after* the tunnel is up.
9. Resolving the worker path from `process.cwd()`.
10. Confusing the fail-closed probe with readiness.

---

## Verified sources

Primary reference plugin (the code these examples are inspired by, generalized — no proprietary code copied):
- `dsh-guarded-bot-orchestrator` — `src/contracts/{tunnel,control,ipc,auth,state}.ts`, `src/config/schema.ts`, `src/index.ts`, `src/session/magic.ts`, `src/secret/ott.ts`, `src/tunnel/args.ts`, `src/proc/{supervisor,tree-kill,backoff}.ts`, `src/dsh/adapter.ts`, `worker/lib/polling.ts`, `cordis.patch.yml`, `package.json` (paths relative to `/home/ondokai/Projects/deepseek-harness-mobile/`).

Official DSH docs:
- Architecture: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md
- Cordis tutorial — first plugin / lifecycle / services / events: `docs/cordis-tutorial/{01-first-plugin,02-lifecycle-and-effects,03-services,04-events}.md`
- Cordis primer (typed events / interception): https://deepseek-harness.github.io/deepseek-harness/en/reference/cordis-primer
- Cordis API events: `docs/cordis-api/events.md`

Threat model that motivated the exposed-surface discipline:
- https://github.com/deepseek-ai/deepseek-harness/discussions/853 (unauthenticated RCE via the web UI control plane)
- https://github.com/deepseek-ai/deepseek-harness/discussions/1769 (sandbox escape)

> The four analysis documents in `/home/ondokai/Documents/deepseek-harness/` are the prose
> backbone (`ctx.waterfall`, subprocess seam, config layers). Claims contradicted by direct
> measurement are resolved toward the measured behavior in §14.
