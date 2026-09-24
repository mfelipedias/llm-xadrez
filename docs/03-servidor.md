# 03 — Servidor: estado, REST, WebSocket, persistência

## Configuração (`server/src/config.ts`, lê `.env`)

| Variável | Default | Descrição |
|----------|---------|-----------|
| `PORT` | `3939` | porta única para UI, API, WS e MCP |
| `HOST` | `127.0.0.1` | `0.0.0.0` para acessar de outro dispositivo na rede |
| `DATA_DIR` | `./data` | persistência |
| `LANG` | `pt-BR` | idioma dos textos gerados para a LLM. Qualquer valor começando com `en` vira `en`; o resto vira `pt-BR` (no Git Bash a variável do sistema pode vir como `en_US.UTF-8`) |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` \| `silent` |
| `MCP_TOKEN` | (vazio) | se definido, `/mcp` exige o token: `Authorization: Bearer <token>` ou `?token=<token>` na URL. Também serve de token de administração quando `ADMIN_TOKEN` está vazio |
| `ADMIN_TOKEN` | (vazio) | token das rotas de administração de provedores (`Authorization: Bearer`). Vazio = usa o `MCP_TOKEN` |
| `ADMIN_ALLOW_FROM` | (vazio) | IPs/CIDRs, separados por vírgula, que administram **sem** token, além do loopback. O compose usa `172.16.0.0/12` (a ponte do Docker) |
| `ALLOWED_HOSTS` | (vazio) | hosts extras aceitos no header `Host` (túnel, IP/nome na rede). `.dominio`/`*.dominio` = domínio e subdomínios; `*` desliga a verificação |
| `RUNTIME` | detectado | `docker` ou `node`. Sem valor, `/.dockerenv` indica Docker. Vai para `ServerInfo.runtime` (snippets e dicas de rede na UI) |
| `HUMAN_NAME` | `Você` | nome padrão do humano |
| `PUBLIC_URL` | (vazio) | URL pela qual os clientes alcançam o servidor: é o que se anuncia (banner, `/api/health.mcpUrl`, UI) e o host dela entra na lista de hosts aceitos. Vazio = `http://localhost:PORT`. Use no Docker com outra porta no host ou atrás de túnel |

`BIND_ADDR` não é lida pelo servidor: é do `docker-compose.yml` (endereço do host onde a
porta é publicada, default `127.0.0.1` — docs/08).

Bots do servidor (docs/09). Nada aqui é obrigatório: sem provedor configurado o projeto
funciona exatamente como antes, só com sessões MCP.

