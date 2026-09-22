# 03 — Servidor: estado, REST, WebSocket, persistência

## Configuração (`server/src/config.ts`, lê `.env`)

| Variável | Default | Descrição |
|----------|---------|-----------|
| `PORT` | `3939` | porta única para UI, API, WS e MCP |
| `HOST` | `127.0.0.1` | `0.0.0.0` para acessar de outro dispositivo na rede |
| `DATA_DIR` | `./data` | persistência |
| `LANG` | `pt-BR` | idioma dos textos gerados para a LLM. Qualquer valor começando com `en` vira `en`; o resto vira `pt-BR` (no Git Bash a variável do sistema pode vir como `en_US.UTF-8`) |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` \| `silent` |
| `MCP_TOKEN` | (vazio) | se definido, `/mcp` exige `Authorization: Bearer <token>` |
| `HUMAN_NAME` | `Você` | nome padrão do humano |

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
    `lastSeenAt` e `waiting` (true enquanto há um waiter dessa sessão).
  - `getState(): GameState` (cópia imutável / estrutura serializável, com cache)
- Filas de eventos por assento: `Map<Color, TurnEventType[]>` + lista de `waiters`
  (`{ color, resolve, timer }`). `pushEvent(color, type)` acorda o waiter dessa cor.
  `waitForTurn` primeiro drena a fila; se vazia e não é a vez, registra waiter.
  "É a sua vez e o oponente está sentado" também conta como evento imediato (`your_turn`).
- Emite `change` após qualquer mutação → `ws.ts` faz broadcast; `persist.ts` salva
  (debounce 100 ms) em `DATA_DIR/current-game.json`.
- Ao iniciar, carrega `current-game.json` se existir (assentos `mcp` viram `empty` porque
  as sessões morreram, mantendo o nome; humano permanece). Ao criar a nova partida via MCP
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

## API REST (`server/src/http/api.ts`) — usada pelo navegador

Todas as rotas respondem JSON. Erros: `4xx` com `ApiError`.

Todos os `POST` abaixo respondem com o `GameState` resultante (o navegador ignora esse
corpo e se atualiza pelo broadcast WebSocket, que chega antes/junto; o corpo serve para
scripts e depuração).

| Método | Rota | Body | Resposta / efeito |
|--------|------|------|--------|
| GET | `/api/health` | — | `{ ok: true, version, mcpUrl, mcpSessions[] }` (`mcpSessions` = `ServerInfo.mcpSessions`, com `waiting`) |
| GET | `/api/state` | — | `GameState` |
| POST | `/api/game` | `NewGameRequest` | `GameState`. `humanSeats`: `white`/`black` (o outro fica `empty` aguardando LLM), `both`, `none`. **Sessões MCP com conexão aberta continuam sentadas** na nova partida (na cor livre; com `none`, as duas) e recebem o evento `new_game`; sessões mortas viram `empty`. `humanSeats` inválido cai em `white`; `humanName` vazio usa `HUMAN_NAME` |
| POST | `/api/move` | `MoveRequest` | `GameState`. Lance pelo assento humano da vez. 400 se a partida não está `active`, se não é vez de humano ou se o lance é ilegal (`legalMoves` no erro) |
| POST | `/api/message` | `MessageRequest` | `GameState`. `to` inválido vira `all`. Gera evento `message` só para assentos `mcp` |
| POST | `/api/takeback` | `TakebackRequest` | `GameState`. Sem `plies` (é o que a UI manda): volta até a posição anterior ao último lance humano (`history[].by === "human"`); 400 se não há lance humano. Gera `takeback` para as LLMs |
| POST | `/api/resign` | `ResignRequest` | `GameState`. `color` obrigatório só se o humano ocupa os dois assentos; senão usa o único assento humano |
| POST | `/api/draw` | `{ color? }` | `GameState & { drawAccepted: boolean }`. Se já há oferta do oponente: aceita (empate imediato, `drawAccepted: true`). Senão registra `drawOffer`, publica comentário de sistema "X oferece empate." e manda uma `HumanMessage` à LLM oponente pedindo `end_game(how: "draw")` para aceitar |
| POST | `/api/highlight/clear` | — | `GameState` com `highlight: null` |
| GET | `/api/pgn` | — | `text/plain` PGN da partida atual (`Content-Disposition: attachment`) |
| GET | `/api/games` | — | lista `[{ id, date, white, black, result }]` de `data/games` |
| GET | `/api/games/:id/pgn` | — | PGN antigo |

## WebSocket (`server/src/http/ws.ts`) — rota `/ws`
- Ao conectar: envia `{ type: "hello", state, server }`.
- A cada `change`: `{ type: "state", state }` para todos.
- A cada sessão MCP aberta/fechada, `lastSeenAt` mudando ou waiter de `wait_for_turn`
  entrando/saindo (`waiting`): `{ type: "server", server }` (throttle 500 ms).
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
  - Se `MCP_TOKEN` definido, middleware valida o header antes de tudo (401 + `WWW-Authenticate`).
  - Durante `wait_for_turn`, se o cliente mandou `progressToken`, envia `notifications/progress`
    a cada 10 s (`progressIntervalMs`, 0 desliga). O `AbortSignal` da requisição cancela a
    espera (resposta `timeout`).
- `server.ts`: `createMcpServer(store, session)` registra tools (`registerTool` com
  `inputSchema`/`outputSchema` zod), prompt `chess_teacher` (`registerPrompt`) e os 3
  recursos (`registerResource`). Cada tool resolve `color = store.seatForSession(session.id)`.
- `tools.ts`: implementação das tools de docs/02, em funções puras `(store, session, args) =>
  CallToolResult` para facilitar testes sem transporte.

## Bootstrap (`server/src/index.ts`)
1. `const app = createMcpExpressApp({ host })` (já inclui `express.json()`).
2. Monta `/api`, `/mcp`.
3. Se `web/dist/index.html` existe (independente de `NODE_ENV`): `express.static("web/dist")` +
   fallback `index.html` para `GET` que aceita HTML. Senão, `GET /` mostra uma página
   placeholder com as instruções de build e o endpoint MCP.
4. `const httpServer = app.listen(PORT, HOST)`; anexa `WebSocketServer({ server, path: "/ws" })`.
5. Log de inicialização com as URLs: UI, MCP, e comandos de conexão (ver docs/05).
6. `SIGINT`: persiste e fecha.

## Testes (`server/test/*.test.ts`, vitest)
- `store.test.ts`: nova partida, lance humano/mcp, lance ilegal com `legalMoves`, não é
  sua vez, takeback, fim por mate (sequência do Mate do Louco), `waitForTurn` acorda com
  lance do oponente / mensagem / timeout, fila não perde eventos, retomada de assento.
- `rules.test.ts`: `parseMove` com SAN, UCI, `0-0`, minúsculas, promoção.
- `format.test.ts`: snapshot do texto de estado em posição inicial e em posição de meio-jogo.
- `tools.test.ts`: chama as funções de tool com um store em memória e checa `isError`,
  `structuredContent`, texto de próximo passo.
