# Arquitetura do DeepSeek Harness — referência para autores de plugins

> Documento de ARQUITETURA da skill `dsh-plugin-dev-agent-skill`. Explica o modelo mental
> correto para escrever um plugin Cordis para o DeepSeek Harness (DSH): o
> micro-core Cordis, o ciclo de vida de uma Fiber, os serviços do host
> disponíveis em `inject`, a hierarquia de processos que o host orquestra, o
> canal IPC host↔worker, the control contract, and the state machine of
> what the plugin controls — and, at the end, the inventory of what NOT to do
> (measured anti-patterns).
>
> **Honesty principle.** Every fact here has a source tagged with
> `verified in <path>:<line>` (aponta para o caso real em
> `deepseek-harness-mobile` ou para os tipos byte-exatos dos tarballs
> publicados) ou com uma URL oficial. Claims marcadas `[UNVERIFIED]` são
> incertas de propósito. Várias afirmações que circulam na comunidade foram
> MEDIDAS e refutadas; aparecem na secção "Anti-patterns" e na
> "Cobertura do filtro de honestidade" explicando o que é verdade no lugar.

---

## 1. Overview

O DeepSeek Harness é um "micro-core Cordis": um runtime de agentes onde **tudo é
um plugin** e **nada é privilegiado** — nem o ciclo do agente, nem o registo de
ferramentas, nem a interface web. O agente, as ferramentas, o LLM e a UI entram
todos pelo mesmo mecanismo de plugins que um colaborador externo usa.

A base oficial (`@deepseek-ai/dsh-base`) é **também** um bundle de plugins (ver §10).
A consequência prática é que o *capability seam* — a costura entre a tua coisa e o
host — é o que define o teu plugin, e existem pouquíssimas. Diagrama de alto nível:

```text
                        ┌─────────────────────────────────────────────┐
                        │  dsh CLI (o processo "host")                 │
                        │  Node.js + Cordis v4 (micro-core)            │
                        │  plugins (bundles/profiles) ── cada funcionalidade
                        │   ├─ @deepseek-ai/dsh-base     (base, UI,
                        │   ├─ @deepseek-ai/dsh-web-app   o teu plugin)
                        │   └─ <o teu plugin>             é um plugin
                        │  ctx.webServer  (WebServer)    ┐
                        │  ctx.subprocess (Subprocess)   ┘ services
                        └───────────────┬──────────────────────────────┘
                                        │ spawn(spec): argv/cwd/stdio/grace/signal/env
                                        ▼
                        ┌───────────────────────────────┐
                        │  processo filho (o worker)     │  MESMO pacote npm que o host,
                        │  JSONL bidirecional stdin/stdout │ entrypoint por import.meta.url
                        └───────────────┬───────────────┘
                                        │ (opcional) spawn
                                        ▼
                        ┌───────────────────────────────┐
                        │  binário de terceiros          │  ex.: cloudflared (não coopera
                        │  (não-controlled do teu canal) │  com dead-man's switch)
                        └───────────────────────────────┘
```

**Leituras obrigatórias antes de escrever qualquer código.** Esta skill foi
produzida a partir de quatro materiais (ver §12 "Verified sources") e do caso
real `deepseek-harness-mobile`, um plugin Cordis v4 completo para o DSH (pinado
em `@deepseek-ai/dsh@0.1.0-rc.7 .. 0.1.1-rc.1`, faixa em `dsh-compat.yml`). Os nomes
de API vêm dos **.d.ts byte-exatos dos tarballs publicados** (regra Q-1 do caso
real — verified in `src/dsh/adapter.ts:16-19`).

---


## 2. Cordis lifecycle — a Fiber

Cada instância ativa de um plugin em Cordis v4 é uma **Fiber**. O ciclo de vida é um
autómato de cinco estados nominais mais um terminal:

```text
   PENDING ──(deps de inject)→ LOADING ──(apply() roda)→ ACTIVE
      ▲                                          │       │
      │            reativa◄──── UNLOADING ◄───────┘       │ (HMR/descarga/dep sumiu)
      │                   disposers rodam │                │
      │                                     ▼                │
      └────────────-──────────────────── DISPOSED            │
                                                              ▼
                          FAILED  (apply() ou config lançou — absorvente)
```

Fonte do enum, byte-exato do tarball `@deepseek-ai/cordis@4.0.1`
(verified in `deepseek-harness-mobile/types/cordis/fiber.d.ts:76-83`):

```ts
export declare const enum FiberState {
  PENDING = 0,      // waiting for required services
  LOADING = 1,      // the plugin callback is running
  ACTIVE  = 2,      // loaded and providing
  FAILED  = 3,      // the callback or its config threw
  DISPOSED = 4,     // the fiber was removed and cannot restart
  UNLOADING = 5,    // disposers are running
}
```

> **Sequência pedida na task.** A ordem canónica é
> `PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED`, com `FAILED` como estado
> absorvente à parte. Em `FAILED` a Fiber *não* volta sozinha — exige recarga
> (`restart()`) ou HMR.

Três pontos que importam para autores:

1. **`PENDING` bloqueia em dependências.** Enquanto uma dependência de
   `inject` não estiver disponível no contexto, `apply()` **nunca roda** e não há
   erro nem log — é um silêncio deliberado do motor. Medido no caso real: com
   `inject: ['webServer','subprocess']` a Fiber fica ACTIVE; acrescentar `'logger'`
   deixa-a PENDING para sempre, porque `LoggerService` **não estende `Service`** e
   não entra no registo de provedores que o `inject` lê (verified in
   `deepseek-harness-mobile/src/index.ts:344-357`).

2. **Disposers correm em LIFO, mas podem ser async.** Contrato do Cordis:
   *"Disposers run in reverse registration order when the owning fiber
   unloads; they may be async, in which case unloading awaits them"*
   (verified in `types/cordis/fiber.d.ts:44-50`). O caso real **escolhe disposers
   síncronos** por regra de projeto (Q-2), mesmo que o host tolere async:
   `src/proc/supervisor.ts:157-163`.

3. **Ordem dos `ctx.effect` importa quando há mais de um.** Como os disposers
   correm ao contrário, a ordem de instalação define a ordem de derrube. No caso
   real, a barreira HTTP é registada **primeiro** (`src/index.ts:699`) e o worker
   é registado **depois** (`src/index.ts:1098`). Sob LIFO, o worker — registado
   por último — morre primeiro, e a barreira — registada primeiro — levanta por
   último: não fica janela em que o plano de controlo responde sem credencial
   (verified in `src/index.ts:699`, `src/index.ts:1098` e o comentário de desenho
   em `src/index.ts:367-375`; corroborado por `deepseek-harness-mobile/docs/ARCHITECTURE.md:26-28`).

---

## 3. DI & type augmentation

A **composição espacial** de Cordis é a injeção de dependências declarada por
`inject` + serviços fornecidos por outros plugins. A **composição temporal** é o
ciclo de vida da §2. Os dois juntos são o slogan do Cordis: "composabilidade
espaço-temporal".

### 3.1 `inject` — dependências obrigatórias

```ts
export const inject = ['webServer', 'subprocess']
```

- O motor só ativa a Fiber **depois** de `ctx.webServer` e `ctx.subprocess`
  existirem, e descarta a Fiber de novo se alguma desaparecer
  (verified in `deepseek-harness-mobile/src/index.ts:365`).
- Esta injeção é a pré-condição da barreira: o `WebServer` já passou por
  `[Service.init]` e o `node:http.Server` já está a escutar quando o plugin toma
  o despacho (`src/index.ts:340-342`).
- **Não declara `logger`.** `LoggerService` não estende `Service`; injectar
  `'logger'` deixa a Fiber PENDING para sempre — medido contra o Cordis real
  (`src/index.ts:344-357`). `ctx.logger` continua acessível **sem** injeção.

### 3.2 `ctx.get('nome')` — dependência opcional

Um serviço apenas *consumido se existir* não entra em `inject`; sondas o contexto
com `ctx.get('nome_do_servico')` e tratas o `undefined`. Regra prática:
**obrigatório → `inject`; opcional → `ctx.get`**.

### 3.3 module augmentation de `Events`

O Cordis v4 core estabelece `interface Events` vazia; cada plugin declara a
assinatura dos eventos que emite/consome via **declaration merging** sobre o
namespace do pacote host. É isto que dá validação pelo compilador aos
`ctx.waterfall` / `ctx.emit` / `ctx.parallel`:

```ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** @mode waterfall */
    'http/auth-check'(req: IncomingMessage, next: () => Promise<boolean>): Promise<boolean>
    /** @mode waterfall */
    'security/permission-elevate'(command: string, next: () => Promise<boolean>): Promise<boolean>
  }
}
```

(verified in `deepseek-harness-mobile/src/dsh/adapter.ts:96-107`; o modo
`waterfall` — um *around-middleware* — é o destinado a vetos/curto-circuitos:
devolver `false` sem chamar `next()` instaura um veto irreversível; ver
`src/index.ts:605-623`.)

> **Custo zero em runtime.** A augmentation é type-only; dissipa-se no JS emitido.

---

## 4. Host services — `ctx.webServer` e `ctx.subprocess`

São os dois serviços que um plugin do DSH mais usa. Entram ambos via `inject` e
ambas as classes estendem `Service`.

### 4.1 `ctx.webServer` — `WebServer` (dsh-host-webserver)

*"the `webServer` service (HTTP and upgrade route registries, the structured
index injection table with raw transform taps behind it, and the single
fallback seat ...)"* (verified in `types/dsh-host-webserver/index.d.ts:17-24`).