| Variável | Default | Descrição |
|----------|---------|-----------|
| `PROVIDERS_FILE` | `./providers.json` | provedores e perfis de bot. Caminho relativo resolve a partir da raiz do repositório. Se o arquivo não existir, o registry usa os **presets embutidos** em memória (`openrouter`, `anthropic`, `lmstudio`, `ollama`) e avisa no log |
| `BOT_AUTORESUME` | `true` | ao subir, recria os bots que estavam no `current-game.json` e volta a jogar. Provedor sumiu da config ou ficou sem chave → o assento vira `empty` mantendo o nome. `0`/`false`/`no`/`off` desliga |
| `BOT_DEFAULT_PROFILE` | (vazio) | id do perfil sugerido na UI. Vazio = o `defaults.profileId` do `providers.json` |
| `BOT_FAKE_PROVIDER` | `false` | `1` injeta no registry o provedor determinístico `fake` (modelo `fake-1`), que joga de um livro de aberturas sem rede e sem custo. É o que `npm run smoke:bot` usa. **Não ligue em produção** |
| `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `LITELLM_API_KEY`, … | (vazio) | as chaves de API. Elas vivem **só no ambiente**; o `providers.json` guarda apenas o *nome* da variável, em `apiKeyEnv`. Nenhuma rota aceita ou devolve uma chave (ver "Provedores", abaixo) |

## Três tipos de ocupante

Um assento é `human` (navegador), `mcp` (sessão MCP externa), `bot` (o próprio servidor
falando com um provedor de LLM — docs/09) ou `empty`. Para o `GameStore` os dois últimos
tipos de "agente" são a mesma coisa: têm `sessionId`, recebem eventos na fila e esperam a
vez. `isAgentSeat(seat)` é o predicado que os junta. O store **não sabe o que é um
provedor de LLM**: quem sabe é o `BotManager`.

## GameStore (`server/src/game/store.ts`)

Classe singleton, `EventEmitter`. Responsabilidades:

- Manter `GameState` (ver `shared/types.ts`) e uma instância `Chess` (chess.js) sincronizada.
- Métodos (todos síncronos exceto `waitForTurn`), cada um valida e lança `GameError`
  (`code`, `message`, `legalMoves?`) em caso de regra violada:
  - `newGame(opts: { seats: { white: SeatInit, black: SeatInit }, startFen? })`
  - `seat(color, seat: Seat)` / `unseat(color)` / `seatForSession(sessionId): Color | null`
  - `applyMove(color, move: string, opts?: { comment?, commentCategory? }): MoveRecord`
  - `takeback(plies, by)` — usa `chess.undo()`; recalcula tudo; limpa highlight e `drawOffer`;
    reabre uma partida terminada pelo tabuleiro (mate etc.), mas não uma encerrada por
    desistência/empate/aborto.
  - `addComment(author, text, category, highlight?)` — se vier `highlight`, também vira o
    `state.highlight` atual (`ply` = ply atual). Cap de 500 comentários.
  - `setHighlight(by, spec | null)` — **não** é chamado ao jogar: o destaque fica no estado com
    o `ply` em que foi criado e a UI o esconde quando `highlight.ply !== state.ply`.
  - `addHumanMessage(text, to)` / `pendingMessages(color)` / `markDelivered(color)` — as
    mensagens ficam em `humanMessages` mesmo depois de entregues (`deliveredTo` diz a quem),
    cap de 100; `markDelivered` também remove o evento `message` da fila da cor.
  - `endGame(reason, by?)`, `offerDraw(by)` (ver `POST /api/draw`)
  - `waitForTurn(color, timeoutMs, { signal?, sessionId? }): Promise<TurnEvent>`
  - `joinGame({ sessionId, color?, name?, force? })`, `unseat(color)` (mantém o `name` no
    assento vazio), `seatForSession`, `touchSession`, `sessionOpened/Closed`, `isSessionOpen`
  - `serverInfo(version, mcpUrl): ServerInfo` — `mcpSessions[]` com `seat`, `name`,
    `lastSeenAt`, `waiting` (true enquanto há um waiter dessa sessão) e `active` (waiter
    pendente ou requisição nos últimos 120 s). A UI só conta sessões com `active !== false`.
  - `seatsWaitingForAgent()` — assentos livres esperando uma LLM: o que `join_game` sem
    `color` escolhe e o que faz `new_game` exigir `confirm`.
  - Retomada de assento: uma sessão `mcp` é "ida" se foi fechada ou está ociosa há mais de
    **5 min** (`DEFAULT_SESSION_IDLE_MS`) **sem** waiter pendente — quem está em
    `wait_for_turn` nunca é ociosa. Nome igual não retoma assento de sessão viva. **Sessões
    sintéticas de bot não entram nessa lista** (a UI mostraria "sem conexão"): o estado
    delas vai em `seat.bot` e em `ServerInfo.bots`.
  - `updateBot(color, patch): BotSeatInfo | null` — mexe só em `seat.bot` e emite **apenas**
    `bot`, sem `change`: mudança de status/uso de um bot não reenvia o estado inteiro.
  - `botSeats(): Record<Color, BotSeatInfo | null>` e `botSessionId(color)`
    (`bot:<cor>:<hex>`, o id da sessão sintética).
  - `isYourTurn(color)` — usado pelo loop do bot para decidir o fallback de lance.
  - `getState(): GameState` (cópia imutável / estrutura serializável, com cache)
- Filas de eventos por assento: `Map<Color, TurnEventType[]>` + lista de `waiters`
  (`{ color, resolve, timer }`). `pushEvent(color, type)` acorda o waiter dessa cor.
  `waitForTurn` primeiro drena a fila; se vazia e não é a vez, registra waiter.
  "É a sua vez e o oponente está sentado" também conta como evento imediato (`your_turn`).
- Emite `change` após qualquer mutação → `ws.ts` faz broadcast; `persist.ts` salva
  (debounce 100 ms) em `DATA_DIR/current-game.json`. Também emite `server` (sessões,
  `lastSeenAt`, waiters), `bot` (status/uso de um assento bot) e `archive` (PGN a gravar).
- Ao iniciar, carrega `current-game.json` se existir (assentos `mcp` viram `empty` porque
  as sessões morreram, mantendo o nome; humano permanece; assentos `bot` sobrevivem com
  `status: "stopped"` quando `BOT_AUTORESUME` está ligado, e o `BotManager` os religa).
  Ao criar a nova partida via MCP
  (`new_game`), a sessão criadora **não** recebe o evento `new_game`.
- Ao terminar ou substituir uma partida com ≥ 2 lances, grava `DATA_DIR/games/<id>.pgn`
  com headers `Event`, `White`, `Black`, `Date`, `Result`, e os comentários como `{...}`
  no PGN (chess.js suporta `setComment`).

## Regras (`server/src/game/rules.ts`)
Funções puras sobre `Chess`:
- `parseMove(chess, input)`: normaliza (`0-0`→`O-O`, remove `+`/`#`, tenta SAN, depois
  UCI `from/to/promotion`, depois case-insensitive) e devolve o `Move` do chess.js ou `null`.
