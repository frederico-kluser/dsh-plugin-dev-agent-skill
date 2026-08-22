# Testing a DeepSeek Harness Plugin — Strategy, Doubles, Contract, Adversarial, Mutation, Coverage, CI

> Part of the **dsh-plugin-dev** skill (docs/). Written by the W2 tests writer.
> Public-facing content: **English**. Every factual claim carries a source
> (`verified in <path>:<line>` or an official URL). Claims that are not
> confirmed are marked **[UNVERIFIED]** and go through the honesty gate in §14.
> Nothing is taught as truth if it is refuted by real measurement — the refuted
> claims list at the end of the skill applies here verbatim.
>
> Canonical companions: `docs/arquitetura.md`, `docs/interface.md`,
> `docs/funcionalidade.md`, `docs/seguranca.md`, `docs/testes.md`,
> `docs/empacotamento.md`.

## Context

A DSH plugin is a Cordis bundle published as an npm package. It lives on top of a
moving host: the `@deepseek-ai/*` scope is a **developer preview** and publishes
breaking changes by design ("o repositório não aceita submissões de pull requests"
and iterates at high speed — verified in
`/home/ondokai/Documents/deepseek-harness/Guia de Contribuição e Desenvolvimento para o DeepSeek Harness.md`;
the mobile case pins the supported range to `0.1.0-rc.7..0.1.1-rc.1`). Because
of that, a plugin test suite has two jobs that are easy to forget:

1. **Prove behaviour**, so a refactor cannot silently regress a guarantee
   (authentication gate, tunnel lifecycle, process teardown).
2. **Prove continuity against the host**, so a breaking change upstream turns
   into a red PR instead of a plugin that loads without its gate.

This document is the playbook for both. It assumes you already read
`docs/interface.md` (the surface you test against) and `docs/seguranca.md`
(the guarantees you must not regress).

The API names in this document are the **verified** ones, measured across the
supported release range `0.1.0-rc.7..0.1.1-rc.1`:
`ctx.webServer` of type `WebServer` (package `@deepseek-ai/dsh-host-webserver`),
`ctx.subprocess` of type `SubprocessRuntime` (package
`@deepseek-ai/dsh-subprocess` + `@deepseek-ai/dsh-subprocess-local`), and a
single-argument `spawn(spec: SubprocessSpawnSpec)`. The old forms
(`ctx.httpServer` / `HttpServerService`, `spawn(cmd, args, opts)`, the
package `@deepseek-ai/dsh-host-subprocess`) are **refuted by real measurement**
and may only appear in tests as the *target of a negative assertion* (see §6).
Verified in `test/contract/dsh-types.test.ts` (assertions CONTRACT-001..009) and
by byte-diff against the pinned tarball.

## 1. Philosophy — five lines

1. **Test observable behaviour, not implementation**: the criterion is "a request
   without a credential gets 401 with `WWW-Authenticate: Basic realm="…"`",
   never "the challengeBasicAuth function was called"
   (`verified in …/docs/plano/04-TESTES.md:57`, principle 1).
2. **Every non-deterministic dependency is an injected seam**: clock, RNG, HTTP
   transport, `spawn`, `process.kill`, secret generation, disk reads all enter
   as dependencies with a real default (`04-TESTES.md:60`).
3. **The double must lie less than the real thing**: a double that simplifies Node
   is a time bomb; every process double gets a contract test that proves the
   double itself behaves like Node (`04-TESTES.md:62`, §7).
4. **Security is an adversarial suite of its own**, not "one more case": a named
   list of attacks with an expected outcome, that actively tries to break the gate
   (`04-TESTES.md:64`, §7).
5. **The proof that a process died is `ps`, not `child.killed`**: every
   lifecycle assertion has an e2e twin that asks the operating system
   (`04-TESTES.md:67`; the §7.1 incident is the reason).

The central claim of this document: **line coverage does not prove anything.**
The most serious bug lived in this program family was on a line that was
**100 % covered** and executed by **eight green tests**. What proves a plugin is
( a ) doubles that replicate the real runtime, ( b ) an e2e with a real process
per critical invariant, and ( c ) mutation that kills the suite when the suite is
lying (`04-TESTES.md:56-57`, §7.1).

## 2. Runner — node:test is the recommendation

Two viable runners exist for a DSH plugin:

| | node:test (chosen) | Vitest (upstream favours it) |
| --- | --- | --- |
| Runtime | Node's built-in test runner | Third-party, Vite-based |
| Dependencies | **zero** — no runtime test dependency, no supply-chain surface for the test path | needs vitest + @vitest/* ecosystem |
| TypeScript execution | native type stripping (Node ≥ 24) — the .ts source runs directly | transform pipeline |
| Per-environment | single Node process; jsdom only if you vendor a DOM lib | // @vitest-environment jsdom directive per file |
| Coverage collect | --experimental-test-coverage (experimental only for collection; thresholds by CLI stable) | built-in c8/v8 |
| Mocking | mock.fn, mock.method, mock.timers | vi.* |
| File isolation | per-process isolation by default | per-file isolation |
| Snapshot | stable since Node 23.4 | built-in |
| Reporter | spec/tap/dot/junit/lcov via --test-reporter | rich |

**Decision: node:test.** Justification, grounded in the research:

- A DSH plugin is a pure Node library. It has no DOM, no JSX, no transform
  pipeline — the entire Vitest feature set that matters (browser mode, jsdom
  helpers, fast hot-reload DX) is useless overhead
  (`verified in …/docs/plano/08-PESQUISA-E-FONTES.md:686`: for a pure Node lib
  without DOM, node:test = zero dependencies and zero supply-chain surface).
- **A two-runner project is a non-negotiable anti-pattern**: two mock semantics,
  two report formats, two flake sources. The skill explicitly rejects "Vitest for
  the pure core + node:test elsewhere" (`04-TESTES.md:1561`, canonical decision
  D16). And this document **never teaches "Vitest is mandatory"** — it is
  mandatory nowhere here; it is one option the upstream project happens to use.
- node:test is stable since Node 20; snapshot since 23.4; coverage thresholds by
  CLI (--test-coverage-lines/branches/functions) are stable (`04-TESTES.md:150`).

**The upstream comparison (fair, not loaded).** The DSH monorepo favours Vitest
for its client packages: per-file environment directives
(// @vitest-environment jsdom) and a **100 % coverage mandate** for client tests
(verified in `/home/ondokai/Documents/deepseek-harness/Guia Definitivo e Catálogo de Plugins do DeepSeek Harness.md`
— the dev policy demands all test batteries stay at 100 %; the same material
quotes the per-file jsdom directive). The upstream *HMR-safety* concern — tests
must not race the hot-reload channel the host opens (GET /plugins/events, see
`docs/interface.md`) — is just as real for a plugin that wires
`registerFallback`/`registerUpgrade`, and is handled by the apply→dispose→apply
cycle in §5.7 and by running integration against a real server on port 0. So:
**adopt Vitest only if** you genuinely need a DOM/browser test for a
UI-contribution (client-side) package, where the upstream convention is the right
one. For a host-side plugin that drives `ctx.webServer` and `ctx.subprocess`,
node:test is the recommendation.

Operational rule (non-negotiable, `04-TESTES.md:148-150`): node --test with a
glob that matches **no files exits with code 1**. Every test directory is born
with a trivial green `_placeholder.test.ts`, deleted by the first real test in
it. Otherwise the gate stays red from "no files", not from a defect.

## 3. The six-layer pyramid

The pyramid (top = run order, parenthetical = who runs it / what it proves):

| layer | location | what it exercises | volume / time |
| --- | --- | --- | --- |
| MANUAL | docs/manual-runs/ (M1..M7) | real Telegram, real Cloudflare, real 4G phone, end-to-end streaming | ~7 runs, ~40 min |
| LIVE | test/live/** | real quick tunnel, opt-in, never in PR | opt-in |
| E2E OFFLINE | test/e2e/** | real node processes, fake cloudflared, real http on 127.0.0.1:0, real sockets — **no internet, no secret** | ~15 cases, <60 s |
| INTEGRATION | test/integration/<area>/** | Cordis ctx double + real node:http + real IPC pipes | ~90 cases, <10 s |
| UNIT | test/unit/** | pure functions, tables, property-based | ~220 cases, <2 s |
| MUTATION / CONTRACT | cross-cutting | mutation nightly; contract own network job | — |

Budgets (breaking a ceiling is a design bug, not a renegotiation;
`04-TESTES.md:402-413` §3.4):

| suite | time ceiling | breaking it means |
| --- | --- | --- |
| unit | 2 s | something is not pure |
| integration | 10 s | a disguised sleep |
| security | 5 s | — |
| e2e | 60 s | cut cases, do not raise the ceiling |
| full CI (1 Node) | 3 min | — |

The full pyramid is reproduced in
`verified in …/docs/plano/04-TESTES.md:86-115`.

> **Reality check on the "numbers".** These volumes are the mobile case's budget,
> reproduced as a sane target for a DSH plugin of comparable scope
> (gate + tunnel supervisor + Telegram bot + panel). They are a target, not an
> invariant — the gate is the *unbroken ceilings*, not the exact counts.
## 4. Test layout — the owner of the source owns the test

Canonical layout (04-TESTES.md:205-370 §3.2, canonical decision D1):

```
test/
  unit/<same path as src/ or worker/>/<file>.test.ts   [owner = owner of the source]
  integration/<area>/<case>.test.ts                    [owner = owner of the main source of the case]
  contract/dsh-types.test.ts                           [network; runs in PR and nightly]
  security/<vector>.test.ts                            [adversarial; owned by the security wave]
  e2e/<flow>.test.ts        OFFLINE, doubles only, BLOCKS PR
  live/<flow>.test.ts       real network, workflow_dispatch only
  support/{clock,ctx-double,child-double,telegram-server,state-dir}.ts
  bin/fake-cloudflared.mjs
```

Rules:

- **Ownership rule (D1): the owner of src/x/y.ts is the owner of
  test/unit/x/y.test.ts and of the test/integration/x/** files that exercise
  y.ts.** This eliminates the whole class of "one agent writes, another tests"
  conflicts.
- test/support/** and test/bin/** are **prep-owned and frozen**: born before the
  first real test, read-only afterwards, so shared doubles cannot drift under
  competing edits (04-TESTES.md:230, decision D15).
- **Four deliberate absences, each with a written reason**
  (04-TESTES.md:265-270):
  - src/index.ts — composition root; unit-testing it tests the double (§12).
  - src/contracts/** — types only, frozen by prep.
  - worker/telegram-bot.ts — process entry; covered by integration.
  - test/support/** — except child-double.contract.test.ts, which tests the
    process double *on purpose* (§5).

## 5. Doubles

### 5.1 The fake cloudflared

One fake binary, configured by argv/env, reproducing what was **measured** about
the real binary (verified in …/test/bin/fake-cloudflared.mjs and
verified in …/docs/plano/08-PESQUISA-E-FONTES.md §1.3/§7.4):

- the URL comes out of **two complementary channels, not primary/fallback**:
  ( a ) GET /quicktunnel on the metrics server returns {
  \"hostname\":\"…\"} **without a scheme** (the consumer must prefix https://), and
  ( b ) a regex over **STDERR** (measured: stdout stays 0 bytes in 6 runs);
- --metrics 127.0.0.1:PORT is **mandatory** — the default is not random, it grabs
  port 20241 and only falls to an ephemeral port when that range is busy (the
  port is *disputed*);
- /ready → 503 while readyConnections = 0, /healthcheck → OK, / → 404;
- SIGTERM shuts down in ~13 ms, exit 0, no ESRCH.

The fake is driven by **9 modes**, each a distinct contract (§5.5):

| mode | behaviour the consumer must survive |
| --- | --- |
| happy | nominal: metrics + URL on stderr + clean SIGTERM |
| silent | no output at all — "no URL yet" must be distinguishable from "URL on stdout" |
| slow | URL delayed (FAKE_CF_URL_DELAY_MS) |
| crash | exits non-zero on boot (--fake=crash) |
| instant-exit | process.exit(1) immediately |
| stdout-only | URL on **stdout** — the anti-pattern a consumer must not rely on |
| stubborn | ignores SIGTERM, so the supervisor's tree-kill is the only way to clear it |
| tree | spawns a grandchild so kill(pid) alone leaks it |
| partial-line | writes a half line then stalls, so a line-buffered parser cannot hang |

The crash/instant-exit/stubborn/tree modes are shown in
test/integration/proc/lifecycle.test.ts:52-64 and the SUP section of
04-TESTES.md:896-1097; the URL-delay/readiness knobs are the env vars of
test/bin/fake-cloudflared.mjs.

> **A new double mode is a contract change.** Adding the 10th mode touches the
> supervisor's decision table, so it goes through the same review as a public
> contract change, never as a "test-only" tweak.

### 5.2 The Telegram server

A minimal fake Bot API on 127.0.0.1:0, replicating the documented envelope of the
real API (verified in …/test/support/telegram-server.mjs):

```jsonc
// success
{ "ok": true, "result": <…> }

// error — HTTP status == error_code
{ "ok": false, "error_code": 429,
  "description": "Too Many Requests: retry after 5",
  "parameters": { "retry_after": 5 } }
```

Contract replicated from the Bot API reference: path /bot<token>/<METHOD>
(methods case-insensitive), ok:false + error_code + description with an optional
parameters (retry_after). parameters is exactly what your 429/retry handling
reads — assert it, do not hand-roll the shape. getUpdates holds the long-poll
response while the queue is empty, matching the real server (no busy-loop).
Canonical errors are copied verbatim from tdlib/telegram-bot-api/Client.cpp (the
409 conflict family and 401 unauthorized), so your retry/kill-switch logic is
tested against the *real* strings.

### 5.3 Injected clock and ctx double

- A fake clock plus a fake scheduler (tunable, with advance(), pending(), and
  order-of-fire scheduling) replaces Date.now()/setTimeout — a tunnel TTL of
  60 min and a session timeout of 8 h are not waitable with real time, and a
  global Date.now() mock would contaminate the whole suite
  (04-TESTES.md:1581 §8.1; verified in …/test/support/clock.ts).
- ctx-double implements the Cordis seam the plugin actually consumes: a **real**
  node:http.Server (never listening) whose request/upgrade listeners stand in
  for "the rest of DSH", ctx.webServer with register/registerFallback/
  registerUpgrade/tapIndex, ctx.subprocess, ctx.on/ctx.waterfall/ctx.effect,
  and an intercept() that **throws by design** — because ctx.intercept is
  config-merge, not method wrapping, and the webServer does not resolve it
  (verified in …/test/support/ctx-double.ts).
- The HTTP primitives are bare objects (FakeResponse, FakeSocket, makeRequest)
  converted with "as unknown as <Interface>" — deliberately; implementing full
  generics buys no coverage (ctx-double.ts).

### 5.4 The child-process double with its contract

verified in …/test/support/child-double.ts:

```ts
export class FakeSubprocessHandle {
  readonly pid: number
  readonly done: Promise<SubprocessOutcome>
  terminateCalls = 0
  // stdin/stdout/stderr PassThrough; stdin is a *real* pipe for IPC capture

  terminate(): void { this.terminateCalls += 1 }   // idempotent + tree-scoped
  waitForExit(): Promise<boolean> { return this.done.then(() => true, () => true) }
  settle(outcome: SubprocessOutcome): void { /* the process closed */ }
  fail(error: unknown): void { /* spawn-level failure: done REJECTS */ }
}
```

The **contract of the double** (what it must replicate from the real seat so it
lies less than the real runtime; 04-TESTES.md:1433-1471 §7.1; verified
behaviour of the real seat):

| behaviour | the double must do |
| --- | --- |
| AbortSignal from the spec | abort() calls terminate() **synchronously** |
| terminate() | idempotent, tree-scoped on every platform, works after an already-aborted signal (deferred to nextTick in the real seat) |
| done | resolves with exit facts; **rejects only on spawn failure** |
| ENOENT at spawn | done rejects → the caller sees error + close, **no** exit |
| killed semantics | the seat no longer exposes killed/kill/on — the double must **not** re-add them |

The double never auto-resolves done (in the real seat that depends on the OS) —
each test calls settle()/fail() when it wants.

> **A double behaviour is a contract change, as much as a new mode.** The §7.1
> incident happened *exactly* because an old double ignored the AbortSignal.
> Every normalized behaviour above is locked by child-double.contract.test.ts and
> cross-checked by a real-ps e2e (test/e2e/tree-kill-real.test.ts).

### 5.5 Doubles and contract — the rule that binds the whole chapter

**Every double is a model of an external contract. A new mode, a new behaviour,
or a new shape is a contract change: it is reviewed as one.** The doubles in §5
(fake-cloudflared with 9 modes, telegram-server with the envelope, the child
double with its ENOENT/abort contract) are the active contract tests of the
runtime seams the plugin cannot touch in CI.
## 6. Contract tests

test/contract/dsh-types.test.ts compares the .d.ts extracted from the
**pinned** npm tarball (read from node_modules/, resolved by the lockfile)
against the local mirror in types/**, and asserts the exact symbols the plugin
depends on. Diverged → red. That is how an upstream breaking change becomes a
red PR instead of a plugin that loads without its gate (04-TESTES.md:1249-1277
§5.8; the whole file is verified in …/test/contract/dsh-types.test.ts).

What to assert — **existence and negative** (CONTRACT-001..009):

| id | assertion |
| --- | --- |
| CONTRACT-001 | @deepseek-ai/dsh-host-webserver declares interface Context { webServer: WebServer } and export declare class WebServer extends Service |
| CONTRACT-002 | WebServer exposes register, registerFallback, registerUpgrade — registerUpgrade is a **security blocker** (it is how you guard the WebSocket) |
| CONTRACT-003 | negative: the legacy names that never existed (WebUpgradeHandler, WebHandler, RouteKind) stay absent; the **supported range** (0.1.0-rc.7..0.1.1-rc.1) is locked on the *installed* version, and the whole lockfile does not drag the dead 0.0.1-rc.* line via a peer resolve |
| CONTRACT-004 | negative + network: @deepseek-ai/dsh-host-subprocess is **404** on the registry (the real package is @deepseek-ai/dsh-subprocess + -local); if the network is down the case **skips** with a written reason, never passes on false silence |
| CONTRACT-005 | ctx.subprocess: SubprocessRuntime; export declare abstract class SubprocessRuntime |
| CONTRACT-006 | spawn(spec: SubprocessSpawnSpec): SubprocessHandle with argv/cwd/stdio/graceMs compulsory and signal? optional; the three-arg spawn(cmd, args, opts) stays **refuted**; the handle exposes **no** EventEmitter/kill/killed surface |
| CONTRACT-007 | WebRoute / WebUpgradeRoute keep their exact shape; host stays the literal '127.0.0.1' | '0.0.0.0' (so unsafe-bind checking stays exhaustive in the compiler) |
| CONTRACT-008 | network: @deepseek-ai/dsh-host-frontend-static is **200**, @deepseek-ai/dsh-host-frontend is **404**; @deepseek-ai/dsh latest stays in the supported lines |
| CONTRACT-009 | pinned @deepseek-ai/cordis exports intercept, waterfall, parallel, effect, Service, and the Fiber lifecycle with **LIFO disposers** |

Rules that keep the negative assertions honest (verified in the contract test):

- **Negatives on names that *change* between lines are a taint on the fix.**
  The only safe negatives are ( a ) symbols with *zero occurrences in every
  published version* (WebUpgradeHandler, WebHandler, RouteKind, Disposer), and
  ( b ) packages that 404 in every version (@deepseek-ai/dsh-host-subprocess,
  @deepseek-ai/dsh-host-frontend).
- **Exact versions, not ranges.** A green contract against >= proves nothing;
  pin version literally and assert the *installed* one equals the pin, and that
  devDependencies has no ^ or ~ (CONTRACT-003 + assertPinned).
- **pnpm types:fetch --check** re-downloads the tarball and byte-diffs the
  mirror — including packages the plugin does not install (e.g.
  dsh-subprocess-local, which needs native node-pty). Run it in the nightly and
  in the contract job before a pin change.
- A **network 404 must not be inferred from absence of a response**: map "no
  HTTP response" to null, skip with the reason written, never treat it as
  "package absent".

## 7. Adversarial suite — 137 named tests

test/security/**, runs on **every push**, **blocks merge**. It is not
"coverage"; it is a closed list of attacks with an expected outcome. Removing a
case requires a written PR justification (04-TESTES.md:1306-1313 §6).

Why it has this shape: the upstream #853 discussion is a public **unauthenticated
RCE** in the web-UI control plane (verified on 0.1.0-rc.6), and #1769 documents
escaping the bwrap workspace-write sandbox. Both were open when this was
written, so **the DSH sandbox is not a security boundary** during this work
(04-TESTES.md:1310-1313).

Named vectors (§6 of 04-TESTES; verified in the per-file tests):

| vector | file | what it tries |
| --- | --- | --- |
| path-bypass | test/security/path-bypass.test.ts | route / canonicalization escape — ADV-001..020 |
| header-forgery | test/security/header-forgery.test.ts | forged identity/headers — ADV-021..028 |
| websocket-origin (CWE-1385) | test/security/websocket-origin.test.ts | cross-site WebSocket hijack — ADV-040..049 |
| secret-leak-canary | test/security/secret-leak-canary.test.ts | secret exfil by value — ADV-050..059 |
| ratelimit-oracle | test/security/ratelimit-oracle.test.ts | a block/ban must not leak an oracle |
| nist-ceiling | test/security/nist-ceiling.test.ts | the NIST 100-failure ceiling and local recovery |
| timing-constante | test/security/timing-constante.test.ts | statistical proof of constant-time compare |
| desafio-401 | test/security/desafio-401.test.ts | the gate's 401 is byte-identical to the panel's |

**Two tests per negation.** Every denial path has ( a ) the test that it
denies and ( b ) the test that it **keeps denying when the deciding mechanism
disappears** — listener removed, empty config, absent service, exception
mid-evaluation. The canonical model is the http/auth-check fail-closed cascade
(test/unit/index.test.ts:944 in the pre-dissolution suite).

**Raw socket, not fetch.** node:http.request rewrites //api/x to /api/x and
fetch normalizes the path before sending; a raw socket is the only client that
leaves the request-target intact, exercising the server parser. The attacker
writes the request line by hand (verified in …/test/security/path-bypass.test.ts):

```ts
function rawRequest(requestLine: string, host = '127.0.0.1'): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(requestLine + '\\r\\nHost: ' + host + '\\r\\nConnection: close\\r\\n\\r\\n')
    })
    const parts: Buffer[] = []
    socket.on('data', (d: Buffer) => void parts.push(d))
    socket.on('error', reject)
    socket.on('end', () => resolve(Buffer.concat(parts).toString('latin1')))
  })
}
// then, for each evasive request-target:
await expectRefused('GET //api/x HTTP/1.1', 'ADV-003')
```

The expected outcome is uniformly 401/403/404, **never pass-through** (the 200
of the delegate), and the delegate must never be reached. The closed table
includes ./ and .. traversal, percent-encoding (single, double, triple), NUL
byte, absolute-form, query/fragment, Windows trailing dot/space, path
parameters, and Content-Length + Transfer-Encoding smuggling — the last one
asserted honestly that **Node rejects it** (400) and it is not your layer.

**Fuzz with a fixed seed (ADV-020: 5000 paths).** Deterministic and reproducible:

```ts
let seed = 0x5eed_1234
const next = (): number => (seed = (seed * 1_664_525 + 1_013_904_223) >>> 0)
for (let i = 0; i < 5000; i += 1) {
  const len = (next() % 64) + 1
  let target = '/';
  for (let j = 0; j < len; j += 1) target += String.fromCharCode(next() % 256)
  const canonical = canonicalRequestPath(target)
  // invariant: never throws; no surviving '..' segment; no '//'
}
```

Honesty residual, declared in the test: % and the NUL can survive a *malformed*
sequence and that is fail-closed (a canonical path is a comparison key, not a
served path). What is absolutely forbidden is a survivor that contains .., %,
or NUL **as a traversal**, or // (04-TESTES.md:1369-1379, the declared residual).
## 8. Mutation testing

### 8.1 The incident that justifies it (04-TESTES.md:1433-1471 §7.1)

1. The supervisor disposer followed the docs' canonical example:
   if (child.pid && !child.killed) process.kill(-child.pid, 'SIGKILL').
2. The old ChildProcess double **ignored options.signal** — abort() did
   nothing, killed stayed false.
3. With killed===false the guard was true in tests, the mock recorded the
   call, **eight tests stayed green** — suite 49/49.
4. On real Node, abort() sets killed=true synchronously *inside* abort(), so
   the guard was **false in production** and the tree-kill **never ran**.
5. Real measurement:

```
BEFORE dispose()  child 1326740 (pgid 1326740), grandchild 1326741
AFTER  dispose()  child DEAD,  grandchild 1326741 ppid=1830   ← ORPHAN
```

The bug was on a **100 % covered** line exercised by 8 green tests. Neither
line nor branch coverage, nor human review, caught it. What catches it:

- **Mutation**: deleting the whole process.kill(-pid, 'SIGKILL') broke no
  test, because the mock only checked the mock was called. A surviving mutant
  would have flagged it instantly.
- **e2e with a real process** (test/e2e/tree-kill-real.test.ts): check with ps,
  not mock calls.
- **The double's contract test** (child-double.contract.test.ts): asserts
  abort() sets killed=true synchronously, AbortError only surfaces if kill()
  returned true, err.cause is the reason, ENOENT emits error + close without
  exit, and an already-aborted signal defers a kill to nextTick.

**Permanent rule:** every invariant that depends on runtime behaviour has an
e2e with the runtime. *Mocks prove wiring; only the OS proves death.*

### 8.2 Stryker specifics

- Stryker has **no native runner for node:test** (feature request **#5421**
  open, no implementation). The documented path is the **tap-runner**, which
  has covered the built-in node test runner as a TAP producer since v7
  (verified in …/docs/mutantes.md — spike verdict, measured with
  @stryker-mutator/core@10.0.0 + @stryker-mutator/tap-runner@10.0.0 on
  Node 24.15).
- Config: coverageAnalysis: 'all' (**not** perTest — the tap-runner sees each
  *file* as one test unit and perTest reports false no-cov),
  thresholds: { high: 80, low: 60, break: null }, incremental for CI
  (verified in …/stryker.config.mjs).

### 8.3 Acceptance is the manual checklist, not the score

**break: null and the mutation job does not block the PR.** The acceptance
criterion is a **closed 50-mutant checklist**, run by hand with a fixed ritual
(verified in …/docs/mutantes.md):
1. apply the mutation; 2. run the named suite; 3. **require** a failure;
4. **revert — by copy, never git checkout**.

A survivor is a **named test hole**, not a metric. The final signed state of the
mobile case was **48/50 killed by directed test, 2/50 with a written
defense-in-depth justification** (M-37 and M-44: the single mutation is
observable only when *all* layered defenses are removed — the exact property
that defense-in-depth demands, and the tool score is not acceptance). The
closed 50 list maps each mutation to the test that must kill it (M-01 removed
pid-guard → tree-kill.test; M-02 reintroduced && !child.killed → an E2E; M-06
timingSafeEqual→=== → AUTH-041; M-19 removed the upgrade gate → ADV-040; …).
The checklist is **frozen at 50** and only grows in the next version with the
same closed-list ritual.

## 9. Coverage — goals and non-goals

### 9.1 Goals (global and security floors)

(04-TESTES.md:1812-1832 §11.1; verified in the case's stryker/coverage setup):

| scope | lines | branches | functions | why |
| --- | --- | --- | --- | --- |
| src/http/**, src/control/** | **95 %** | **90 %** | 100 % | security + state decision |
| src/secret/**, src/session/**, src/ratelimit/** | **95 %** | **90 %** | 100 % | idem |
| worker/auth/** | **95 %** | **90 %** | 100 % | the allowlist is a security decision in a separate process |
| src/state/** | 95 % | 90 % | 100 % | sole writer of state.json; an uncovered branch is corrupted state |
| src/proc/**, src/tunnel/** | 90 % | 85 % | 95 % | some paths are OS-bound, covered by e2e (not in the unit report) |
| project (CI gate, pnpm test:cov) | **90 %** | **85 %** | **95 %** | library reference; rises by ratchet, never falls |

The **security decision modules** (src/http, src/control, src/secret,
src/session, src/ratelimit, worker/auth, src/state) get **95/90 with a ratchet**
— not the looser global ≥90/≥85. The ratchet compares against the committed
value and fails when it falls, even above the minimum; raising a floor is a PR
decision with a note. A branch not covered in a security module is a test
bypass.

### 9.2 Why not 100 %

- 100 % pushes you into getter tests and /* istanbul ignore */. The marginal
  cost of the last 5 % is greater than its value (04-TESTES.md:1833 §11.2).
- src/index.ts is the composition root — wiring; unit-testing it tests the
  double.
- test/support/** doubles are excluded, except the child-double contract test,
  which tests the double *by design*.
- win32 branches have no Windows runner in the gate; they are covered by
  **injecting platform**, and the real coverage stays a declared gap.
- e2e runs in a separate process and is **not** folded into the unit coverage
  report — mixing them produces a pretty number with no meaning.

### 9.3 "Coverage does not prove quality"

**§7.1 case**: src/proc/tree-kill.ts (the claimed file family) at 100 % lines,
8 green unit tests, dead code in production. **Coverage would never have caught
it.** What does: mutation (§8), e2e with ps (§5.4), and the double's contract.
**Mocks prove wiring; only the OS proves death.**

## 10. Determinism

Everything that is non-deterministic is a parameter (04-TESTES.md:1581-1670 §8):

| dependency | injection |
| --- | --- |
| clock | now()/scheduler (fake clock + fake scheduler with advance(), pending()) |
| RNG | seededRandom(seed) — LCG, deterministic, seed printed |
| spawn | via the ctx.subprocess double (§5.4) |
| kill / process.kill | a recorded kill(pid, signal) fn in the deps |
| HTTP transport / Bot API | telegram-server fake + real node:http on port 0 |
| platform | 'linux' | 'win32' injected for branch reach |

Hard rules:

- **Zero retry in CI.** An intermittent test is a bug: it goes to
  test/quarantine/ with an open issue, never to retry: 3 (04-TESTES.md:1658 §8.4).
- **Zero sleep.** Substitute waitFor(predicate, { deadline, poll }) — the
  injected clock in unit, a short real poll (25 ms) in e2e. A sleep inside a
  60 min TTL test is physically impossible.
- **listen(0) always** — read server.address().port. Zero fixed ports anywhere
  in the tests (CI grep).
- **Zero Math.random / Date.now() / real setTimeout in test/unit/*** and
  **test/integration/***; a lint rule (or CI grep) forbids the identifiers.
  mock.timers is available but **not the default** — it mocks globals and hides
  that the code calls a global instead of the injected seam, exactly the lie
  that caused §7.1.
- **clock.pending() in every afterEach**: a non-zero balance fails with
  "leaked timer".
- **--test-concurrency=1 for e2e** (processes and ps do not mix well in
  parallel); parallel is free in unit.
- **Wait for 'close', never 'exit'** — ENOENT emits error + close, no exit.
- **Terminal state**: processes are registered in a ProcessRegistry; an after()
  kills any survivor group and fails the test. Leaking a process in a test is a
  bug.
- **TEST_TIMEOUT_FACTOR** (default 1, CI 3) multiplies only e2e timeouts, never
  an assertion.
- **A _placeholder.test.ts in every test directory** (§2) so an empty glob
  cannot silently green or red the gate (empty glob exits 1).
- Property-based tests **print their seed** for exact reproduction.
## 11. e2e / live / manual boundaries (decision D10)

(04-TESTES.md:86-115 §2, §9, decision D10):

| boundary | runs in | network | gate status |
| --- | --- | --- | --- |
| test/e2e/** offline | every push/PR (linux) | none | **blocks PR** |
| test/live/** real quick tunnel | workflow_dispatch only | **real** | never a gate |
| test/live/** opt-in | requires DSH_GUARD_LIVE_TESTS=1 | real | never |
| manual M1..M7 | human, pre-release | real | blocks release |

The e2e publishes a real tunnel on the internet; in CI that is acceptable under
human supervision and unacceptable in a PR — the live suite is
workflow_dispatch, never triggered by pull_request, and it **never** runs in
the gate (it would republish the ~40 s exposure incident per commit).

The seven manual checklists (each a human-run pre-release gate,
04-TESTES.md:1672-1784 §9):

- **M1** — Onboarding the Telegram bot from zero (~10 min), including "a person
  who never saw the project can do steps 1→11 without asking".
- **M2** — First tunnel (~8 min), including coding from a phone on 4G.
- **M3** — Turning off from both surfaces (~5 min).
- **M4** — Real failures (~7 min).
- **M5** — Security in practice (~7 min).
- **M6** — Streaming and downlink channel (~5 min).
- **M7** — Lifecycle (~3 min).

## 12. CI gate

Local gate on every wave snapshot: **pnpm lint && pnpm typecheck && pnpm build
&& pnpm test** — lint first because it is cheapest (04-TESTES.md:71 §3.1).
PR and push gate (verified in …/.github/workflows/ci.yml):

| job | when | network | required? |
| --- | --- | --- | --- |
| lint, typecheck, build | push/PR | no | ✅ |
| test (ubuntu×24, ubuntu×26, macos×24) | push/PR | no | ✅ |
| test-contract | push/PR + nightly | **yes** | ✅ |
| test-security | push/PR | no | ✅ always |
| test-e2e | push/PR | no | ✅ |
| coverage (ratchet) | push/PR | no | ✅ |
| secrets-scan | push/PR | no | ✅ |
| mutation | nightly | no | ❌ (report, break off) |
| live | workflow_dispatch | yes (real tunnel) | ❌ never |

Top-level permissions: {} with minimal per-job grants, actions pinned by SHA,
no continue-on-error. **The secret canary is by value, not by name** (§7): a
git-grep for secret|password is a heuristic over identifier names — it misses
cred, pw, this.value, and interpolation; the canary follows the *value*, so it
catches the leak no matter what the variable is called (04-TESTES.md:1392
§6.5).

After the e2e, the CI validates **no process survived**:
```bash
'! pgrep -f fake-cloudflared'
```
A leaked process in a test is a bug.

## 13. Honesty — what is refuted and what is not confirmed

This document follows the skill's honesty filter. It **never teaches as truth**
anything refuted by real measurement or unconfirmed; if it must mention a
refuted claim it says *refuted by real measurement* and points at the correct
one. The direct mapping for this chapter:

- **Zero Trust free "50 users"** — refuted/unconfirmed, never cited as a fact.
- **jcode benchmarks** (RAM/PSS, "245× faster") — unconfirmed, never used in
  tests, docs, or marketing.
- **The pi2dsh package** — unconfirmed/refuted, never a dependency.
- **"Quick tunnel does not support SSE"** — refuted: a POST with
  text/event-stream streams for real; GET is buffered (cloudflared issue
  #1449). **This stack uses a dedicated WebSocket downlink, not SSE**
  (src/index.ts:935 in the mobile case; upstream series note
  .agents/notes/implemented/architecture/2026-08-04-websocket-downlink-carrier.md).
- **→ the WebSocket is exactly why registerUpgrade and the websocket-origin
  (CWE-1385) test are security blockers.**
- **"The bot token bypasses the allowlist"** — refuted as a generalization;
  the real vector is confused-deputy, and the correct test is telegram-abuse,
  not a token-vs-allowlist tie.
- **drop_pending_updates is a getUpdates parameter** — corrected: it belongs
  to setWebhook/deleteWebhook; in long polling it is a bot.start() option of
  grammY. The test asserts where it actually exists and fails if someone puts it
  in getUpdates.
- **ASVS 5.0 §6.5.2 authorizes SHA-256 instead of Argon2 for 128-bit tokens**
  — refuted attribution: §6.5.2 is about *lookup secrets* (MFA backup codes),
  not tokens in general, and ASVS is silent on reference-token storage. Using
  fast-hash + constant-time compare for a machine-generated ≥128-bit secret is
  a **documented engineering decision** (2^128 kills offline attacks; Argon2
  opens a memory-DoS), not a normative requirement. If a *human ever picks*
  the secret, Argon2id becomes mandatory.
- **Quick-tunnel URLs indexed by search engines** — unconfirmed; the URL is
  treated as "not a secret" regardless.
- **child.kill() is never enough with an intermediate shell** — refuted: it
  depends on the shell (bash does exec, dash forks); the e2e freezes both
  behaviours.
- **A Secure cookie does not work over http://127.0.0.1** — [UNVERIFIED] as a
  blanket rule; it is a test-sonar decision frozen by a written outcome
  (accept loopback as a secure origin, use a non-__Host- name in loopback, or
  refuse a session off the tunnel).
- **A "compatibility field" in package.json** — refuted: the real activation
  lives in dsh.bundle.patch (a patch file reference like cordis.patch.yml);
  bundle:{} as an object does nothing.
- **"The plugin has N runtime dependencies on the host" vs "zero runtime
  dependencies"** — both phrased absolutely are wrong. The realistic claim:
  a host-side plugin can have **zero runtime *test* dependencies**
  (node:test), and the runtime dependency story is the documented
  @deepseek-ai/dsh-* peer set, not a magic number.

## 14. Gaps and [UNVERIFIED] items

Nothing below is a silent assumption; each has a state and a way to close it.

| # | item | state | how to close |
| --- | --- | --- | --- |
| 1 | Stryker supports node:test as a runner | [UNVERIFIED] natively — #5421 open; the tap-runner path is validated and measured | spike; outcome already recorded as runnable |
| 2 | grammY apiRoot override for a local Bot API | validated against the fake server | keep the fake; it is the source of truth |
| 3 | node:http behaviour with a duplicated Authorization header | [UNVERIFIED] — written first as a probe that prints req.headers.authorization and fails if it differs | the probe's conclusion becomes a code comment / explicit reject |
| 4 | native type stripping on the exact CI Node version | [UNVERIFIED] — the only matrix reason is engines.node >=24 | spike; fallback is compile-then-test over dist/ |
| 5 | client IP relaying by cloudflared, and whether the value is attacker-controlled | [UNVERIFIED] until the spike | default trustEdgeHeaders:false; nothing else assumed |
| 6 | InlineKeyboardButton.style (success/danger/primary) | [UNVERIFIED] — entered unverified against the Bot API reference | keep the keyboard distinct by text; the test is skip until confirmed |
| 7 | real win32 coverage | known gap | covered by injected platform only; e2e on Windows out of scope, documented |
| 8 | behaviour under real load (200 in-flight requests through the tunnel) | not locally testable | manual run M6 step 5 |
| 9 | __Host-/Secure cookie on http://127.0.0.1:3080 | [UNVERIFIED] — a test born as a probe | decision frozen in the prep commit, then the test becomes an assertion |
| 10 | scope drift from the 50-mutant list for new controls (TTL, probe, restricted mode, pairing, magic link) | resolved as named tests; the corresponding mutants enter the v0.2 list | reopen the closed list with the same ritual |

## 15. Bibliography / verified sources

Official and measured sources behind this document:

- **DSH API surface** — upstream AGENTS.md and docs/subsystems/web-server.md
  (route kinds, registerFallback, registerUpgrade, ctx.intercept,
  ctx.waterfall, LIFO Fiber disposers); URLs cited in the four reference
  materials under /home/ondokai/Documents/deepseek-harness/.
- **The four reference materials** (PT) under
  /home/ondokai/Documents/deepseek-harness/.
- **The real mobile case** — read-only here, read-write only in the named
  worktree; the code shown is inspired by, not copied from, the case:
  test/support/{clock,child-double,ctx-double,telegram-server,state-dir},
  test/bin/fake-cloudflared.mjs, test/contract/dsh-types.test.ts,
  test/security/**, docs/TESTING.md, docs/mutantes.md,
  docs/plano/04-TESTES.md, .github/workflows/ci.yml.
- **Node.js test runner** — node:test stable since Node 20, snapshot stable
  since 23.4, coverage thresholds by CLI: <https://nodejs.org/api/test.html>.
- **Node.js child_process** (spawn/exit/close/error, signal, groups):
  <https://nodejs.org/api/child_process.html>.
- **Stryker** (thresholds, coverageAnalysis, incremental) and the tap-runner
  (node:test as a TAP producer): <https://github.com/stryker-mutator/stryker-js>;
  issue **#5421** (no native node:test runner) is why the tap-runner path is used.
- **Telegram Bot API** (envelope, errors, methods):
  <https://core.telegram.org/bots/api>.
- **Cloudflare quick tunnels / TryCloudflare**:
  <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/>;
  SSE buffering on GET: cloudflare/cloudflared
  <https://github.com/cloudflare/cloudflared/issues/1449>.
- **DSH security discussions** (all verified, HTTP 200): **#853**
  (unauthenticated RCE in the web-UI control plane, 0.1.0-rc.6), **#1769**
  (bwrap workspace-write escape), **#3144** (EPERM rewrites invisible to the
  model), **#441** (non-atomic cordis.yml rewrite):
  <https://github.com/deepseek-ai/deepseek-harness/discussions>.
- **libuv** — reaps only direct children:
  <https://github.com/libuv/libuv/issues/4179>.

## Anti-patterns to avoid

| anti-pattern | why |
| --- | --- |
| Unit-testing src/index.ts | you test the double, not the wiring |
| retry: 3 on a flaky test | hides a concurrency bug; quarantine it |
| await sleep(100) to wait for a process | flake machine; use waitFor + injected clock |
| A double that ignores AbortSignal | fabricates a state that never exists in production → §7.1 |
| child.killed as the proof of death | mock-only reasoning; check ps |
| A contract test pinned with >= | green today, broken tomorrow, no red PR in between |
| A negative assertion on a name that changed lines | turns into a taint on the fix |
| Network 404 inferred from "no response" | absence of network is not absence of a package |
| Using fetch for adversarial path cases | it normalizes the path the attacker never normalizes; use a raw socket |
| Mutation score as the acceptance criterion | encourages tests written to kill mutants, not describe behaviour; use the closed manual checklist |
| Enforcing 100 % global coverage | buys getter tests and istanbul-ignore at a cost above its value |
| A new double mode without a contract review | a contract change should be reviewed as one |

## Checklist (post-review gate)

- [ ] Every source-owning module has its test/unit/** mirror (D1).
- [ ] node:test runner, no Vitest in host-side suites; a _placeholder.test.ts
      green in every test directory.
- [ ] Doubles: fake-cloudflared (9 modes) + telegram-server (envelope) +
      clock/ctx/child-double with its own contract test.
- [ ] Contract test: existence + negative, exact pins, no ^/~,
      pnpm types:fetch --check in the job.
- [ ] Adversarial suite: all named vectors present; each denial test has a
      "still denies when the mechanism disappears" twin; raw socket + fuzz
      (ADV-020) with a printed seed.
- [ ] Mutation: closed 50-mutant checklist re-run through apply→run→require
      failure→revert-by-copy; 2/50 allowed only with a written defense-in-depth
      reason; Stryker coverageAnalysis:'all', break:null, nightly, not a gate.
- [ ] Coverage floors (90/85/95 global; 95/90 with ratchet on the security
      modules); none of the non-goals pursued.
- [ ] Determinism: zero retry/sleep/Math.random; listen(0); injected
      clock/RNG/spawn/kill/platform; --test-concurrency=1 e2e; clock.pending()
      in afterEach; TEST_TIMEOUT_FACTOR.
- [ ] e2e offline blocks PR; live is opt-in, never a gate; M1..M7 manual.
- [ ] CI gate: lint && typecheck && build && test; contract/security/e2e
      required; secret canary by **value**; pgrep empty after e2e.
- [ ] Honesty filter applied: no refuted/unconfirmed claim taught as truth;
      gaps table has state + how-to-close for every item.