| Método | Assinatura | Semântica |
| --- | --- | --- |
| `register` | `register(route: WebRoute): () => void` | Rota nomeada; `kind: 'exact' | 'prefix'`, `path` absoluto sem barra no fim. Exact-table primeiro, depois longest-prefix-wins. Duplicado (kind, path) **lança**. |
| `registerUpgrade` | `registerUpgrade(route): () => void` | `path` exact para `Connection: Upgrade` (WebSocket). Duplicado lança (um socket = um dono de protocolo). |
| `registerFallback` | `registerFallback(handler): () => void` | **Um único lugar** — tudo o que nenhuma rota nomeada reclama (é onde o distribuidor de SPA entra). Um segundo registo **lança**. |
| `tapIndex` | `tapIndex(fn): () => void` | Transform de HTML cru do `index.html`, escape hatch por baixo das `IndexInjection`. Retorna disposer. |
| `applyIndexTaps` | `applyIndexTaps(html): string` | Roda o corpo pelos taps em ordem de registo — chamado pelo dono do fallback em **toda** resposta de índice. |
| `renderIndex` | `renderIndex(html): string` | Injeções estruturadas primeiro, depois taps. |

Fonte da tabela: `types/dsh-host-webserver/index.d.ts:83-152`.

**Config de bind.** `Config.host: '127.0.0.1' | '0.0.0.0'` e `port: number`
(index.d.ts:43-46; zero = porta atribuída pelo SO). O `host` é uma **união de
literais**, não `string` — permite allowlists de bind exaustivas em compile-time
(ver `src/config/bind.ts`).

> **Nota de segurança medida.** DSH v0.1.0-rc.6 veio com RCE não autenticada pela
> sub-estação `/api` do plano de controlo web (discussão #853, `commands/execute`
> a injetar `/permission danger-full-access`; fuga do sandbox bwrap por
> `mount -o remount,rw /` em #1769). O caso real fecha essa superfície trocando o
> dono do `dispatch` no `node:http.Server` do `webServer` — o `registerFallback` é um
> sítio, mas não o único; o portão guarda a superfície inteira.

### 4.2 `ctx.subprocess` — `SubprocessRuntime` (dsh-subprocess)

*"execution-world executable lookup, fully specified managed process trees with
raw or collected stdio, and one terminal-process primitive"* (verified in
`types/dsh-subprocess/index.d.ts:15-16`).

| Método | Assinatura | Semântica |
| --- | --- | --- |
| `spawn` | `spawn(spec: SubprocessSpawnSpec): SubprocessHandle` | Arranca UM processo gerido a partir de um spec **completamente especificado**; *"this seam applies no defaults"*. |
| `spawnTerminal` | `spawnTerminal(spec): Promise<SubprocessTerminalHandle>` | Único primitivo de terminal real (PTY). |
| `resolveExecutable` | `resolveExecutable(cmd, env?, signal?): Promise<string>` | Relativo com separador é rejeitado (fail loud). |

Fonte: `types/dsh-subprocess/index.d.ts:100-135`. A classe
`SubprocessRuntime extends Service`; carregar duas implementações no mesmo
contexto **lança** (duplicate-service).

**O spec — o argumento de `spawn`** (verified in
`types/dsh-subprocess/types.d.ts:86-110`):

```ts
export interface SubprocessSpawnSpec {
  argv: readonly string[]          // argv[0] é o programa; NUNCA shell-interpreted
  cwd: string
  stdio: SubprocessStdio           // stdin: ignore|pipe|{data}; stdout/stderr: pipe|inherit|SubprocessCollect
  graceMs: number                  // janela da escalada terminate()
  signal?: AbortSignal             // dispara a escalada na árvore
  env?: NodeJS.ProcessEnv          // MESCLADO DEPOIS de scrubbedParentEnv()
}
```

**O handle** (verified in `types/dsh-subprocess/types.d.ts`):

```ts
interface SubprocessHandle {
  readonly done: Promise<SubprocessOutcome>   // resolve no close (exitCode/signal); rejeita só p/ spawn-level
  terminate(): void                            // SIGTERM → grace → SIGKILL, tree-scoped
  waitForExit(signal?: AbortSignal): Promise<boolean> // observa a árvore INTEIRA (netos incluídos)
  stdin / stdout(s) / stderr ···              // raw 'pipe' ou leitura offset-based (collect)
}
```

- `done` colapsa `'exit'` e `'error'` num só caminho — quem escuta só `'exit'` trava em
  `ENOENT` (ver `src/proc/failure.ts` no caso real).
- **`terminate()` é o único verbo de terminação** e é tree-scoped: em POSIX sinais
  ao grupo, em Windows `taskkill /T /F` por baixo. `process.kill(-pid)` manual é
  redundante e frágil (ver Anti-pattern).
- **`scrubbedParentEnv()`** é o ambiente-base canónico do filho: o ambiente do
  pai **menos** nomes com forma de credencial e menos todos os `DSH_*`. O `env`
  explícito do spec é mesclado **depois** da limpeza (verified in
  `types/dsh-subprocess/index.d.ts:56-71` e `src/proc/env.ts` no caso real).

> **`ctx.intercept` está refutado como mecanismo de envolver métodos do
> `webServer`.** No caso real foi *medida e refutada*: é fusão de config e inerte
> para este serviço. Para interceptar o tráfego, troca-se o dono do dispatcher no
> `node:http.Server` (`deepseek-harness-mobile/docs/ARCHITECTURE.md` §1). Não desenhes o plugin em cima de
> `ctx.intercept`.

---

## 5. Process hierarchy

