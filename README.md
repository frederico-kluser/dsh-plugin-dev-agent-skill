# dsh-plugin-dev-agent-skill

**The complete agent skill for building DeepSeek Harness plugins.**

A self-contained, verified-by-measurement skill that teaches an AI agent (and its human) how to create, extend, secure, test, package and publish a Cordis plugin for the DeepSeek Harness (DSH) — against the real measured API surface, not against prose.

[![language](https://img.shields.io/github/languages/top/frederico-kluser/dsh-plugin-dev-agent-skill.svg)](https://github.com/frederico-kluser/dsh-plugin-dev-agent-skill)
[![license MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![skill global](https://img.shields.io/badge/skill-global-blue.svg)](#)

## What is this?

Everything in DeepSeek Harness is a plugin. The user-facing extension path is a Cordis plugin you publish yourself — never a pull request against the official repo, which does not accept external PRs. This skill is the playbook for that path, with every claim pinned to a verified source (`verified in <path>:<line>` or an official URL) and every refuted or unconfirmed community claim flagged, never taught as truth.

The skill covers six capabilities:

- **Create functionality** — backend behavior via typed events, `ctx.effect` disposers, ControlIntent, long-polling subprocesses and JSONL IPC.
- **Change the interface** — the four frontend levers: `ctx.webServer` routes, dispatch takeover, `tapIndex`, and the slots / client-export system.
- **Security** — credential + boundary, fail-closed defaults, two-axis allowlists, nonces, audit and rate limiting for a control-plane-facing plugin.
- **Testing** — a six-layer pyramid, doubles-with-a-contract, an adversarial suite, contract tests and purposeful coverage.
- **Packaging** — pre-compiled bundles, allowlisted tarballs, `publint` + `attw --pack .` + a check-tarball script.
- **Publishing** — changesets, OIDC provenance and a CI gate.

## Quick install (global skill via symlink)

The repository *is* the skill directory: the root SKILL.md, `docs/`, `examples/` and `scripts/` together form one installable skill. Clone anywhere and symlink it into your agent's skills directory:

```bash
git clone https://github.com/frederico-kluser/dsh-plugin-dev-agent-skill.git ~/Projects/dsh-plugin-dev-agent-skill
mkdir -p ~/.agents/skills
ln -s ~/Projects/dsh-plugin-dev-agent-skill ~/.agents/skills/dsh-plugin-dev-agent-skill
```

- The skill directory is the whole repository — SKILL.md at the root, plus `docs/`, `examples/` and `scripts/`.
- `docs/*.md` are canonical references an agent loads **on demand** by topic; it does not read them all up front.
- To uninstall, remove the symlink: `rm ~/.agents/skills/dsh-plugin-dev-agent-skill`. The cloned repo can stay or go.
- Other agent tools read skills from their own paths (e.g. `~/.claude/skills`); point the same symlink there — the skill is backend-agnostic.

## How it works

| Path | Contents | Load when |
| --- | --- | --- |
| `SKILL.md` | instructions, API truth, security/testing/packaging essentials, anti-patterns | **always** — start here |
| `docs/*.md` | in-depth reference (architecture, interface, functionality, security, tests, packaging) | on demand, by topic |
| `examples/minimal/` | a real, compilable Cordis plugin skeleton | study it / run it to bootstrap |
| `scripts/check-skill.mjs` | zero-dependency self-check validator | `node scripts/check-skill.mjs` |

## Quick start: create a plugin

This is the one-page flow the skill teaches in full. From empty repo to installed plugin:

1. **Validate the API** against the real `.d.ts` / tarballs (never prose) — confirm `ctx.webServer` / `WebServer`, `ctx.subprocess` / `SubprocessRuntime`, and `spawn(spec)` in your supported `0.1.0-rc.7..0.1.1-rc.1` range. Pin the version line the harness actually resolves.
2. **package.json** with `type: "module"` (ESM only), `engines.node >= 24`, and a **real** `dsh.bundle.patch` — a blank `dsh.bundle: {}` activates nothing.
3. **cordis.patch.yml** — a single `insert` with *your own* id; never aim at another package's id (resolution is whole-entry replace).
4. **src/index.ts** — a module exporting `name`, an `inject` array, an optional `Config`, and `apply(ctx, config)` that asserts config (fail-loud at load) and registers everything reversible through `ctx.effect`.
5. **Worker** — keep long-polling integrations in a subprocess via `ctx.subprocess.spawn(spec)` with a JSONL IPC protocol and a dead-man's switch.
6. **Test** — the six-layer pyramid; the adversarial suite must attempt to breach your gate; a contract test pins your mirrored types.
7. **Package** — `publint` + `attw --pack .` + `check-tarball`, allowlist the tarball, then publish with a CI gate.

```jsonc
// package.json (excerpt) — a dsh.bundle.patch is the activation switch
{
  "name": "dsh-my-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "engines": { "node": ">=24" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": { "@deepseek-ai/cordis": ">=4.0.0 <5" }
}
```

```ts
// src/index.ts — the canonical plugin shell
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-my-plugin'
export const inject = ['webServer'] as const          // NOT 'httpServer'

export interface Config {
  realm: string
  trustedRemotes: string[]
}

export function apply(ctx: Context, config: Config): void {
  assertValidConfig(config)                            // fail loud at load

  ctx.effect(() =>
    ctx.webServer.register({                           // a real seat on WebServer
      kind: 'prefix',
      path: '/__guard',
      handler: (req, res) => { res.writeHead(200); res.end('guard up') },
    }),
  )
}
```

The full spelling — options, edge cases, security obligations and the exact API names — lives in SKILL.md and the referenced docs.

## Content map

What each reference document covers:

| Document | Covers |
| --- | --- |
| `SKILL.md` | the end-to-end recipe, exercised API truth, and the mandatory section layout (what-you-will-learn, install, create, interface, functionality, security, testing, packaging, anti-patterns) |
| `docs/arquitetura.md` | Cordis in DSH: Context, fibers, effects, events, merge layers, and the anti-pattern inventory |
| `docs/interface.md` | the four frontend levers: routes, dispatch takeover, `tapIndex`, slots and client exports |
| `docs/funcionalidade.md` | typed events, ControlIntent, tunnels, Telegram worker, subprocesses and IPC |
| `docs/seguranca.md` | threat model, boundary + credential, allowlists, nonce, audit, rate limiting, acceptance checklist |
| `docs/testes.md` | test pyramid, doubles-with-a-contract, adversarial suite, mutation, coverage, CI |
| `docs/empacotamento.md` | build, tarball, `publint`/`attw`/`check-tarball`, changesets, trust pipeline, publish |

What this skill is **not**:

- **Not an SDK.** It is documentation and a runnable skeleton; it ships no runtime code you wire into your plugin.
- **Not the DeepSeek Harness.** DSH is upstream and out of scope here — the skill reads its real published packages, it does not modify them. External PRs are not accepted upstream.
- **Not a substitute for verification.** Per its honesty rule, every teachable fact is independently verified against the published `.d.ts`/tarballs and measured experiments; nothing here exempts your code from its own contract tests.

## Honesty & sourcing

This skill treats claims the way a good test suite treats behavior:

- **Verified facts** carry a source — `verified in <path>:<line>` (pointing at the real measurement / mirrored types) or an official URL — and are safe to teach.
- **Refuted claims** (the `P-01..P-13` table) are marked **refuted by real measurement** and appear only in anti-pattern sections, always next to the verified correct alternative. They are never taught as truth.
- **Uncertain claims** are explicitly marked `[UNVERIFIED]`.

Examples of what that catches: the web seat is `ctx.webServer` / `WebServer`, not `ctx.httpServer`; spawning is `spawn(spec)`, not `spawn(command, args, options)`; a blank `dsh.bundle: {}` does **not** activate a plugin — only `dsh.bundle.patch` does. API names drift, and prose lags behind the tarballs, so the skill's default posture is "measure, then teach".

## Development / contributing

Contributions are welcome via pull request. A few house rules keep the skill honest:

- **Run the validator before you open a PR** — `node scripts/check-skill.mjs` (zero-dependency; `--strict` for the full gate). It checks frontmatter, the mandatory section layout, internal links, forbidden claims and placeholders.
- **Never teach a refuted claim.** Keep every `P-01..P-13` phrase only in anti-pattern sections, always paired with the verified correct behavior.
- **Source your facts.** Every new teachable claim needs a `verified in <path>:<line>` or official URL; mark anything you cannot confirm as `[UNVERIFIED]`.
- Public-facing content is in **English**; keep the tone direct and technical.

## License

MIT © 2026 Frederico Guilherme Klüser de Oliveira. See [LICENSE](./LICENSE).
