# 03 — Servidor: estado, REST, WebSocket, persistência

## Configuração (`server/src/config.ts`, lê `.env`)

| Variável | Default | Descrição |
|----------|---------|-----------|
| `PORT` | `3939` | porta única para UI, API, WS e MCP |
| `HOST` | `127.0.0.1` | `0.0.0.0` para acessar de outro dispositivo na rede |
| `DATA_DIR` | `./data` | persistência |
| `LANG` | `pt-BR` | idioma dos textos gerados para a LLM |
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
  - `takeback(plies, by)` — usa `chess.undo()`; recalcula tudo; limpa highlight.
  - `addComment(author, text, category, highlight?)`
  - `setHighlight(by, spec | null)`
  - `addHumanMessage(text, to)` / `markDelivered(color)`
  - `endGame(reason, by?)`, `offerDraw(by)`
  - `waitForTurn(color, timeoutMs): Promise<TurnEvent>`
  - `getState(): GameState` (cópia imutável / estrutura serializável)
- Filas de eventos por assento: `Map<Color, TurnEventType[]>` + lista de `waiters`
  (`{ color, resolve, timer }`). `pushEvent(color, type)` acorda o waiter dessa cor.
  `waitForTurn` primeiro drena a fila; se vazia e não é a vez, registra waiter.
  "É a sua vez e o oponente está sentado" também conta como evento imediato (`your_turn`).
- Emite `change` após qualquer mutação → `ws.ts` faz broadcast; `persist.ts` salva
  (debounce 100 ms) em `DATA_DIR/current-game.json`.
- Ao iniciar, carrega `current-game.json` se existir (assentos `mcp` viram `empty` porque
  as sessões morreram; humano permanece).
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

| Método | Rota | Body | Efeito |
|--------|------|------|--------|
| GET | `/api/health` | — | `{ ok, version, mcpUrl, mcpSessions[] }` |
| GET | `/api/state` | — | `GameState` |
| POST | `/api/game` | `NewGameRequest` | nova partida. `humanSeats`: `white`/`black` (o outro fica `empty` aguardando LLM), `both`, `none` |
| POST | `/api/move` | `MoveRequest` | lance pelo assento humano da vez. 400 se não é vez de humano ou lance ilegal (`legalMoves` no erro) |
| POST | `/api/message` | `MessageRequest` | mensagem para LLM(s) |
| POST | `/api/takeback` | `TakebackRequest` | desfaz; default: volta até a posição antes do último lance humano |
| POST | `/api/resign` | `ResignRequest` | humano desiste |
| POST | `/api/draw` | `{ color? }` | humano oferece/aceita empate (v1: aceitar = empate imediato se LLM ofereceu; oferecer gera `drawOffer`) |
| POST | `/api/highlight/clear` | — | limpa desenho |
| GET | `/api/pgn` | — | `text/plain` PGN da partida atual (`Content-Disposition: attachment`) |
| GET | `/api/games` | — | lista `[{ id, date, white, black, result }]` de `data/games` |
| GET | `/api/games/:id/pgn` | — | PGN antigo |

## WebSocket (`server/src/http/ws.ts`) — rota `/ws`
- Ao conectar: envia `{ type: "hello", state, server }`.
- A cada `change`: `{ type: "state", state }` para todos.
- A cada sessão MCP aberta/fechada ou `lastSeenAt` mudando: `{ type: "server", server }`
  (throttle 500 ms).
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
  - Se `MCP_TOKEN` definido, middleware valida o header antes de tudo.
- `server.ts`: `createMcpServer(store, session)` registra tools (`registerTool` com
  `inputSchema`/`outputSchema` zod), prompt `chess_teacher` (`registerPrompt`) e os 3
  recursos (`registerResource`). Cada tool resolve `color = store.seatForSession(session.id)`.
- `tools.ts`: implementação das tools de docs/02, em funções puras `(store, session, args) =>
  CallToolResult` para facilitar testes sem transporte.

## Bootstrap (`server/src/index.ts`)
1. `const app = createMcpExpressApp({ host })` (já inclui `express.json()`).
2. Monta `/api`, `/mcp`.
3. Em produção (`web/dist` existe): `express.static("web/dist")` + fallback `index.html`.
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