O DSH corre num processo Node (o "host") e o teu plugin apanha processos filhos
através de `ctx.subprocess`. O padrão emergente no caso real é uma hierarquia de
três níveis:

```text
 host dsh (Node + Cordis)
   │  spawn(spec)  ── argv/cwd/stdio/grace/signal/env
   ▼
 worker (subprocesso no MESMO pacote npm do host)
   │  entrypoint resolvido por import.meta.url, NUNCA por cwd
   ▼ (opcional)
 binário de terceiros (ex.: cloudflared) — não coopera com dead-man's switch
```

Factos verificados no caso real (`src/proc/worker.ts`):

- **MESMO pacote npm.** O worker não é um pacote separado: é o entrypoint
  `dist/worker/telegram-bot.js` dentro do mesmo pacote, e o `argv` do spawn é
  `[command, PACKAGED_WORKER_ENTRYPOINT, ...args]` (`src/proc/worker.ts:154-170`).
- **Entrypoint por `import.meta.url`, nunca `cwd`.** O caminho não pode vir de um
  manifesto relativo (que resolveria contra o `cwd` do host, o workspace do
  utilizador). Vem do módulo que o resolve: `PACKAGED_WORKER_DIR =
  resolvePackagedWorkerDir(import.meta.url)` (verified in `src/config/schema.ts:264-267`).
- **O `argv[0]` é o programa** — `worker.command` / `process.execPath` (o MESMO Node
  do host), sem depender de `PATH` (`src/proc/worker.ts:165-170`).
- A separação tem uma razão de segurança estrutural: o worker fala com a internet
  e não pode partilhar o ambiente do plano de controlo do host. O ambiente do
  worker é **construído por allowlist** (`buildWorkerEnv`), nunca
  `{...process.env}` — senão `ADMIN_USER`/`ADMIN_PASS` do host vazam para o processo
  que consome input arbitrário da internet (`src/proc/env.ts:5-22`).

---

## 6. IPC channel — JSONL bidirecional sobre stdin/stdout

O canal host↔worker é **uma linha JSON por mensagem** sobre o `stdio` do filho.
Sem socket, sem porta, sem ficheiro. O `stdio` do spawn é
`{ stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }` — o `stdin` em `'pipe'` é a
mudança estrutural que cria o sentido host→worker e o dead-man's switch
(`src/proc/worker.ts:185-211`; contrato em `src/contracts/ipc.ts:68-126`).

### 6.1 O que o canal compra

1. **Sem superfície nova.** Um socket local seria mais uma porta para abrir/auditar.
2. **Dead-man's switch.** Se o host for morto com `SIGKILL`, o `stdin` do filho
   fecha; o worker deteta EOF e **termina sozinho**. **Atenção:** este mecanismo
   exige que o filho *coopere* (detete EOF e se mate). Para o `cloudflared`, um
   binário de terceiros que não coopera, o dead-man's switch **não serve**. O
   worker do caso real coopera, e isso é **medido**: SIGKILL no host → worker
   morto em < 2 s (`src/contracts/ipc.ts:41-53`).
3. **Segredos continuam fora do Telegram.** O que atravessa é uma intenção, nunca
   a credencial (invariante S3).
4. **Backpressure e recuperação explícitas.** Linha malformada é descartada sem
   derrubar o canal.

### 6.2 Invariantes S1–S6 (são contrato)

Verified in `deepseek-harness-mobile/src/contracts/ipc.ts` (cada uma tem um teste
com dono).

| Inv | Conteúdo |
| --- | --- |
| **S1** | Uma mensagem por linha, UTF-8, terminada em `\n`. Sem `\r`, sem pretty-print, sem `\n` em string por escapar. |
| **S2** | **Flow discipline.** The worker writes JSONL EXCLUSIVELY to `stdout`; any human log goes to `stderr`. It is the rule most often violated and fails silently. |
| **S3** | Nenhum segredo no payload: nem senha, nem digest, nem token de bot, nem `ott`, nem caminho absoluto. A URL do túnel PODE viajar. |
| **S3-b** | Exceção única e nomeada: o digest sha256 do código de pareamento de 6 dígitos pode viajar (espaço 10⁶, reversível em ms, TTL 5 min, impresso no terminal). Mas nunca sai da máquina. |
| **S4** | Linha malformada é descartada e o canal sobrevive (json-inválido, `v` desconhecido, `type` desconhecido, linha truncada). |
| **S5** | **O worker não valida nonce — estrutural.** O nonce é emitido/consumido no HOST; o worker transporta-o opaco. Um nonce validado no processo que fala com a internet é uma variável, não um controlo. |
| **S6** | A allowlist de identidade vive no WORKER; o nonce vive no HOST. Não trocam de lado: a allowlist tem de rejeitar antes de o update chegar ao canal. |

**Fluxo do canal** (diagrama):