- `legalMoves(chess): LegalMove[]`, `pieces(chess): PieceOnSquare[]`,
  `captured(history): CapturedPieces`, `materialBalance(pieces)`, `endState(chess)`.

## Formatador (`server/src/game/format.ts`)
`formatStateForLLM(state, perspective: Color | null, opts?)` conforme docs/02.
`formatTurnEvent(event, state, perspective)` prefixa o evento ("O oponente jogou 12. Bxf7+
(bispo captura peão em f7, xeque!)") e depois o estado.

## Bots do servidor (`server/src/bots/`)

Plano completo em [docs/09](09-plano-provedores-gateway.md). Em uma frase: **um bot ocupa
um assento como qualquer jogador** — o servidor registra uma sessão sintética
(`bot:<cor>:<hex>`), senta com `kind: "bot"` e roda um loop que espera o evento em
`store.waitForTurn`, chama um provedor de LLM e executa as tools **direto** nas funções de
`mcp/tools.ts`. Não há `McpServer` nem transporte em memória: as tools já são funções puras.

```
bots/
├── player.ts    BotPlayer: o loop de uma cor (espera → pensa → age), retries, fallbacks
├── manager.ts   BotManager: um BotPlayer por cor; resolve perfil/provedor/modelo; sit/stop/resume/leave
├── prompt.ts    prompt de sistema (papel, nível, idioma) — estável durante a partida, para cache de prefixo
├── toolset.ts   as 5 tools que o bot expõe + dispatcher validado pelos mesmos schemas zod do MCP
├── textmode.ts  modo "texto estruturado" e o parser tolerante de "MOVE: … / COMMENT: … / ARROWS: …"
├── budget.ts    orçamento por partida (chamadas, tokens, custo, lances ilegais)
└── providers/   types.ts · openai-compat.ts · anthropic.ts · registry.ts · fake.ts
```

### O que o bot expõe à LLM

Só um subconjunto das tools de [docs/02](02-contrato-mcp.md): `make_move`, `comment`,
`highlight`, `get_state` e `end_game` (este sem `abort` — só o humano aborta). Fora numa
rodada de resposta a mensagem ou de fechamento de partida, em que sobram `comment`,
`highlight` e `get_state`. **Não existem** `wait_for_turn`, `new_game`, `join_game`,
`leave_game` nem `takeback` para um bot: quem cuida disso é o servidor. Os JSON Schemas
saem dos mesmos shapes zod do MCP (`z.toJSONSchema`), então não há duas descrições de
argumento no projeto.

### Provedores (`bots/providers/`)

`ChatProvider` é uma abstração neutra — uma chamada = **uma rodada** de chat, o loop fica
no `BotPlayer` — e nada nela conhece xadrez ou guarda chave.

- **`openai-compat.ts`** — um adaptador para tudo que fala `/chat/completions`, com `fetch`
  nativo (sem o pacote `openai`): OpenRouter, Ollama, LM Studio, LiteLLM, vLLM,
  llama.cpp, Jan e qualquer gateway custom. As diferenças entre eles são **flags na
  config**, não detecção: `toolChoice` (false no Ollama), `parallelToolCalls`,
  `extraHeaders`, `extraBody`, `modelsPath`/`modelsQuery`, `timeoutMs`. Trata o que os
  servidores locais fazem de estranho: `arguments` como string JSON malformada, ids de tool
  call ausentes (vira `call_<n>`) e `<think>…</think>` no conteúdo.
- **`anthropic.ts`** — Messages API pelo `@anthropic-ai/sdk`, carregado por **import
  dinâmico** (quem não usa provedor `kind: "anthropic"` nunca paga o custo). `system` com
  `cache_control`, `thinking: { type: "adaptive" }` + `output_config: { effort: "low" }`
  nos modelos que aceitam, `tool_choice: "auto"` sempre, `max_tokens` 4096, e todos os
  `tool_result` de uma rodada numa única mensagem `user`. **`temperature` é descartada nos
  modelos 4.7+/5**, que devolvem 400 para parâmetros de amostragem. O custo é **estimado**
  por tabela local de preços: a API não devolve valor.
- **`registry.ts`** — presets embutidos, leitura/escrita de `providers.json`, resolução da
  chave a partir do ambiente (mascarada para a UI), cache de `listModels` (5 min) e do
  último `test`. Invariante: `ProviderConfig` **não tem campo de chave**, e o que sai para
  a API é `ProviderPublic` (`hasApiKey` + `apiKeyMasked`).
- **`fake.ts`** — provedor determinístico: lê a lista "Lances legais" da própria mensagem
  de estado e joga de um livro de aberturas curto. É o que roda nos testes e no
  `npm run smoke:bot` sem `--provider`.

### Dois modos de falar com o modelo

`toolMode: "native"` usa tool calling de verdade. `"text"` manda o estado e pede uma
resposta em linhas (`MOVE:` / `COMMENT:` / `ARROWS:`), para modelos pequenos que ignoram
`tools` ou devolvem JSON quebrado; um parser tolerante extrai o lance casando os tokens
contra a lista de lances legais. `"auto"` começa nativo e **cai para texto se a primeira
rodada de lance não trouxer `tool_calls`**. O mesmo parser é a rede de segurança do modo
nativo: se um modelo com tools responder só texto contendo um lance legal, o bot aproveita
em vez de gastar outra rodada.

### Orçamento e fallbacks

Por partida, zerado a cada `new_game`: `maxUsdPerGame` **1,00** (só conta em provedor
pago), `maxTokensPerGame` **400.000** e `maxIterationsPerTurn` **6** — sobrescrevíveis por
perfil em `providers.json`. Estourou: o bot para com `status: "budget_exceeded"` e publica
um comentário de sistema; "Retomar" na UI zera o contador.

Quando o modelo não consegue jogar (lances ilegais seguidos, resposta sem lance, tempo da
rodada esgotado — 120 s, 300 s em provedor local), vale `defaults.onMoveFailure`:
`pause` contra humano (assento vai para `error`, a UI oferece "Retomar") e `random_legal`
contra outro bot (joga um lance legal ao acaso e explica no feed). Erros 401/402/403/404
do provedor são fatais: param o loop com um aviso no feed. 429 e 5xx entram em backoff
exponencial com jitter (até 4 tentativas, teto de 30 s), respeitando `retry-after`.
Partida de bot vs bot para sozinha em 300 meios-lances.

### API REST — provedores

Todas sob `/api/providers`. Sem camada de provedores, respondem `503`.

| Método | Rota | Resposta / efeito |
|--------|------|-------------------|
| GET | `/api/providers` | `ProvidersResponse`: `{ providers, profiles, presets, envKeys, canAdmin, adminTokenAccepted }` — **nunca** a chave. `envKeys` são só os **nomes** das variáveis com cara de chave presentes no ambiente (exceto `MCP_TOKEN`/`ADMIN_TOKEN`); `canAdmin` diz se *este* pedido poderia gravar |
| PUT | `/api/providers/:id` | **cria ou atualiza** (`ProviderUpsert`). `id` casa `/^[a-z0-9][a-z0-9_-]{0,39}$/`. `null` ou `""` limpa `baseUrl`/`apiKeyEnv`/`timeoutMs`. Validação: `kind` `openai`\|`anthropic` (OpenAI exige `baseUrl`); `baseUrl` `http(s)` sem `usuário:senha@` (barras finais removidas); `apiKeyEnv` casa `/^[A-Z_][A-Z0-9_]*$/`, termina em `_API_KEY`/`_KEY`/`_TOKEN` e não é `MCP_TOKEN`/`ADMIN_TOKEN`; `timeoutMs` 1000–600000; nome vazio vira o id. `400` se o corpo trouxer `apiKey`/`key`/`token`/`authorization` ou `extraHeaders`. Responde o `ProviderPublic` |
| POST | `/api/providers/preset` | `{ preset, id? }` → adiciona um preset embutido. Sem `id`, escolhe um livre (`ollama-2`…) em vez de `409`; com `id` repetido, `409`. Responde o `ProviderPublic` |
| DELETE | `/api/providers/:id` | remove. `409` se um bot da partida atual usa esse provedor; `404` se não existe |
| POST | `/api/providers/:id/test` | `ProviderTestResponse`: `{ ok: true, latencyMs, models? }` ou `502 { ok: false, error, hint? }`. Timeout de 10 s. `hint` é uma dica acionável em pt-BR, ciente do Docker (`host.docker.internal`, `OLLAMA_HOST=0.0.0.0`, "Serve on Local Network", `extra_hosts`…) |
| GET | `/api/providers/:id/models` | `ModelInfo[]`, cache de 5 min; `?refresh=1` força. Timeout de 20 s; falha = `502 ApiError { error, hint? }` |

Todas menos o `GET /api/providers` são de **administração** (`requireAdmin()`), aceitas:
do loopback e dos IPs/CIDRs de `ADMIN_ALLOW_FROM` **sempre** (mesmo com token definido);
de qualquer outro endereço, só com `Authorization: Bearer <ADMIN_TOKEN>` (ou `MCP_TOKEN`
se `ADMIN_TOKEN` está vazio; comparação em tempo constante). Recusa: `403 ApiError { error,
code: "admin_forbidden", adminTokenAccepted }` — com `adminTokenAccepted` a UI pede o token
e repete; sem ele, explica o `.env`. O teste e a listagem são administrativos porque fazem o
servidor abrir conexões para a `baseUrl` configurada.

Provedor **local** (não exige chave): `baseUrl` em loopback, rede privada ou link-local
(`10/8`, `172.16/12`, `192.168/16`, `100.64/10`, `169.254/16`), `*.local`, `*.lan`,
`*.internal`, `*.home.arpa`, `host.docker.internal` ou nome sem ponto (serviço do compose)
— salvo `local: false` explícito.

**Não existe CRUD de perfis de bot** (`/api/profiles`): perfis
se editam no `providers.json`, ou se escolhe `providerId` + `model` direto no pedido de
assento.

### API REST — assentos de bot

| Método | Rota | Body | Resposta / efeito |
|--------|------|------|-------------------|
| POST | `/api/bots/:color/sit` | `{ profileId? , providerId?, model?, name?, role?, level? }` | senta um bot num assento livre da partida atual (equivalente a `join_game`). `409` se o assento é do humano ou de uma sessão MCP viva |
| POST | `/api/bots/:color/stop` | — | aborta a rodada em curso (nenhuma tool tardia é executada) e deixa o assento em `status: "stopped"` |
| POST | `/api/bots/:color/resume` | `{ profileId? \| providerId? + model? }` | retoma; com perfil/modelo no corpo, **troca de modelo**. Zera o contador de gasto se o assento estava em `budget_exceeded` |
| POST | `/api/bots/:color/leave` | — | libera o assento (`empty`, mantendo o nome), como `leave_game` |

Todas respondem o `GameState`. `400` para pedido incompleto ("exige `profileId` ou
`providerId` + `model`") ou provedor sem chave; `404` se não há bot na cor; `503` num
servidor sem bots internos.

## API REST (`server/src/http/api.ts`) — usada pelo navegador

Todas as rotas respondem JSON. Erros: `4xx` com `ApiError`.

Todos os `POST` abaixo respondem com o `GameState` resultante (o navegador ignora esse
corpo e se atualiza pelo broadcast WebSocket, que chega antes/junto; o corpo serve para
scripts e depuração).

| Método | Rota | Body | Resposta / efeito |
|--------|------|------|--------|
| GET | `/api/health` | — | `{ ok: true, version, mcpUrl, mcpSessions[] }` (`mcpSessions` = `ServerInfo.mcpSessions`, com `waiting` e `active`) |
| GET | `/api/state` | — | `GameState` |
| POST | `/api/game` | `NewGameRequest` | `GameState`. Ver abaixo |
| POST | `/api/move` | `MoveRequest` | `GameState`. Lance pelo assento humano da vez. 400 se a partida não está `active`, se não é vez de humano ou se o lance é ilegal (`legalMoves` no erro) |
| POST | `/api/message` | `MessageRequest` | `GameState`. `to` inválido vira `all`. Gera evento `message` só para assentos `mcp` |
| POST | `/api/takeback` | `TakebackRequest` | `GameState`. Sem `plies` (é o que a UI manda): volta até a posição anterior ao último lance humano (`history[].by === "human"`); 400 se não há lance humano. Gera `takeback` para as LLMs |
| POST | `/api/resign` | `ResignRequest` | `GameState`. `color` obrigatório só se o humano ocupa os dois assentos; senão usa o único assento humano |
| POST | `/api/draw` | `{ color? }` | `GameState & { drawAccepted: boolean }`. Se já há oferta do oponente: aceita (empate imediato, `drawAccepted: true`). Senão registra `drawOffer`, publica comentário de sistema "X oferece empate." e manda uma `HumanMessage` à LLM oponente pedindo `end_game(how: "draw")` para aceitar |
| POST | `/api/highlight/clear` | — | `GameState` com `highlight: null` |
| GET | `/api/pgn` | — | `text/plain` PGN da partida atual (`Content-Disposition: attachment`) |
| GET | `/api/games` | — | lista `[{ id, date, white, black, result }]` de `data/games` |
| GET | `/api/games/:id/pgn` | — | PGN antigo |

### `POST /api/game`: dois contratos

O corpo aceita **`seats`** (novo, docs/09) ou **`humanSeats`** (legado). Se os dois vierem,
`seats` vence.

- **`seats: { white: SeatRequest, black: SeatRequest }`** — um pedido por assento:
  `{ kind: "human", name? }`, `{ kind: "mcp", name? }` (a sessão MCP viva daquela cor
  continua sentada; senão o assento nasce vazio esperando `join_game`),
  `{ kind: "bot", profileId? | providerId? + model?, name?, role?, level? }` ou
  `{ kind: "empty" }`. É o que o diálogo "Nova partida" manda hoje.
- **`humanSeats: "white" | "black" | "both" | "none"`** — o contrato antigo, que continua
  valendo: **sessões MCP com conexão aberta continuam sentadas** na nova partida (na cor
  livre; com `none`, as duas) e recebem o evento `new_game`; sessões mortas viram `empty`.
  Valor inválido cai em `white`.

Em ambos, `humanName` vazio usa `HUMAN_NAME` e `startFen` é opcional. Um assento `bot`
que já estava na cor **com o mesmo provedor/modelo/perfil** é reaproveitado (continua
sentado e recebe `new_game`, com o orçamento zerado); qualquer outra coisa faz o bot
anterior parar.

## WebSocket (`server/src/http/ws.ts`) — rota `/ws`
- Ao conectar: envia `{ type: "hello", state, server }`.
- A cada `change`: `{ type: "state", state }` para todos.
- A cada sessão MCP aberta/fechada, `lastSeenAt` mudando ou waiter de `wait_for_turn`
  entrando/saindo (`waiting`): `{ type: "server", server }` (throttle 500 ms). O
  `ServerInfo` leva também `providers` (públicos), `profiles` e `bots`, para a UI não
  precisar de um fetch inicial.
- A cada `updateBot`: `{ type: "bot", color, bot }` — status, texto curto, `thinkingSince`
  e uso de um assento de bot, **sem reenviar o estado inteiro**. Vai imediatamente, sem
  throttle: quem evita o barulho é o `BotPlayer`, que só chama `updateBot` quando algo
  mudou de verdade.
- Ping/pong a cada 30 s. O cliente reconecta com backoff (1 s → 10 s).

## MCP (`server/src/mcp/`)
- `transport.ts`: rota `/mcp` (POST/GET/DELETE) seguindo o exemplo
  `jsonResponseStreamableHttp` do SDK: `Map<sessionId, transport>`; em `initialize` cria
  `new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized })`
  e um `McpServer` novo (`createMcpServer(store, sessionRef)`). `onclose` remove do mapa e
  marca a sessão como fechada no store (assento permanece `mcp` mas `sessionClosed = true`
  internamente, o que permite retomada).
  - Não usar `enableJsonResponse` (deixar SSE padrão) — `wait_for_turn` é longa, e SSE
    permite keep-alive. Se der problema com algum cliente, tornar configurável.
  - `POST` sem `Mcp-Session-Id` que não seja `initialize` → 400; com id desconhecido → 404
    ("Session not found: reconnect"). `GET`/`DELETE` exigem id conhecido.
  - Se `MCP_TOKEN` definido, middleware valida o token antes de tudo — header
    `Authorization: Bearer` **ou** query `?token=` (para Claude.ai/ChatGPT, que não mandam
    header). Falhou: `401` + `WWW-Authenticate`, com a mensagem `Unauthorized: missing or
    invalid token (use 'Authorization: Bearer <MCP_TOKEN>' or '?token=<MCP_TOKEN>' in the URL)`.
  - **Expiração**: uma varredura fecha as sessões sem requisição há **30 min**
    (`DEFAULT_MCP_SESSION_IDLE_MS`), exceto as que têm `wait_for_turn` pendente. O cliente
    da sessão varrida recebe `404 Session not found: reconnect (initialize) to start a new
    session` e precisa reinicializar; um `initialize` que chega com um id velho é aceito e
    abre sessão nova.
  - Durante `wait_for_turn`, se o cliente mandou `progressToken`, envia `notifications/progress`
    a cada 10 s (`progressIntervalMs`, 0 desliga). O `AbortSignal` da requisição cancela a
    espera (resposta `timeout`).
- `server.ts`: `createMcpServer(store, session)` registra tools (`registerTool` com
  `inputSchema`/`outputSchema` zod), prompt `chess_teacher` (`registerPrompt`) e os 3
  recursos (`registerResource`). Cada tool resolve `color = store.seatForSession(session.id)`.
- `tools.ts`: implementação das tools de docs/02, em funções puras `(store, session, args) =>
  CallToolResult` para facilitar testes sem transporte.

## Bootstrap (`server/src/index.ts`)
1. `express()` com `hostValidationMiddleware` (`server/src/mcp/guards.ts`) antes de tudo e
   `express.json()`. A validação de `Host` vale para **todas** as rotas e para o upgrade do
   `/ws`, em qualquer bind: aceita loopback, o host da `PUBLIC_URL`, o host do bind (se não
   for `0.0.0.0`) e `ALLOWED_HOSTS`; o resto recebe `403 { error: "Host não permitido: …" }`
   dizendo o que pôr no `.env`. Substitui a do `createMcpExpressApp` do SDK, que em
   `0.0.0.0` (Docker) não protegia e em `127.0.0.1` recusava o host de um túnel.
   Antes disso: `GameStore`, `attachPersistence`, `ProviderRegistry` (mais o provedor
   `fake` se `BOT_FAKE_PROVIDER`) e `BotManager`. O `serverInfo()` junta
   `store.serverInfo()` com `providers`, `profiles` e `bots`.
2. Monta `/api` (com `registry` e `bots` nas dependências; `adminToken` = `ADMIN_TOKEN` ou,
   vazio, `MCP_TOKEN`; `adminAllowFrom`; `inDocker`) e `/mcp`. Logo depois,
   `bots.autoResume()` se `BOT_AUTORESUME`. `/.well-known/*` responde `404` JSON — clientes
   que tentam descoberta OAuth recebem "não há OAuth" em vez do `index.html` da SPA com 200.
3. Se `web/dist/index.html` existe (independente de `NODE_ENV`): `express.static("web/dist")` +
   fallback `index.html` para `GET` que aceita HTML. Senão, `GET /` mostra uma página
   placeholder com as instruções de build e o endpoint MCP.
4. `const httpServer = app.listen(PORT, HOST)`; anexa `WebSocketServer({ server, path: "/ws" })`.
5. Log de inicialização com as URLs: UI, MCP, e comandos de conexão (ver docs/05).
6. `SIGINT`/`SIGTERM`: `bots.stopAll()`, persiste e fecha (com um timer de 3 s como rede).

## Testes (`server/test/*.test.ts`, vitest)

`npm test` — a contagem abaixo é da Fase 2 (**192 testes em 9 arquivos**); esta rodada
acrescentou `mcp-http.test.ts` (token por header/query, expiração de sessão, `Host`) e os
`gateway-*.test.ts` (validação de provedor, redes locais, admin, dicas de diagnóstico). Nenhum toca a rede: os provedores entram
mockados (`fetch` falso, SDK falso) ou pelo `FakeProvider` determinístico.

- `store.test.ts` (38): nova partida, lance humano/mcp/bot, lance ilegal com `legalMoves`,
  não é sua vez, takeback, fim por mate (sequência do Mate do Louco), `waitForTurn` acorda
  com lance do oponente / mensagem / timeout, fila não perde eventos, retomada de assento,
  assento `bot` recebendo eventos e `updateBot` emitindo só `bot`.
- `rules.test.ts` (10): `parseMove` com SAN, UCI, `0-0`, minúsculas, promoção.
- `format.test.ts` (10): snapshot do texto de estado em posição inicial, em meio-jogo e
  com um assento de bot.
- `tools.test.ts` (12): chama as funções de tool com um store em memória e checa `isError`,
  `structuredContent`, texto de próximo passo.
- `api.test.ts` (14): sobe um Express real em porta efêmera; contrato `seats` de
  `POST /api/game` e as rotas `/api/providers*` (incluindo a recusa de qualquer corpo com
  `apiKey`).
- `providers.test.ts` (28): adaptador OpenAI-compatível com `fetch` mockado, sobre
  respostas reais de OpenRouter, Ollama e LM Studio — `tool_calls` com `arguments` em
  string, sem id, com `<think>`; 429 com `retry-after`; 401 — e o registry (presets,
  máscara de chave, `providers.json` sem segredos).
- `bots.test.ts` (13): `BotPlayer`/`BotManager` em modo nativo contra a API real, com o
  `FakeProvider`: partida humano vs bot, bot vs bot até o fim, mensagem do aluno virando
  `comment`, `stop` abortando a rodada sem executar tool tardia, orçamento estourado, 401.
- `textmode.test.ts` (50): parser tolerante (`MOVE:`, `**Lance:**`, JSON, `<think>`, dois
  lances no texto, UCI, `0-0`) e uma partida inteira com o modelo respondendo só texto.
- `anthropic.test.ts` (17): adaptador Anthropic com o **SDK mockado** — `tool_use` do
  modelo voltando como `tool_result` numa única mensagem `user`, `cache_control` no
  `system`, `thinking`/`output_config` filtrados por modelo, `temperature` descartada nos
  4.7+/5.

`server/test/bot-harness.ts` não é um arquivo de teste: é a infra compartilhada (API REST
em porta efêmera, store limpo, registry em memória, `BotManager` com timeouts curtos).
