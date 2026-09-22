# 01 — Arquitetura

## Visão geral

```
┌─────────────────────┐        MCP (Streamable HTTP)        ┌──────────────────────────────┐
│ Claude Desktop      │ ───────────────────────────────────►│                              │
│ Claude Code         │   POST /mcp  (tools, prompts, res.) │   SERVIDOR  (Node 24 + TS)   │
│ outro cliente MCP   │◄─────────────────────────────────── │   porta 3939                 │
└─────────────────────┘                                     │                              │
                                                            │  ┌────────────────────────┐  │
┌─────────────────────┐   HTTP REST  /api/*                 │  │ GameStore (singleton)  │  │
│ Navegador           │ ───────────────────────────────────►│  │  - chess.js (regras)   │  │
│ (React + Vite)      │   WebSocket  /ws  (estado em tempo  │  │  - assentos / eventos  │  │
│ tabuleiro + aula    │◄─────────────────────────────────── │  │  - persistência JSON   │  │
└─────────────────────┘                     real)           │  └────────────────────────┘  │
                                                            │  serve web/dist em produção  │
                                                            └──────────────────────────────┘
```

Um único processo Node faz tudo: serve a UI, expõe a API REST/WebSocket para o navegador e
o endpoint MCP para as LLMs. O **GameStore** é a única fonte de verdade; qualquer mudança
(lance, comentário, destaque, assento) dispara um broadcast do estado completo via WebSocket
e acorda quem estiver bloqueado em `wait_for_turn`.

## Stack

| Camada | Escolha | Motivo |
|--------|---------|--------|
| Runtime | Node 24, TypeScript, ESM | já instalado na máquina; `tsx` roda TS direto, sem build do servidor |
| Regras de xadrez | `chess.js` 1.x | validação de lances, SAN/UCI, FEN, PGN, detecção de fim de jogo |
| HTTP | `express` 5 (via `createMcpExpressApp` do SDK) | o SDK do MCP já traz Express com proteção DNS-rebinding |
| MCP | `@modelcontextprotocol/sdk` 1.30 (`McpServer` + `StreamableHTTPServerTransport`) | transporte recomendado; sessões com estado |
| Schemas | `zod` 4 | exigido pelo SDK para `inputSchema`/`outputSchema` |
| Tempo real | `ws` 8 | WebSocket simples para o navegador |
| Frontend | Vite 8 + React 19 + TypeScript | rápido, sem framework pesado |
| Tabuleiro | `react-chessboard` 5.x | drag-and-drop, setas, casas customizáveis, peças embutidas |
| Testes | `vitest` | GameStore e formatador de estado |

## Estrutura de pastas

```
llm-xadrez/
├── docs/                    # esta documentação (fonte de verdade do projeto)
├── shared/
│   └── types.ts             # CONTRATO: tipos do estado, eventos WS, payloads REST
├── server/
│   ├── src/
│   │   ├── index.ts         # bootstrap: express + ws + mcp + static
│   │   ├── config.ts        # PORT, HOST, DATA_DIR, LANG
│   │   ├── game/
│   │   │   ├── store.ts     # GameStore: estado, assentos, filas de eventos, persistência
│   │   │   ├── rules.ts     # wrapper chess.js: aplicar lance, lances legais, capturas, material
│   │   │   └── format.ts    # formatStateForLLM(): texto legível por LLM
│   │   ├── http/
│   │   │   ├── api.ts       # rotas REST /api/*
│   │   │   └── ws.ts        # WebSocket /ws: broadcast de estado
│   │   └── mcp/
│   │       ├── server.ts    # cria McpServer por sessão; registra tools/prompts/resources
│   │       ├── tools.ts     # implementação das tools
│   │       ├── prompts.ts   # prompt "chess_teacher"
│   │       └── transport.ts # rota /mcp com mapa sessionId → transport
│   ├── test/                # vitest
│   └── tsconfig.json
├── web/
│   ├── index.html
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── api.ts           # fetch /api + hook useGameSocket()
│   │   ├── components/      # Board, LessonFeed, MoveList, Seats, Controls, MessageBox, NewGameDialog
│   │   └── styles.css
│   ├── tsconfig.json
│   └── vite.config.ts
├── scripts/
│   ├── mcp-smoke.ts         # cliente MCP de teste: joga uma partida inteira via HTTP
│   └── mcp-play.ts          # "IA de mentira": cliente MCP que joga/comenta (npm run play)
├── data/                    # gerado em runtime (gitignored): current-game.json, games/*.pgn
├── .mcp.json                # registro do servidor MCP para o Claude Code neste repo
├── package.json             # pacote único (server + web), scripts npm
└── README.md
```

Um único `package.json` na raiz para simplificar: `npm install` uma vez, `npm run dev` sobe tudo.

## Fluxo de dados

1. **Lance da LLM**: `make_move` → `GameStore.applyMove(seat, move)` → chess.js valida → estado
   atualizado → persistido em `data/current-game.json` → `emit("change")` → WS broadcast +
   fila de evento `opponent_moved` para o outro assento → resposta da tool com estado.
2. **Lance do humano**: `POST /api/move` → mesma função `applyMove(seat=human)` → mesmo caminho.
3. **wait_for_turn**: a tool registra um `waiter` no assento; retorna quando a fila desse
   assento recebe evento relevante ou o timeout estoura. Nunca bloqueia o event loop.
4. **Mensagem do humano**: `POST /api/message` → entra em `humanMessages` (pendentes) e gera
   evento `message` para os assentos destinatários; é marcada como entregue quando aparece
   numa resposta de tool para aquele assento.

## Sessões MCP e assentos

- Cada conexão MCP (Streamable HTTP, com `sessionIdGenerator`) tem um `McpServer` próprio,
  mas todos compartilham o mesmo `GameStore`.
- `new_game` / `join_game` associam `sessionId` → assento (`seats.white.sessionId`).
- Se a sessão cair e o cliente reconectar com outro `sessionId`, `join_game` na mesma cor
  (ou com o mesmo `my_name`) retoma o assento se a sessão anterior estiver fechada ou
  ociosa há mais de 2 min. `force: true` toma o assento incondicionalmente.
- O assento humano não tem sessão: qualquer navegador conectado age por ele.

## Segurança (escopo local)

- Bind padrão em `127.0.0.1`. `createMcpExpressApp` aplica proteção contra DNS rebinding.
- Sem autenticação. Para expor via túnel (ngrok/cloudflared), configurar `MCP_TOKEN` no
  `.env`: o servidor exige `Authorization: Bearer <token>` em `/mcp` quando definido.
- Nada de `eval`, nada de execução de código vindo das tools.

## Decisões registradas

- **Uma partida atual** em vez de multi-partida: simplifica a UI e as tools (nenhum
  `game_id` obrigatório). O histórico fica em `data/games/*.pgn`.
- **Estado completo em toda resposta** de tool: custa tokens, mas é exatamente o que evita
  a LLM se perder. O formatador é compacto (ver docs/02).
- **Servidor roda com `tsx`** também em produção: projeto local, sem necessidade de `tsc`
  build para o servidor. Apenas o frontend é buildado (`vite build`).
- **Sem Stockfish na v1**: a IA comenta com o próprio conhecimento. Um `analyze` tool com
  Stockfish WASM é candidato à fase 3.