```text
 host (fonte única da verdade)                worker (projeção do bot)
   │                                              │
   │  spawn(spec) ── stdin:pipe, stdout:pipe ──►  │
   │                                              │
   │  ◄──── state (seq monotónico; url só c/ READY)
   │  ──────► intent {intent, requestId, from, chat, nonce?}
   │  ◄──── ack {requestId, result, state, code?}  (SEMPRE emitido)
   │  ◄──── error {code, message}                  (S3-safe)
   │  ──────► nonce.request {acao, requestId}
   │  ◄──── nonce.issued {acao, requestId, nonce, expiresAt}
   │  EOF (host morto) ──┐
   │                     ▼ worker deteta EOF e termina (dead-man's switch)
```

O vocabulário de tipos em cada sentido é uma TÁBUA `type → handler`; tipos não
conhecidos caem em S4 (ver `worker/ipc.ts`, `LEGAL_TYPES`/`HANDLERS`). A versão de
protocolo é `IPC_PROTOCOL_VERSION` (verified in `src/contracts/ipc.ts`); versão
desconhecida → S4.

---

## 7. Contracts

### 7.1 `ControlIntent`

Uma intenção vinda de UMA superfície (bot, painel, UI nativa do DSH) — verified in
`deepseek-harness-mobile/src/contracts/control.ts:111-119`:

```ts
export type ControlAction = 'start' | 'stop' | 'reset'

export interface ControlIntent {
  readonly action: ControlAction
  readonly requestedBy: string      // ex.: 'telegram:123456' | 'panel:<id-hash>'
  /** ULID gerado pela superfície. CHAVE DE IDEMPOTÊNCIA (D29). */
  readonly requestId: string
  /** Nonce de confirmação, quando a ação o EXIGE (start/reset). OPCIONAL. */
  readonly nonce?: string
  /** epoch ms do relógio INJETADO (nunca Date.now direto). */
  readonly at: number
}
```

Semântica de leitura do contrato:

- **`requestId` REPETIDO devolve o resultado da primeira execução (idempotência
  por requestId)**; **`nonce` repetido é RECUSADO (CTL-020 vs CTL-021)**. A chave:
  *requestId deduplica; nonce autoriza* (verified in `src/contracts/control.ts:89-92`).
- Ações que REDUZEM exposição (`stop`, `emergency`) NÃO exigem nonce — em pânico
  o botão tem de funcionar à primeira. Ações que AUMENTAM (`start`, `reset`) exigem
  nonce (CTL-023/CTL-024).

### 7.2 Nonce de confirmação

Server-side no HOST, sem exceção. `NONCE_TTL_MS = 60_000`, uso único, 128 bits
CSPRNG em hex, opaco para quem o transporta — o worker não o lê nem valida (S5).
O serviço: `issue(action): Nonce` e `consume(nonce, action): boolean` — replay →
`false` (CTL-021), expirado → `false` (CTL-022) (verified in
`src/contracts/control.ts:145-167`). O caso real entrega o nonce ao worker via
mensagens `nonce.request`/`nonce.issued` (`src/contracts/ipc.ts`, EMENDA-COSTURA-5).

### 7.3 `pairing.owner`

O dono persistido no boot. **Não é segredo e não autoriza nada por si.** Serve para o
worker re-montar o receptor num reboot sem nova parelha (fechado, allowlist ativa,
`/parear` recusado) — *"NÃO é segredo (S3) e NÃO autoriza nada por si: quem valida
intents é o HOST (S6)"* (verified in `src/contracts/ipc.ts`, mensagem
`pairing.owner`).

---

## 8. Control state machine — os 6 estados NÃO são a Fiber

**Não confundir.** A §2 descreve a máquina de vida da **Fiber Cordis** (PENDING …
DISPOSED) — como o *plugin* é carregado/descarregado. Esta é a máquina de
**CONTROLO do que o plugin supervisiona** (o túnel/controlador), com 6 estados e
uma tabela de transições legais. São autómatos diferentes, e confundi-los é uma
das fontes de bugs mais frequentes.

```text
                STOPPED ───────────────────────────────┐
                  │  │ start()                         │
                  │  ▼                                 │
                  ▼  STARTING ──► READY                │
                  │    │    │        │                 │
             start()│    │    ▼        │                 │
     (pre só        │    │   fail   DEGRADED            │
      exposure)     │    │          │   │               │
                    │    │          │   │ retry c/       │
                    │    │          │   ▼ backoff       │
              FAILED│◄───┘          │  STARTING ◄───────┘
         ▲    ▲                       (re-tentativa)
         │    └─ erro não-retryable)  budget esgotado → FAILED
       reset()
    (única saída de FAILED)
```

Estados (vocabulário em inglês; os rótulos PT são só texto de UI) — verified in
`src/contracts/tunnel.ts:36-55`:

| Estado | Significado |
| --- | --- |
| `STOPPED` | Não há processo. Estado inicial e final feliz. |
| `STARTING` | `spawn` feito, URL ainda não obtida. |
| `READY` | URL obtida E readiness respondeu. Só aqui a URL é divulgada. |
| `DEGRADED` | Falhou e ainda há orçamento: re-tenta sozinho com backoff. |
| `STOPPING` | A derrubar: SIGTERM ao grupo → janela de graça → SIGKILL. |
| `FAILED` | **Terminal.** Orçamento esgotado ou erro não-retryable. Só com `reset()` explícito do dono. |

