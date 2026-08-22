# DSH Plugin Security

> **Scope.** How to build, review and accept a DeepSeek Harness (DSH) Cordis
> plugin that treats its own credential as the *only* trust boundary, treats the
> DSH sandbox as damage reduction (never a boundary), and keeps secrets, HTTP
> auth, rate limiting, authorization, process hygiene and auditing honest.
>
> **Audience.** Plugin authors who expose a DSH web surface (via
> `ctx.webServer`) and/or spawn subprocesses (`ctx.subprocess`), and reviewers
> who run the acceptance checklist in [section 15](#15-acceptance-checklist).
>
> **Basis.** Everything here is grounded in (a) the official GitHub Discussions
> that document the real DSH attack surface, (b) the shipped `.d.ts` typings of
> the published `@deepseek-ai/*` packages, and (c) a real, shipped plugin
> (the guarded-bot orchestrator in `deepseek-harness-mobile`) that implements
> every control below. Every claim carries a source; uncertain claims are marked
> `[UNVERIFIED]`.

---

## Table of contents

1. [Threat model](#1-threat-model)
2. [The layers, in order](#2-the-layers-in-order)
3. [The sandbox is not a boundary](#3-the-sandbox-is-not-a-boundary)
4. [Secrets: entropy, storage and comparison](#4-secrets-entropy-storage-and-comparison)
5. [The secret never travels in the chat](#5-the-secret-never-travels-in-the-chat)
6. [Rate limiting: NIST 800-63B-4](#6-rate-limiting-nist-sp-800-63b-4)
7. [Allowlist: two axes, default deny](#7-allowlist-two-axes-default-deny)
8. [Pairing and the deputy-confusion nonce](#8-pairing-and-the-deputy-confusion-nonce)
9. [HTTP auth: 401 vs 403, Host, CSRF, cookies](#9-http-auth-401-vs-403-host-csrf-cookies)
10. [The tool pipeline and the elevation veto](#10-the-tool-pipeline-and-the-elevation-veto)
11. [Input validation](#11-input-validation)
12. [Processes and environment](#12-processes-and-environment)
13. [Append-only auditing](#13-append-only-auditing)
14. [The P-01..P-13 phrase table](#14-the-p-01p-13-phrase-table)
15. [Acceptance checklist](#15-acceptance-checklist)
16. [Anti-patterns to avoid](#16-anti-patterns-to-avoid)
17. [Verified sources](#17-verified-sources)

---

## 1. Threat model

### 1.1 The asset

A DSH plugin is, by construction, **the access control of an agent that executes
code on the operator's machine**. Whoever crosses the barrier gains what the
agent has: shell, `~/.ssh`, `.env` files, API keys and the source tree that is
open. Treat the protected surface as the equivalent of a *local account*, not a
web page

(*verified in deepseek-harness-mobile/docs/THREAT-MODEL.md:13*).

### 1.2 The attackers

| Attacker | Capability that matters | Control that stops them |
| --- | --- | --- |
| **Anonymous internet** (through a tunnel or an open bind) | Reaches `/api` RPC before any credential | Loopback bind, origin allowlist, credential gate, rate limit |
| **Other local processes / extensions / browsers** on the same machine | Open `ws://127.0.0.1:PORT/...` without same-origin restrictions | Origin allowlist on WebSocket handshake (`CWE-1385`), credential gate |
| **DNS rebinding** | A hostile page resolves to 127.0.0.1 and issues same-origin-looking fetches | `Host` header allowlist ([§2](#2-the-layers-in-order)) |
| **Credential guessing** | Repeated offline/online guessing | Rate limit → restricted mode ([§6](#6-rate-limiting-nist-sp-800-63b-4)) |
| **Compromised worker subprocess** | Reads the host environment to pivot local → remote | Environment allowlist, token via env not argv ([§12](#12-processes-and-environment)) |

### 1.3 The controls we never claim to provide

- **Prompt injection is an ACCEPTED risk.** Whoever holds a valid credential
  drives the agent. The plugin controls **who gets in**, not **what is asked**
  after they are in (*verified in deepseek-harness-mobile/docs/THREAT-MODEL.md:106*).
  The residual prompt-injection exposure of agentic pipelines is documented in
  the research literature (e.g. arXiv 2601.17548 reports attack success rates
  ≥ 85% on sampled workloads) `[UNVERIFIED]` — do not claim the plugin changes
  that number.
- **The TLS ends at the Cloudflare edge** on a `trycloudflare.com` quick tunnel:
  plaintext goes through a third party; this is **not end-to-end** and never was
  (*verified in deepseek-harness-mobile/docs/THREAT-MODEL.md:66-70*).
- **The tunnel URL is an address, not a credential.** Hostnames are discoverable
  by public sampling; the barrier is authentication, not the obscurity of the
  name (*verified in deepseek-harness-mobile/docs/THREAT-MODEL.md:80-83*).
- **A quick tunnel has no SLA.** It is *"intended for testing and development
  only"* and Cloudflare *"don't guarantee any SLA or uptime"* (Cloudflare
  TryCloudflare docs, cited in deepseek-harness-mobile/docs/THREAT-MODEL.md:90-92).
- **Cloudflare Access cannot front a quick tunnel.** Quick tunnels have no own
  domain/`zone_id`, so all auth must live inside the app (*verified in
  deepseek-harness-mobile/docs/THREAT-MODEL.md:86-88*).
- **`X-Forwarded-*` is forgeable from the outside.** Without a trusted edge, a
  client can send any `X-Forwarded-For`/`X-Forwarded-Proto`; the plugin starts
  from `trustEdgeHeaders: false` ([§12](#12-processes-and-environment)) (*verified in
  deepseek-harness-mobile/docs/THREAT-MODEL.md:111-114*).

### 1.4 What is out of scope

Upstream DSH vulnerabilities, `cloudflared`/Cloudflare-network
vulnerabilities, Telegram Bot API vulnerabilities, and third-party dependencies
with no exploitation path *through* this plugin (*verified in
deepseek-harness-mobile/docs/THREAT-MODEL.md:128-131*).

---

## 2. The layers, in order

The **order of the checks is a contract**. Inverting it is a security regression
(*verified in deepseek-harness-mobile/src/http/gate.ts:15-16* and
*deepseek-harness-mobile/docs/THREAT-MODEL.md:31-34*):

**origin → Host → credential/session**

| Layer | Question it answers | Blocks | Refused with |
| --- | --- | --- | --- |
| **L2 — loopback bind** | Where does the server listen? | the socket is never widened (`0.0.0.0`/`::` refused at load) | load-time error |
| **L2.5 — `Host` validation** | By what *name* was the resource requested? | DNS rebinding and unknown-host requests | 403 |
| **L2.6 — loopback-only routes** | Did the request arrive via a loopback *name*? | local-only channels leaking through a tunnel | **404** (see below) |
| **L3 — connection origin (`trustedRemotes`)** | Who is on the other end of the socket? (outside list → 403 *before* any credential) | untrusted origin per socket | 403 |
| **L3 — credential/session gate** | Who are you? (Basic Auth or session cookie) | wrong/absent credential | **401** + `WWW-Authenticate` |
| **L5 — rate limit / restricted mode** | How many failures in the window? | brute force | same 401 (no `429`, no oracle) |
| **L6 — Telegram allowlist** | Is this `from.id` *and* `chat.id` allowlisted? | outsiders drive the bot | silent counted deny |
| **L7 — elevation veto** | Did an authed call ask to escalate permissions? | `danger-full-access` (defense-in-depth) | veto event |
| **L8 — kill switch / TTL / auditing** | Is exposure still wanted? Can the decision be replayed later? | forgotten tunnels, silent forensic gaps | tunnel teardown, audit lines |

Layer mapping source: *deepseek-harness-mobile/docs/THREAT-MODEL.md:37-47*;
the L2/L2.5/L3 check order is in *deepseek-harness-mobile/src/http/gate.ts:11-46*.

### 2.1 The 403-before-401 rule

- **403 means** “repeating the credential will NOT help”: the request never
  reaches authentication. Returning `401` here would hand the attacker an
  oracle to guess credentials from an origin that will never be accepted
  (*verified in deepseek-harness-mobile/src/http/gate.ts:21-24*).
- **401 means** “identify yourself” and comes with the `WWW-Authenticate`
  challenge (*verified in deepseek-harness-mobile/src/http/gate.ts:26*).
- **The two 403s (origin and Host) are byte-identical** on purpose, so an
  attacker cannot learn *which* layer stopped them, and therefore which to
  attack next (*verified in deepseek-harness-mobile/src/http/gate.ts:33-36*, and
  *deepseek-harness-mobile/src/http/gate.ts:36-39*).
- **A valid session does NOT short-circuit the perimeter.** Session is checked
  at L3, after L2 and L2.5; otherwise a cookie bearer from a refused origin
  would get 401 instead of 403 and the 403-before-401 order would silently rot
  (*verified in deepseek-harness-mobile/src/http/gate.ts:28-31*).

### 2.2 What each layer does NOT catch (be explicit)

- **L2 / L2.5 do not separate local from remote under a tunnel.** Under
  `cloudflared`, a request from the internet passes L2 (the socket is opened by
  `cloudflared` on `127.0.0.1`, which is `trustedRemotes`) **and** L2.5 (the
  tunnel origin is deliberately added to the `Host` allowlist while `READY`).
  Those two layers defend against *other local processes* and *DNS rebinding*,
  not against the internet the tunnel lets in on purpose (*verified in
  deepseek-harness-mobile/src/http/gate.ts:86-116* and
  *deepseek-harness-mobile/src/http/host-header.ts:153-164*). A route that must
  be local-only needs its own question — L2.6.
- **L2.6 refuses with 404, never 403.** A 403 would announce both that the route
  exists *and* that the request came from the wrong place. The 404 is the *same*
  function used for an invalid one-time token, so the bytes cannot diverge
  (*verified in deepseek-harness-mobile/src/http/gate.ts:88-108*).
- **The request body is never read on the decision path.** The dangerous command
  travels in the `POST /api/commands/execute` body; reading it would add
  buffering and a DoS surface exactly where there can be none, and would consume
  the stream so the downstream host could not read it either
  (*verified in deepseek-harness-mobile/src/http/gate.ts:41-54*).
- **The kill switch only limits, it does not remove the category of risk.**
  TTL, restricted mode and `/emergencia` shrink and authenticate the exposure;
  they do not make it unreachable by construction
  (*verified in deepseek-harness-mobile/docs/THREAT-MODEL.md:153-159*).

### 2.3 401 is the only auth failure response

A `429` with `Retry-After` tells the attacker two things they could not measure
otherwise: that they were detected, and the window. Every auth failure —
`no session`, `expired session`, `wrong secret`, `banned identity` — answers the
**same** 401 with the **same** body and headers (*verified in
deepseek-harness-mobile/src/ratelimit/policy.ts:12-22*).

---

## 3. The sandbox is not a boundary

### 3.1 The evidence

The DSH default web environment exposed **unauthenticated RPC**: with the server
listening on `0.0.0.0`, the `/api` sub-station answered unauthenticated
`commands/execute` and could inject `/permission danger-full-access`, dropping
the `workspace-write` sandbox confinement. Verified on `0.1.0-rc.6` as GitHub
Discussion **#853** (“Security: unauthenticated local/remote code execution via
the dsh web UI control plane, verified on 0.1.0-rc.6”).

Sources:
- GitHub Discussion #853 — cited in
  *deepseek-harness-mobile/docs/THREAT-MODEL.md:19-24* and in
  `Guia Definitivo e Catálogo de Plugins` (material)
  `[UNVERIFIED: line 248 renders #853 from source at l.208, but the exact wording
  is from the GitHub discussion itself, not re-verified in this session]`.

### 3.2 bwrap is escapable

The Linux sandbox is backed by **bwrap** enforcing `workspace-write`; it fixes
the target dir and pins others read-only (`MS_RDONLY`). Its known weakness: it
does not remove authoritative kernel capabilities granted to the restricted
namespace. GitHub Discussion **#1769** documents escaping `workspace-write`
via `mount -o remount,rw /` in the internal shell
(*verified in
`Guia de Contribuição e Desenvolvimento` material and cited in
deepseek-harness-mobile/docs/THREAT-MODEL.md:19-24*).

### 3.3 Denials are invisible to the model

GitHub Discussion **#3144**: when a confined program rewrites the kernel error
(EPERM becomes, e.g., SQLite's `unable to open database file`), the denial is
suppressed and the model misdiagnoses it as an overload/hardware failure
(*extracted from`Guia Definitivo e Catálogo de Plugins` / `Plugin Cordis DeepSeek
Harness.md`, citation #30*). A control whose denials are invisible is not a
control the model can reason about.

### 3.4 The boundary is the credential

- The sandbox is **damage reduction at L7**, never the trust boundary. The
  trust boundary is **the credential** (loopback bind + origin allowlist +
  credential gate).
- The plugin **does not fix** upstream #853; it makes those surfaces
  **unreachable without a credential** and keeps the bind in loopback
  (*verified in deepseek-harness-mobile/docs/THREAT-MODEL.md:26-29*).
- Design rule: a defensible DSH plugin treats its *own* gate as the place where
  “who gets in” is decided, and the host sandbox as a backstop whose failures
  (#1769, #3144) must not be the last line.

---
## 4. Secrets: entropy, storage and comparison

### 4.1 Generation — CSPRNG, ≥ 256 bits, base32

- **CSPRNG, never `Math.random`/Date.now.** ASVS 5.0 requirement 11.5.1: *“all random numbers and strings which are intended to be non-guessable must be generated using a cryptographically secure pseudo-random number generator (CSPRNG) and have at least 128 bits of entropy”* (quoted in deepseek-harness-mobile/src/secret/generate.ts:7-12).
- **256 bits — double the floor.** 32 bytes of `crypto.randomBytes` → 256 bits (*verified in deepseek-harness-mobile/src/secret/generate.ts:7-12,30*). `Math.random`, `Date.now` and `crypto.randomUUID` are **not** a credential-grade CSPRNG.
- **base32 (RFC 4648).** Alphabet `A-Z`+`2-7`, no padding for 256 bits (52 exact 5-bit chars, no `0/1/8/9` so misread pairs `0/O`, `1/l/I` vanish) (*verified in deepseek-harness-mobile/src/secret/generate.ts:13-25*).
- **One clear copy.** Generates and returns the only clear copy, wiping the raw byte buffer; the string cannot be erased, so the honest contract is “the caller does not keep it” (*verified in deepseek-harness-mobile/src/secret/generate.ts:41-51*).

### 4.2 Storage — only a sha256 digest on disk

- On disk persists **only a SHA-256 digest** of the canonical secret, file `0600` inside a `0700` dir, never the secret (*verified in deepseek-harness-mobile/docs/THREAT-MODEL.md:52-54*).
- Modes are verified on the descriptor; `O_NOFOLLOW` on open makes a symlink swap fail loudly at load (*verified in deepseek-harness-mobile/src/audit/log.ts:232-240,286-304*).

### 4.3 Comparison — `timingSafeEqual` on a FIXED-size digest

- **Compare digests, never raw secrets.** `crypto.timingSafeEqual` throws on different-length buffers, so raw comparison would leak the stored secret’s *length*. Reducing both sides to sha256 yields a fixed 32 bytes; the comparison is total and input-independent (*verified in deepseek-harness-mobile/src/secret/verify.ts:35-42*).
- No stored digest → `verifySecret` returns `false` (nobody passes), leaking no secret byte (*verified in deepseek-harness-mobile/src/secret/verify.ts:71-80*).

> **Honesty note on ASVS 5.0 §6.5.2.** The claim “ASVS 5.0 §6.5.2 authorizes a cheap hash for ≥112-bit secrets” is **refuted by real measurement** for a *primary credential*: §6.5.2 lives in V6.5 “General MULTI-FACTOR AUTHENTICATION requirements” and “lookup secret” is a MFA recovery-code term. This secret is the credential, not a second factor; the standard is **silent** here (*verified in deepseek-harness-mobile/src/secret/verify.ts:5-34*). The correct justification is first-principles: 256 bits of CSPRNG makes an offline digest impossible with or without a KDF, and a slow KDF (Argon2id at OWASP params = 19 MiB/attempt) on a tunnel-exposed login is a CPU/memory DoS amplifier. **Argon2id becomes mandatory** the day the user may choose the password (*verified in deepseek-harness-mobile/src/secret/verify.ts:17-31*).

### 4.4 Loopback bind is the first barrier — and inert under a tunnel

- Bind validated at load: `0.0.0.0`/`::` and anything outside `allowedHosts` refuses to start (*verified in deepseek-harness-mobile/src/config/bind.ts, cordis.patch.yml*).
- **`allowedHosts` = bind-address allowlist**, not a `Host`-header allowlist. Do not confuse the three axes (bind address / connection origin `trustedRemotes` / requested name `Host`) (*verified in deepseek-harness-mobile/src/http/host-header.ts:5-18*).
- **`trustedRemotes` is inert under a tunnel.** `cloudflared` connects from `127.0.0.1`, so the remote origin the gate sees is always loopback and the origin allowlist stops separating anything (*verified in deepseek-harness-mobile/src/http/host-header.ts:9-16*). Loopback bind is the local barrier; the **credential** is the internet barrier.

---

## 5. The secret never travels in the chat

### 5.1 Telegram is not the delivery channel for the persistent secret

- **Telegram cloud chat is NOT end-to-end.** Bot conversations are cloud chats, history stays on Telegram servers, **Secret Chat does not exist for bots**, and `deleteMessage` is only cosmetic (≤ 48h). Never place a persistent credential in a chat (*verified in deepseek-harness-mobile/docs/THREAT-MODEL.md:57-60*).
- **Invariant:** the password never leaves via a remote channel (bot or tunnel). Delivery is local (terminal / QR ASCII) or a single-use token printed on boot stdout (*verified in deepseek-harness-mobile/docs/THREAT-MODEL.md:55-62*).
- The persistent-secret route is **loopback-only**, refusing off-loopback with a 404 indistinguishable from a nonexistent route (*verified in deepseek-harness-mobile/docs/THREAT-MODEL.md:64-65* and src/http/gate.ts L2.6).

### 5.2 The delivery pattern: an OTT magic link

- **`mk` = one-time token, 128 bits (≥), TTL ≈ 120 s**, delivered in the **URL fragment** (`#`) so it never reaches a server by default.
- **GET is inert; only POST consumes.** A magic link is pre-fetched by Telegram’s own link preview, anti-phishing scanners, email clients and bots. If GET burned the token, the owner would get “already used” on a link they never used. GET serves static HTML + form without touching the store; POST consumes (*verified in deepseek-harness-mobile/src/panel/magic.ts:3-17*).
- **`disable_web_page_preview`** on the bot message limits preview-fetch of the fragment.
- Token is **single-use** and **expired**; both yield the *same* 401 body so a prober cannot distinguish states (*verified in deepseek-harness-mobile/src/panel/magic.ts:120-132*).
- Behind it: session **regeneration** and the *same* failure tracker / NIST ceiling as password login (separate budgets would double an attacker’s tries) (*verified in deepseek-harness-mobile/src/panel/magic.ts:99-105*).
- **The HTML+form GET is NOT click-proof.** A former claim that the CSRF token was the “click signal” was refuted: GET delivers the token to any anonymous caller, and a blind POST with it consumes the `mk`. Assume a preloaded link is burned on POST regardless of click intent (*verified in deepseek-harness-mobile/src/panel/magic.ts:19-24*).

### 5.3 Local delivery

Cross-device local delivery: **QR** (ASCII QR next to grouped text on one screen, for cameras), **OTT** single-use tokens in the URL, and terminal stdout — never a chat (*verified in deepseek-harness-mobile/src/secret/generate.ts:128-141* and docs/THREAT-MODEL.md:55-62*).

---

## 6. Rate limiting: NIST SP 800-63B-4

### 6.1 Normative source

NIST SP 800-63B-4 §3.2.2 “Rate Limiting (Throttling)” (final 2025-07-31): “the verifier SHALL limit consecutive failed authentication attempts … to no more than 100 by disabling that authenticator”, with “delays … as the subscriber account approaches its maximum allowance (e.g., 30 seconds up to an hour)”, and “when the subscriber successfully authenticates, the verifier SHOULD disregard any previous failed attempts” (*quoted in deepseek-harness-mobile/src/ratelimit/policy.ts:26-46*).

### 6.2 What the policy does

| Knob (real default) | Meaning |
| --- | --- |
| `freeFailures` = 4 | first 4 failures in the window: no delay |
| `initialDelayMs` = 1000 | 5th failure starts the delay ladder (1 s) |
| `maxDelayMs` = 30 000 | delay cap (≈2 attempts/min → remote brute force inviable) |
| `banAfterFailures` = 15 | identity start refusing any credential (60 min) |
| `observationWindowMs` = 10 min | identity observation window |
| `bruteForceCeiling` = 100 | **NIST upper bound** (lowering allowed, raising not) |

(*verified in deepseek-harness-mobile/src/ratelimit/policy.ts:70-82,113-118*).

### 6.3 “Restricted mode”, not lockout

At 100 consecutive account failures the plugin does **not** lock the owner out; it **drops the exposure**: tunnel down, only loopback + credential pass, state persisted so restarting DSH does not clear it. Exit is local; no remote path disables it (*verified in deepseek-harness-mobile/docs/THREAT-MODEL.md:116-123*).

### 6.4 Bans apply to *identified* buckets only

- Under a quick tunnel with `trustEdgeHeaders:false` there **is no IP** (`Identity.ip` undefined) and no session on a login attempt → the bucket is **global**. A hard ban there would reject the correct-credential owner and count their correct attempts toward the NIST ceiling — a *remote unauthenticated DoS of the exposure with ~100 requests* (*verified in deepseek-harness-mobile/src/ratelimit/policy.ts:133-166*).
- **Rule:** the hard 60-min ban applies only to `ip`/`session` buckets (`banAppliesToScope(scope) => scope !== 'global'`); over the collapsed `global` bucket remain only (a) the exponential delay and (b) the NIST ceiling (*verified in deepseek-harness-mobile/src/ratelimit/policy.ts:167-180*).

### 6.5 No oracle, delay from prior failures only

- **401 is byte-identical** for every cause; **no `429`/Retry-After** on the auth path (*verified in deepseek-harness-mobile/src/ratelimit/policy.ts:12-22*).
- **The delay depends only on the *previous* failures**, never the presented credential or the result — otherwise the limiter becomes the timing oracle it exists to close (**CWE-208**) (*verified in deepseek-harness-mobile/src/ratelimit/policy.ts:24-33,109-116*).
- **Full jitter vs equal jitter.** To *waste an attacker’s time* use **full jitter** `random(0, min(cap, base * 2^n))` (max dispersion; degenerates to the exact ladder at `random()===1`). **Equal jitter** (jitter *above* the base, floor never the minimum) is for protecting a downstream service from thundering herds — the proc-backoff case, not the auth gate. Do not swap them (*verified in deepseek-harness-mobile/src/ratelimit/policy.ts:96-107*).

---

## 7. Allowlist: two axes, default deny

Telegram offers **no ready-made authorization**; its docs put the duty on the backend: “Your backend should always verify that received commands are valid and that the user was authorized to use them regardless of scope.” Without an allowlist `t.me/<bot>` is a public admin endpoint (*verified in deepseek-harness-mobile/worker/auth/allowlist.ts:9-14*).

### 7.1 The six traps and the code that closes each

1. **Two axes, always.** A `callback_query` arrives with `callback_query.from`. In a **group** any member can press a button the bot sent: `chat.id` is the authorized group’s while `from.id` is a stranger’s. Verdict requires `allowlist.has(from) && allowlist.has(chat)` — no `||`, ever (*verified in deepseek-harness-mobile/worker/auth/allowlist.ts:15-20,196-200*).
2. **`message.from` is optional** (absent on channel posts). Absence is **denial**, never a loose `undefined === undefined` (*verified in deepseek-harness-mobile/worker/auth/allowlist.ts:21-23,156-160*).
3. **Never by `username`** (mutable, squattable). The allowlist is **numeric only** (*verified in deepseek-harness-mobile/worker/auth/allowlist.ts:24-27*).
4. **52 significant bits.** `Chat.id`/`User.id` fit in 52 bits; JS doubles are exact to 2^53, so `number` suffices but `int32` breaks. Use `Number.isSafeInteger` (*verified in deepseek-harness-mobile/worker/auth/allowlist.ts:29-31,88-91*).
5. **Negative `chat.id` is normal** (supergroups/channels). Sign is part of the number (*verified in deepseek-harness-mobile/worker/auth/allowlist.ts:32-34*).
6. **Default deny.** Empty allowlist denies *everything, including the owner* — same semantics as `trustedRemotes: []` (*verified in deepseek-harness-mobile/worker/auth/allowlist.ts:35-38,188-194*).

### 7.2 The verdict flow is a contract

1. unknown surface → ignore without exception; 2. absent/non-numeric identity → deny; 3. empty allowlist → deny (even the owner); 4. `from` OR `chat` not listed → deny; 5. non-actionable surface → deny; 6. only then accept. (*verified in deepseek-harness-mobile/worker/auth/allowlist.ts:178-187*.)

Deny reasons form a **closed vocabulary** for the local audit log only — never sent to Telegram, where answering *why* would hand a stranger a free oracle about system state (*verified in deepseek-harness-mobile/worker/auth/allowlist.ts:59-72*).
## 8. Pairing and the deputy-confusion nonce

### 8.1 Six-digit pairing, local only

- **6-digit code, local only**: shown on the local terminal (and, if exposed at all, only via loopback-only routes), TTL 5 min, **single-use** with an **explicit reset** path. A pairing code couples the owner’s Telegram identity into the allowlist ([§7](#7-allowlist-two-axes-default-deny)).
- **Code is ephemeral**: it grants *pairing*, never the persistent secret. Once paired, the allowlist is the gate for subsequent updates.

### 8.2 Deputy-confusion is closed by a server-side nonce

- **Deputy confusion** (a.k.a. confused-deputy): a low-privilege principal tricks a privileged one into acting on its behalf. In the bot, an attacker-controlled value must not be accepted as proof of intent.
- **Nonce is minted and consumed on the HOST** (not in the internet-facing worker process) — a nonce validated in the same process that talks to the internet is *not a control, it is a variable* (*verified in deepseek-harness-mobile/worker/auth/allowlist.ts:44-46*).
- Pattern: `action:nonce` ≤ 64 bytes, **TTL 60 s**, held **in memory**. Unknown/expired/replayed nonce → **alert** (audit event), not silent failure.
- **The bot token does NOT bypass the allowlist.** The token authenticates *egress* to the Bot API (who the bot is when it calls out); the *action* comes from an **incoming update**, which must still pass the allowlist gate ([§7](#7-allowlist-two-axes-default-deny)). Treating the token as proof of inbound authority reopens the channel by another name ([§14](#14-the-p-01p-13-phrase-table), P-05).

---

## 9. HTTP auth: 401 vs 403, Host, CSRF, cookies

### 9.1 Status codes

- **401** = “identify yourself”, always with `WWW-Authenticate: Basic realm="..."` — `realm` is informative, never a secret (*verified in deepseek-harness-mobile/cordis.patch.yml, src/http/responses.ts*).
- **403** = “repeating the credential will not help”; the request never reaches auth ([§2](#2-the-layers-in-order)). A 403 does **not** emit `WWW-Authenticate`.
- **Error paths fail closed.** Any decision-path throw returns the *same byte-identical 401*; a 500 there would be an oracle letting an attacker provoke “the gate crashed” (e.g. by filling the audit disk) (*verified in deepseek-harness-mobile/src/http/gate.ts:170-186*).

### 9.2 Host header (anti-DNS-rebinding)

- DNS rebinding: victim opens `http://evil.com` (resolves to attacker IP), the record expires to `127.0.0.1`, and the page’s JS fetches `http://evil.com:PORT/api/...` — same-origin to the browser, arriving at *our* server with `Host: evil.com` (*verified in deepseek-harness-mobile/src/http/host-header.ts:20-37*).
- Defense: refuse any request whose `Host` is not a name this server answers. It is an **allowlist, not a blocklist** — an unknown form simply does not match and is refused (default deny) (*verified in deepseek-harness-mobile/src/http/host-header.ts:38-46*).
- **One normalization for both sides**: received origin → `canonicalRequestHost` → `normalizeRemoteAddress` — the same function that normalizes `req.socket.remoteAddress`. Two divergent normalizations are the classic way an allowlist lets through what it believes it refuses (*verified in deepseek-harness-mobile/src/http/host-header.ts:47-58*). Hex IPv6 (`::ffff:7f00:1`), trailing dots, zone ids and port parsing are handled and validated ([§16](#16-anti-patterns-to-avoid)).
- **`Host` is mandatory in HTTP/1.1** (RFC 9112); absence is refused (raw-socket only) (*verified in deepseek-harness-mobile/src/http/host-header.ts:250-262*).

### 9.3 WebSocket: origin allowlist, no exemptions

- **WebSockets are NOT subject to same-origin policy**; any page on the machine could open `ws://127.0.0.1:PORT` without permission — no preflight, no CORS. The downlink channel already migrated from SSE to a dedicated WebSocket in DSH; leaving it outside the gate reopens #853 by another port (*verified in deepseek-harness-mobile/src/http/gate.ts:196-211*).
- Use an **exact origin allowlist** (scheme+host+port via a URL parser, never `includes`/regex on the raw string) — precedents CVE-2023-26114 (code-server, CVSS 9.3), CVE-2025-52882 (Claude Code) (**CWE-1385**) (*verified in deepseek-harness-mobile/src/http/gate.ts:211-227*).
- An **absent `Origin` is not refused here** — it falls through to the credential: the WebSocket spec makes browsers always send `Origin`, so absence means a non-browser client, and the cross-origin attack (browser-only) does not apply (*verified in deepseek-harness-mobile/src/http/gate.ts:228-242*).
- **No credential-free WebSocket exemptions**; only the pre-auth HTTP doors ([§2](#2-the-layers-in-order)) exist, and none is a bidirectional channel (*verified in deepseek-harness-mobile/src/http/gate.ts:244-266*).

### 9.4 CSRF

- Authenticated state-changing routes need CSRF tokens (**double-submit or per-form**), and the token must not itself be usable as a credential oracle ([§5](#5-the-secret-never-travels-in-the-chat): a magic GET that hands a stranger a consumable token is the refuted trap).

### 9.5 Cookies: `__Host-` and `Secure` on loopback

- **`Secure` cookies DO work on `http://127.0.0.1`.** A common claim that they do not is **refuted by the spec**: loopback is a trustworthy origin and browsers accept `Secure` there; `localhost` name treatment is governed by the same set as the Host allowlist (`isTrustworthyOrigin`) (*verified in deepseek-harness-mobile/src/http/host-header.ts:62-69*).
- **`__Host-` prefix** pins name, `Secure` and path; use it for the session cookie.
- **The session dies with the tunnel.** Session lifetime is bounded (e.g. 60 min / 8 h), and on tunnel TTL expiry **every issued session is invalidated** in a deterministic order — tunnel down → sessions invalidated → audited → owner notified last (the notify step can fail over the network) (*verified in deepseek-harness-mobile/cordis.patch.yml tunnel.ttlMinutes and THREAT-MODEL.md*).
- **No periodic rotation.** NIST 800-63B-4 does **not** require periodic session rotation; forced rotation without a trigger adds failure modes and no real reduction. Rotate on a *trigger* (tunnel teardown, trust change), not on a clock.
- **`trustEdgeHeaders: false`**: the plugin reads **one** edge header (`cf-connecting-ip`) at most, and even that only when the mode is explicitly `tunnel`; `X-Forwarded-For` is **added to** (not replaced by) real client values and is forgeable — forbidden in all modes (*verified in deepseek-harness-mobile/cordis.patch.yml exposure.trustEdgeHeaders*).

---

## 10. The tool pipeline and the elevation veto

### 10.1 The lifecycle is `tool/call → pre-execute → execute → post-execute → result`

The DSH dispatch is a sequential cascade (*verified in
`Análise do DeepSeek Harness` material, tool-pipeline section*):

1. **`tools/pre-execute`** — install-policy validators scrutinize the request and demand *external consent* when mutations reach critical subsystems (*verified in `Análise` material*).
2. **Monotonic approval barrier** — once permissions pass, `tools/execute` runs with adaptive timing and transient-failure retries; direct filesystem edits go through `fs/write-intent` (*verified in `Análise` material*).
3. **Post-execution seam** — evaluates the return format and normalizes exceptions; **post-execute substitutes the returned result**. The outcome solidifies into a replayable `tool/result` record (*verified in `Análise` material*).

**MCP tools ride the same pipeline**; do not special-case them outside it. A veto at the `waterfall`/`intercept` seam (immediate return without calling `next()`) is an **irreversible short-circuit** of the event flow (*verified in `Plugin Cordis DeepSeek Harness` material, waterfall veto*).

### 10.2 The elevation veto (`danger-full-access`)

- A permission-elevation event (`security/permission-elevate`) is vetoed for forbidden permissions (e.g. `danger-full-access`), even on an **authenticated** request (*verified in deepseek-harness-mobile/cordis.patch.yml deniedPermissions*).
- **Honesty about reach (it is not the primary brake).** This handler is **not** what actually closes #853: `danger-full-access` arrives in the *body* of `POST /api/commands/execute`, and the gate deliberately does not read bodies ([§2](#2-the-layers-in-order)). The listener is defense-in-depth, armed for when the host emits the event; what really closes #853 is auth + origin allowlist + loopback bind (*verified in deepseek-harness-mobile/cordis.patch.yml deniedPermissions*).

### 10.3 Canonicalization is anti-evasion

Compare on **canonical** forms for both allowlist inputs and received values: **percent-decoding**, **case**, **separators**, and **boundary punctuation**. In the real plugin, two divergent normalizations of the remote address are the classic allowlist bypass ([§9](#9-http-auth-401-vs-403-host-csrf-cookies)); a `Host` that canonically collapses attacker junk (`127.0.0.1:evil.com`, `[::1]qualquer-coisa`) to loopback was a real, measured hole before the strict parser replaced it (*verified in deepseek-harness-mobile/src/http/host-header.ts:80-101*).
---

## 11. Input validation

- **Standard Schema.** Argument certification follows the Standard Schema spec; the goal is to protect the executor against stochastic LLM output (formatting hallucinations into structured errors, early rejection of unsound requests) and map to TypeScript types (*verified in `Guia de Contribuição e Desenvolvimento` material*).
- **Fail loud at load.** Malformed config or a missing credential fails the node at *instantiation*, preventing deferred corruption (*verified in `Guia de Contribuição` material*). For an auth plugin this is stark: `assertRateLimitPolicy` refuses to load at module scope; a bad bind or a looser-than-0600 audit file fails before the first request (*verified in deepseek-harness-mobile/src/ratelimit/policy.ts:109-117* and *src/audit/log.ts*).
- **Explicit > implicit.** Heavy validation at **insecure external boundaries only** (JSON coming from the LLM model, web requests, IPC, external subprocess seams); inside a trusted boundary runtime validation is trusted implicitly. There is no implicit default for fields that participate in rate limiting — a missing “optional-with-default” field is a config *error*, never a silent default (*verified in deepseek-harness-mobile/src/ratelimit/policy.ts:33-43*).
- **Path normalization is evasion-proof.** Evasion like `/paths` reaching `/api` (encoded `/%61pi`) must not slip a loopback-only or guarded check. The static dist server already refuses traversal outside dist root with **403** and non-GET/HEAD with **405** (*verified in types/dsh-host-frontend-static/index.d.ts, serveStatic contract*); your own routes must treat the decoded pathname as hostile.

---

## 12. Processes and environment

### 12.1 Environment is built by allowlist, not inherited

The worker does **not** inherit `process.env`. The plugin assembles an environment from an **allowlist** (PATH, HOME, TMPDIR, LANG, TZ, TLS trust roots, SystemRoot/ComSpec on Windows) plus the bot token (*verified in deepseek-harness-mobile/src/proc/env.ts:9-25,66-78* and *docs/THREAT-MODEL.md:135-140*).

**An allowlist, plus exactly the one secret the child needs.** Inheriting the whole environment would hand the control plane’s secrets to a third-party binary that consumes arbitrary internet input; compromised bot → attacker reads `/proc/self/environ` → pivots local→remote (*verified in deepseek-harness-mobile/src/proc/env.ts:3-8*). Even better, the DSH seat **already scrubs** credential-shaped names and all `DSH_*` from the parent env (`scrubbedParentEnv`, `SENSITIVE_ENV_PATTERN`), and the explicit `env` merges *after* that scrub (*verified in types/dsh-subprocess/index.d.ts, SENSITIVE_ENV_PATTERN + scrubbedParentEnv*).

### 12.2 Token by ENV, never argv

The token enters by environment and **never by argv**, because argv is readable by any local process in `/proc/<pid>/cmdline` (*verified in deepseek-harness-mobile/src/proc/env.ts:64-65*). A `cloudflared --token` in argv is the anti-pattern it exists to ban (*verified in deepseek-harness-mobile/cordis.patch.yml tunnel*).

### 12.3 Separate profiles — the worker never sees the tunnel token, and vice-versa

Give each subprocess the **minimum** secret: the Telegram worker gets `TELEGRAM_BOT_TOKEN`; **`cloudflared` never receives `TELEGRAM_BOT_TOKEN`** (nor the control-plane credential). One secret per boundary keeps a compromise from compounding. (See the profile example in the real repo: `cordis.profile.patch.example.yml`.)

### 12.4 detached + kill(-pid); close vs exit; orphans; pidfile

- **`detached` + process-group kill.** Spawn detached and terminate the **group** (`kill(-pid, 'SIGKILL')` as last resort), or use the subprocess service’s own tree-scoped teardown; a root `child.kill()` is not guaranteed to reach a shell tree. The DSH seam terminates the whole tree by default (`SIGTERM → graceMs → SIGKILL`, POSIX group; `taskkill /T /F` on Windows) and exposes `waitForExit` on the whole tree (*verified in types/dsh-subprocess/types.d.ts SubprocessHandle* and `Plugin Cordis` material re kill(-pid)).
- **“Close” is not “exit”.** Runtime `close` actually means the tree exited; an inherited descriptor held by a surviving descendant must not hold `done` open. Use the seam’s whole-tree quiescence (“collected output readable after exit”) (*verified in types/dsh-subprocess/types.d.ts*).
- **Orphans / pidfile.** Track the tunnel supervisor via a pidfile under the host state dir; orphans (stray servers that lack `window.__DSH_BOOT__`) are a known operational hazard when unmanaged background servers are spawned (*verified in mobile repo `src/tunnel/pidfile.ts` and postmortem material*).
- **No `shell:true`.** Use argument arrays; never shell-interpreted strings (`argv` is never shell-interpreted by the seam). `shell:true` with interpolated input is command-injection territory ([§16](#16-anti-patterns-to-avoid)).
- **Backoff with a floor.** Retry with exponential backoff; **jitter is added *above* the base** so the delay never drops below the documented floor (the downstream-protection case, distinct from the auth gate in [§6](#6-rate-limiting-nist-sp-800-63b-4)) (*verified in deepseek-harness-mobile/src/proc/backoff.ts* and cordis.patch.yml).

---

## 13. Append-only auditing

An audit trail that lives *inside* the system it audits (a Telegram notification channel, deletable by the owner) is not a trail. Notifications happen **after** the log is written (*verified in deepseek-harness-mobile/src/audit/log.ts:5-10*).

- **Append-only for real**: `O_WRONLY | O_CREAT | O_APPEND`, plus `O_NOFOLLOW` so a symlink swap fails instead of writing into `~/.ssh/authorized_keys`. `O_APPEND` positions the write at the end *inside* `write(2)` — no seek-then-write window for another process (*verified in deepseek-harness-mobile/src/audit/log.ts:11-20,38-42*). One line, one `write` over an `O_APPEND` descriptor, so two processes cannot interleave half lines.
- **Modes**: file `0600`, dir `0700`, verified on the descriptor (an `fstat`, because a path-based `stat` can race a swap). Dir must be ours (`0700`) or any process can rename the log. Error message intentionally includes paths — it goes to operator stderr, never an HTTP body (*verified in deepseek-harness-mobile/src/audit/log.ts:38-48,232-245,286-304*).
- **Outside the workspace and outside Telegram.** The workspace is served by the Web UI and versioned in git; a file with auth attempts and IPs inside it is a leak waiting to happen (*verified in deepseek-harness-mobile/src/audit/log.ts:5-10*).
- **JSON, fixed key set.** Each event is a fixed-shape JSON object (stable 5-key set: e.g. event/outcome/time/…); `EVENTO_LACUNA` marks a gap so a reader can distinguish “nobody tried” from “it failed to record” (*verified in deepseek-harness-mobile/src/audit/log.ts:32-34*).
- **`redact()` is a white-list, not a black-list.** Literals to mask are provided per-write (they rotate with the secret/tunnel URL); mask by **replacing known-good strings**, never by scanning for suspicious patterns (a black-list always misses a variant) (*verified in deepseek-harness-mobile/src/logging/redact.ts*).
- **Fail-closed on full disk.** A write failure must deny the request; fail-open would create an *invisible brute-force window* born of a resource failure, with no line left. This is distinct from the restricted-mode lockout (attacker-triggered); disk-full is host-state-triggered and clears when space returns — no latch (*verified in deepseek-harness-mobile/src/audit/log.ts:50-84*).
- **`fsync` is off by default** (a disk write on the auth path would make success/failure timing distinguishable); the cost is the page-cache window on power loss — an accepted trade (*verified in deepseek-harness-mobile/src/audit/log.ts:95-116*).

---

## 14. Anti-patterns and forbidden claims — the P-01..P-13 phrase table

Refuted-honesty claims that keep resurfacing in plugin docs. Each row gives the **wrong claim** and the **correction**. Verify against the range `@deepseek-ai/dsh` 0.1.0-rc.7 .. 0.1.1-rc.1 (the shipped `.d.ts` typings).

| # | Wrong phrase | Correct, with source |
| --- | --- | --- |
| **P-01** | “Zero Trust free plan caps at 50 users” | Refuted by real measurement; no such documented cap drives these controls. |
| **P-02** | “jcode benchmarks” / “pi2dsh package” | Refuted; neither is a reliable factual anchor for a security guide. |
| **P-03** | “The quick tunnel does not support SSE” | Refuted; quick tunnels carry SSE. The DSH downlink moved to WebSocket regardless (§9.3). |
| **P-04** | “The bot token bypasses the allowlist” | Token authenticates egress; the action comes from an inbound update that still passes the allowlist (§8.2, §7). |
| **P-05** | “`drop_pending_updates` is a `getUpdates` parameter” | It is a `deleteWebhook` option; `getUpdates` takes `offset`/`timeout`/`allowed_updates` (verified in mobile worker poller). |
| **P-06** | “ASVS 5.0 §6.5.2 authorizes SHA-256 for ≥128-bit tokens” | Refuted for a primary credential; §6.5.2 is a MFA lookup-secret rule (§4.3). |
| **P-07** | “Quick-tunnel URLs get indexed by search engines” | Not confirmed; the URL is an address, not a credential (§1.3) — protect with auth regardless. |
| **P-08** | “`child.kill()` is never enough with an intermediary shell” | Half-truth: root `child.kill()` may miss a shell tree; use detached + group kill or the seam’s tree teardown (§12.4). |
| **P-09** | “`Secure` cookies don’t work on http://127.0.0.1” | Refuted; loopback is a trustworthy origin and browsers accept `Secure` there (§9.5). |
| **P-10** | “package.json has a compatibility field for DSH” | Refuted; no such standard field. Check version fit against the `.d.ts` (§14.1). |
| **P-11** | “The plugin has N runtime deps on the host” / “zero runtime deps” | Measured truth: one host runtime dep (`grammy`), loaded **only by the worker** (§1.3, THREAT-MODEL §8). |
| **P-12** | “`ctx.httpServer` / `HttpServerService` / `spawn(cmd, args, opts)`” | Dead line 0.0.1-rc.1/rc.2. Live range: `ctx.webServer` (class `WebServer`) and `ctx.subprocess.spawn(spec: SubprocessSpawnSpec)` (§14.1). |
| **P-13** | “`bundle: {}` activates a DSH bundle” | Refuted: activation requires `dsh.bundle.patch`; empty `bundle:{}` passes the registry gate but the product ignores it (§14.2). |

### 14.1 The API is the `.d.ts`, never prose

- **Correct names (verified against `@deepseek-ai/dsh` 0.1.0-rc.7 .. 0.1.1-rc.1):** `ctx.webServer` -> class `WebServer` (`@deepseek-ai/dsh-host-webserver`); `ctx.subprocess` -> `SubprocessRuntime`, with `spawn(spec)`, `resolveExecutable`, `spawnTerminal`; packages `@deepseek-ai/dsh-subprocess` (+`-local`), `@deepseek-ai/dsh-host-frontend-static` (*verified in types/dsh-host-webserver/index.d.ts, types/dsh-subprocess/index.d.ts*).
- **Version warning:** `httpServer: HttpServerService` existed **only** in `0.0.1-rc.1/rc.2` — the abandoned line, superseded 2026-08-12. Write against `webServer: WebServer` and validate the actual `.d.ts`, never documentation prose (rule “Q-1: truth is the tarball `.d.ts`”) (*verified in mobile spikes/api-dsh.md:127-137*).

### 14.2 The bundle gate is `dsh.bundle.patch`, not `bundle:{}`

`bundle:{}` passes the registry gate but the product ignores it: activation is decided by `dsh?.bundle?.patch !== void 0` and boot throws if a listed bundle has no `.patch` (*verified in deepseek-harness-mobile/package.json “//dsh” note and cordis.patch.yml*).

---

## 15. Acceptance checklist

> **A control without an owner is not a control.** Each row must have a named owner and a test that fails without it.

**Readiness of the gate:**
- [ ] Bind validated at load (≤ loopback; `0.0.0.0`/`::` rejects) and authored in the bundle/config.
- [ ] Check order is **origin → Host → credential/session** and a test turns red if inverted.
- [ ] `403` before `401`; `403` emits no `WWW-Authenticate`; the two perimeter `403`s are byte-identical.
- [ ] Exact-origin WebSocket allowlist; **no** credential-free upgrade exemptions; absent Origin falls to auth, not `403`.
- [ ] Loopback-only routes refuse off-loopback with the same `404` as an invalid token.

**Keep the boundary honest:**
- [ ] **Anonymous → 401** (probe with no credential; reply is the identical `401`, never 403/429/500).
- [ ] **Probe 4 sockets/scenarios** (as in the real security suite): no `Host`, wrong `Host`, wrong-origin WS handshake, header forgery (`X-Forwarded-For` ignored when not trusted).
- [ ] No `catch (err) { ... return true }` — **catch-true is forbidden**; every path ends in deny (fail-closed).
- [ ] Request body **not** read on the decision path.
- [ ] Delay computed from previous failures only; delay never leaks via a status/body/header.

**The secret and delivery:**
- [ ] 256-bit CSPRNG, base32, only a sha256 digest on disk (0600 / 0700); comparison via `timingSafeEqual` on fixed 32 bytes.
- [ ] Persistent secret never travels in chat or over the tunnel; delivery local/QR/OTT; OTT single-use, TTL-bounded, GET-inert/POST-consumes.
- [ ] Secret never in argv; environment is an allowlist; the worker never inherits the control-plane env; separate profiles for `cloudflared` vs worker.

**Rate limit / allowlist / audit:**
- [ ] `401` byte-identical in all failures; no `429`; NIST ceiling ≤ 100 with restricted (not lockout) mode; ban scoped to identified buckets.
- [ ] Authorization always `from.id && chat.id`, numeric-safe-integer, default deny, empty allowlist denies the owner.
- [ ] Nonce minted/consumed host-side, in-memory, 60 s TTL; unknown → alert.
- [ ] Auditing append-only, `0600`/`0700`, outside workspace/Telegram, fail-closed on full disk, redaction by white-list.

---

## 16. Anti-patterns to avoid

- **Treating the sandbox as the boundary** after a credential breach (#853, #1769, #3144 are the receipts).
- **`Math.random` / `Date.now` / `randomUUID`** for a credential; **`Buffer.from(user+pass)`** fallback that interpolates “undefined” into a stable, readable credential (*verified in cordis.patch.yml*).
- **Comparing raw secrets** (leaks length) or **comparing with `===`** (timing oracle).
- **`spawn(cmd, args, opts)` / `ctx.httpServer` / `HttpServerService`** — the dead `0.0.1-rc` line; **`shell:true`** with interpolated input.
- **Token in argv** (readable in `/proc/<pid>/cmdline`), **`--token` for cloudflared**, **inheriting `process.env`**, **sharing one env between the worker and the tunnel**.
- **Banning the collapsed global bucket** under a tunnel (self-DoS), and **returning `429`/`Retry-After`** on auth.
- **A `Host` parser that stops at the first `:`** accepts `127.0.0.1:evil.com` or `[::1]junk` as loopback (*verified in host-header.ts:80-101*).
- **`GET` that consumes a one-time magic token** (dies on preload); **`deleteMessage` for secrets** (≈48h, cosmetic); **storing the secret in a chat**.
- **`bundle:{}`** for activation; **prose-trust over the `.d.ts`** for API names.
- **catch-true**, **fail-open audit**, **logging the digest/credential to the operator log or Telegram**.

---

## 17. Verified sources

### GitHub / official Discussions
- **#853** — Unauthenticated local/remote code execution via the dsh web UI control plane (verified on `0.1.0-rc.6`).
- **#1769** — bwrap `workspace-write` sandbox escapable via `mount -o remount,rw` (migration toward landlock).
- **#3144** — Sandbox denials invisible to the model when a confined program rewrites the kernel error.
- #2678, #441 — `dsh-autogate` approval plugin; non-atomic `cordis.yml` rewrite (report upstream to `deepseek-ai/deepseek-harness`).

### Normative
- NIST SP 800-63B-4 §3.2.2 “Rate Limiting (Throttling)” (final 2025-07-31) — “no more than 100”, delay ladder, disregard on success.
- ASVS 5.0 11.5.1 — CSPRNG, ≥128 bits. (ASVS 5.0 §6.5.2 does **not** authorize a cheap hash here — it is a MFA lookup-secret rule; see §4.3.)
- RFC 4648 (base32), RFC 6761 (`localhost`), RFC 9112 (mandatory `Host`), CWE-208 (timing oracle), CWE-1385 (WS origin).
- Cloudflare TryCloudflare docs — quick tunnel is *“for testing and development only”*, no SLA; Access needs a domain/zone.
- Telegram Bot API docs — backend must verify authorization; Secret Chat does not exist for bots; `drop_pending_updates` is a `deleteWebhook` param (not `getUpdates`).
- arXiv 2601.17548 — prompt-injection success ≥ 85% on sampled workloads `[UNVERIFIED]`; treat as accepted risk (§1.3).

### Reference implementation (read the code, not the prose)
- `deepseek-harness-mobile` — the guarded-bot orchestrator: `src/http/gate.ts` (L2/L2.5/L3 order), `src/http/host-header.ts` (3 allowlists, DNS rebinding), `src/secret/*` (CSPRNG/base32/digest/timing-safe), `src/ratelimit/*` (NIST, buckets, jitter), `worker/auth/allowlist.ts` (two axes), `src/audit/*` (append-only, fail-closed), `src/proc/env.ts` (env allowlist), `src/panel/magic.ts` (OTT link).
- Shipped `.d.ts` typings — `@deepseek-ai/dsh` 0.1.0-rc.7..0.1.1-rc.1: `webServer: WebServer`, `subprocess: SubprocessRuntime`, `spawn(spec: SubprocessSpawnSpec)`, `SENSITIVE_ENV_PATTERN`/`scrubbedParentEnv`, `serveStatic` 403/405.

---

*Symbols referenced only as “verified in material” come from the four DSH project materials analyzed in full for this guide; where a number could not be re-verified from a shipped artifact or official URL in this session, it is flagged `[UNVERIFIED]` rather than asserted.*