**A tabela de transições legais** (verified in `src/contracts/control.ts:59-74`)
é a fonte normativa. Pontos que surpreendem:

- `STOPPING` só sai para `STOPPED` — nunca para `FAILED`. Se a morte falhar, o
  supervisor faz SIGTERM → graça → SIGKILL e o estado PERMANECE `STOPPING` até o
  processo morrer (**fail-closed**: nunca se declara STOPPED um túnel que pode
  estar vivo).
- `FAILED` só sai por `reset()` explícito do dono — terminal e terminal.
- **Intents que não mudam de estado:** `start` em `STARTING`/`READY` é no-op
  idempotente; `stop` em `STOPPED` é no-op; **`start` em `STOPPING` é REJEITADO
  com `SHUTDOWN_IN_PROGRESS` e NUNCA enfileirado** (D29/CTL-007): enfileirar
  transforma o kill-switch numa operação de resultado incerto.
- Modo restrito ativo → `start` recusado; sem segredo forte → `start` recusado.

**Quem é o dono.** "O controlador serializa a máquina de estados do túnel
(ligar/desligar)" e as superfícies **nunca chamam o supervisor de túnel
diretamente** — somente o controlador (`deepseek-harness-mobile/docs/ARCHITECTURE.md` §4 item 5 e
`src/control/controller.ts`). Telegram, painel e UI são projeções que enviam
`ControlIntent` e recebem a difusão `state`/`ack`.

---

## 9. Module map + facade única

O caso real organiza o repositório para que **uma breaking change do host seja a
edição de UM ficheiro**: `src/dsh/adapter.ts` é o único ponto que importa
`@deepseek-ai/*`. Critério de aceite: a substância dos imports `@deepseek-ai/*`
vive em `src/dsh/adapter.ts` — as demais ocorrências do padrão em `src/` são
comentários JSDoc (verified in `src/dsh/adapter.ts:6-19`).

**Mapa de módulos** (resumo de `deepseek-harness-mobile/docs/ARCHITECTURE.md` §4):

| Área | Módulos |
| --- | --- |
| Raiz & contratos | `src/index.ts` (name/inject/apply), `src/brand.ts` (branded ids), `src/errors.ts`, `src/contracts/**` (congelados), `src/dsh/adapter.ts` (facade) |
| Config & estado | `src/config/{schema,assert,bind}.ts`; `src/state/{store,schema,paths}.ts` |
| HTTP / portão | `src/http/**` (gate, intercept, host-header, path, session-auth …) |
| Segredo/sessão/rate-limit/auditoria | `src/secret/**`, `src/session/**`, `src/ratelimit/**`, `src/audit/**` |
| Processos/túnel/controlo | `src/proc/**` (supervisor, env, tree-kill, backoff), `src/tunnel/**`, `src/control/**` |
| Painel & UI | `src/panel/**`, `src/ui-contrib/**` |
| Worker do bot | `worker/telegram-bot.ts`, `worker/ipc.ts`, `worker/auth/**`, `worker/commands/**`, `worker/lib/**` |

**Porque a facade única existe.** Se um símbolo do host sumir, o plugin **falha no
load** com a faixa testada na mensagem (não compara por string de versão). A
compatibilidade com o upstream é verificada por **forma** do serviço
(`deepseek-harness-mobile/docs/ARCHITECTURE.md` §5; `dsh-compat.yml` é a fonte de verdade regenerada em
`deepseek-harness-mobile/docs/COMPATIBILITY.md`). A superfície do host vem dos `.d.ts` byte-exatos
`types/**` apontados por `tsconfig.json` `paths`.

---

## 10. Composition & deployment

O DSH monta a instância por camadas de configuração com precedência fixa. A
premissa é *"whole-entry replace by id, NOT deep-merge"*: alvejar um `id` numa
camada substitui a ENTRADA INTEIRA da camada de baixo; não faz fusão de chaves.

| Camada | Origem | Precedência |
| --- | --- | --- |
| **1 — Bundle** | `package.json` → `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` | Mínima. Vem dos pacotes declarados como bundle, com `@deepseek-ai/dsh-base` à cabeça. |
| **2 — Profile** | `$DSH_HOME/profiles/<perfil>/cordis.patch.yml` | Intermédia. |
| **3 — Home** | `$DSH_HOME/cordis.patch.yml` | Alta. |
| **4 — Overlay** | `dsh --patch ./overlay.yml` | Absoluta (CLI, não persistente). |

Fonte: caso real `cordis.patch.yml:22-47` (que cita as 4 camadas) e o material 4.

**`dsh.bundle.patch` — o mecanismo de ativação REAL.**
`bundle: {}` **NÃO ativa nada**. Por medição contra `@deepseek-ai/dsh@0.1.0-rc.7`
num `$DSH_HOME` limpo (caso real, `package.json` — comentário `//dsh`): o gate do
registo `awesome-dsh-plugin` aceita `dsh.bundle` VAZIO, mas o produto não — o
loader decide a ativação por `dsh?.bundle?.patch !== void 0`, e o
`dsh-app-boot` **LANÇA no boot** se um bundle listado não declarar `.patch`.
Declarar `bundle: {}` passa no exame e reprova na vida: `dsh plugin add` não ativa
nada.

Portanto o **manifesto correto** é (caso real `package.json`):

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

O patch de bundle tem **uma** operação: `insert` da própria linha do plugin
(`id: guarded-bot-orchestrator`; o caminho de ficheiro pode usar `!!js` se
precisares de resolver em runtime). Regras de ouro (verified in `cordis.patch.yml:49-90`):

- **Nunca rebentar no carregamento.** O manifesto é aplicado automaticamente a
  toda a gente que instala; uma expressão `!!js` que lança → `dsh` que não arranca.
- **Em `insert`, nunca alvejar `id` de outra camada.** Colisão de `id` produz DUAS
  linhas com o mesmo id sem aviso (exit 0) — uma segunda instância de um serviço
  a nascer; um override com id que não casa é SALTADO em silêncio (fail-open).
- **Ordem de linhas NÃO existe.** `@deepseek-ai/dsh-base@0.1.0-rc.7/cordis.patch.yml:12-13`:
  *"Row order carries no load semantics (activation is service-availability
  driven)"*. A ativação é conduzida pela disponibilidade de serviço
  (`inject: ['webServer']`).

**Vendoring de `@deepseek-ai/*`.** O DSH vende o Cordis e auxiliares para o escopo
protegido `@deepseek-ai` (ex.: `@deepseek-ai/cordis`); o `pnpm-workspace.yaml` força a
resolução para essas fontes locais — evita sequestros e colisões (material 3). Quem
escreve um plugin referencia esses nomes como se fossem os oficiais; o tsconfig
`paths` do caso real espelha os `.d.ts` publicados.

**Distribuição e dependências.** O caso real não tem dependência de runtime do
host além de `grammy` (cliente do Telegram); tudo o que é do DSH fica em
`devDependencies`/`peerDependencies` (ver `package.json`). O padrão seguro: o host
entra por **peerDependency** `@deepseek-ai/cordis >=4.0.0 <5` (peer REQUERIDO) e a
superfície vem dos `.d.ts` baixados em build-time (`scripts/fetch-dsh-types.mjs`).

---

## 11. Anti-patterns

O que **NÃO** fazer — todos medidos/verificados contra o caso real ou os tipos
publicados (faixa `0.1.0-rc.7 .. 0.1.1-rc.1`).

1. **`httpServer` / `HttpServerService` — obsoleto.** O serviço chama-se `webServer`
   e a classe `WebServer`. `httpServer`/`HttpServerService` só existiram em
   `0.0.1-rc.1/rc.2`, uma linha morta com tag `latest` estagnada (verified in
   `src/dsh/adapter.ts:20-26`).
2. **`spawn(cmd, args, opts)` — assinatura errada.** A costura é
   `ctx.subprocess.spawn(spec)` com **um único objeto** `SubprocessSpawnSpec`
   (argv/cwd/stdio/grace/signal/env), *"this seam applies no defaults"* (verified in
   `types/dsh-subprocess/index.d.ts:112-122`).
3. **Deep-merge em qualquer camada.** A composição substitui a ENTRADA INTEIRA por
   `id`; não funde chaves. Alvejar um id apaga as chaves da camada de baixo.
4. **`bundle: {}` para "ativar".** Não ativa. Precisa de
   `"dsh": { "bundle": { "patch": ... } }`; sem `.patch`, o `dsh-app-boot` lança.
5. **Disposer async sem necessidade.** O host tolera async, mas o caso real adota
   disposers SÍNCRONOS por regra; async complica a ordem LIFO e o derrube atómico.
6. **Worker validar `nonce`.** Estruturalmente proibido (S5). O nonce é
   emitido/consumido no HOST; o worker só o transporta opaco. O mesmo vale para
   `callback_data`: nunca é prova de autorização (1-64 bytes dados pelo cliente).
7. **`0.0.0.0` no bind.** O `host` é `'127.0.0.1' | '0.0.0.0'` (união de literais).
   Um bind `0.0.0.0` expõe o plano de controlo à rede; o caso real tem allowlist
   de bind exaustiva e guarda a superfície inteira por causa da RCE #853.
8. **`child.kill()` sozinho ("nunca basta com shell intermediário").** O único
   verbo de terminação é `SubprocessHandle.terminate()`, tree-scoped
   (SIGTERM→grace→SIGKILL). Confiar em `process.kill(-pid)` sozinho falha quando um
   shell intermediário/não-grupo existe.
9. **`ctx.intercept` como envolvedor de métodos do `webServer`.** Medido e
   refutado — é fusão de config, inerte para este serviço. Intercepta trocando o
   dono do dispatcher no `node:http.Server`.
10. **Resolução por `cwd` em vez de `import.meta.url`.** O entrypoint do worker
    (ou qualquer ficheiro do pacote) resolve por `import.meta.url`, nunca por
    `cwd` do host (o workspace do utilizador).

---

## 12. Verified sources

**Materiais da skill (lidos na íntegra; claims não verificadas ao vivo foram
descartadas no texto):**

- `/home/ondokai/Documents/deepseek-harness/Análise do DeepSeek Harness.md`
- `/home/ondokai/Documents/deepseek-harness/Guia de Contribuição e Desenvolvimento para o DeepSeek Harness.md`
- `/home/ondokai/Documents/deepseek-harness/Guia Definitivo e Catálogo de Plugins do DeepSeek Harness.md`
- `/home/ondokai/Documents/deepseek-harness/Plugin Cordis DeepSeek Harness.md`

**Caso real (fonte primária do comportamento API):**
`/home/ondokai/Projects/deepseek-harness-mobile`

- `src/contracts/ipc.ts` — canal JSONL, invariantes S1–S6, vocabulário de mensagens.
- `src/contracts/control.ts` — `ControlIntent`, `TRANSICOES_LEGAIS`, `NONCE_TTL_MS`, `ConfirmService`.
- `src/contracts/tunnel.ts` — `TunnelState`, `TunnelInfo`, `TunnelFailureCode`, `ProbeId`.
- `src/dsh/adapter.ts` — facade única; `declare module '@deepseek-ai/cordis' { interface Events }`.
- `src/index.ts` — `inject = ['webServer','subprocess']`, ordem dos `ctx.effect`.
- `src/proc/worker.ts`, `src/proc/env.ts`, `src/proc/supervisor.ts`, `src/proc/tree-kill.ts`.
- `worker/ipc.ts`, `worker/telegram-bot.ts`, `worker/auth/**`.
- `types/dsh-host-webserver/index.d.ts` — API do `WebServer` (byte-exato do tarball).
- `types/dsh-subprocess/index.d.ts` + `types.d.ts` — `SubprocessRuntime`, `SubprocessSpawnSpec`, `SubprocessHandle`, `scrubbedParentEnv`.
- `types/cordis/fiber.d.ts` — `FiberState`, semântica de disposers.
- `deepseek-harness-mobile/docs/ARCHITECTURE.md` — mapa de módulos, relação com upstream.
- `package.json` — `dsh.bundle.patch`, dependências (só `grammy` runtime).
- `cordis.patch.yml` — 4 camadas, whole-entry replace, row-order não-semântica.
- `dsh-compat.yml` — faixa `0.1.0-rc.7 .. 0.1.1-rc.1`.

**URLs oficiais / públicas:**

- `https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md`
- `https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/02-lifecycle-and-effects.md`
- `https://github.com/deepseek-ai/deepseek-harness/blob/master/CONTRIBUTING.md`
- `https://github.com/deepseek-ai/deepseek-harness/blob/master/AGENTS.md`
- `https://github.com/deepseek-ai/deepseek-harness/discussions/853` (RCE não autenticada, verificada em 0.1.0-rc.6)
- `https://github.com/deepseek-ai/deepseek-harness/discussions/1769` (escape bwrap)
- `https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/webserver/README.md`
- `https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/webserver/src/index.ts`
- `https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/lsp/lsp-stdio/README.md`

---

## Appendix — Honesty filter coverage (community claims to avoid)

| Claim comum | Veredito |
| --- | --- |
| "limit Zero Trust free = 50 usuários" | **refuted / [UNVERIFIED]** — não ensinado como verdade. |
| "benchmarks do jcode" | **refuted / [UNVERIFIED]** — números não confirmados; nenhum benchmark no texto. |
| "pacote `pi2dsh`" | **refuted / não-confirmado** — não usado como fonte. |
| "quick tunnel não suporta SSE" | **refuted / não-confirmado** — o caso real transfere SSE para WebSocket por outras razões (limite de 6 conexões HTTP/1.1), não por o quick tunnel "não suportar SSE". |
| "token do bot contorna allowlist" | **refuted** — a allowlist vive no worker (S6) e o host revalida. |
| "`drop_pending_updates` é parâmetro de `getUpdates`" | **refuted** — não está em `getUpdates`. |
| "ASVS 5.0 §6.5.2 autoriza SHA-256 em vez de Argon2 p/ tokens 128-bit" | **refuted** — não usado como autorização. |
| "URLs de quick tunnel indexadas por buscadores" | **refuted / [UNVERIFIED]** — não afirmado. |
| "`child.kill()` nunca basta com shell intermediário" | **assim é** — usado como anti-pattern (§11.8), `terminate()` é o verbo certo. |
| "cookie Secure não funciona em http://127.0.0.1" | **refuted / fora de escopo** — não afirmado. |
| "existe campo de compatibilidade no package.json" | **refuted** — a compatibilidade é via `dsh-compat.yml` (regenerado em deepseek-harness-mobile/docs/COMPATIBILITY.md), não campo mágico; o package.json usa `dsh.bundle.patch`. |
| "plugin tem N dependências de runtime no host" / "zero dependências" | **[UNVERIFIED]** — depende; o caso real tem só `grammy`. Não generalizar. |
| "`dsh.bundle.patch` real; `bundle:{}` NÃO ativa" | **assim é** — §10, medido contra 0.1.0-rc.7. |
