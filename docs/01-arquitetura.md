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
└─────────────────────┘                     real)           │  └───────────▲────────────┘  │
                                                            │              │ tools.ts      │
┌─────────────────────┐   HTTPS (chat completions/messages) │  ┌───────────┴────────────┐  │
│ OpenRouter, Anthropic│◄───────────────────────────────────│  │ BotPlayer (por assento)│  │
│ Ollama, LM Studio…   │ ───────────────────────────────────►│  │  - provedor de LLM     │  │
└─────────────────────┘                                     │  │  - prompt / orçamento  │  │
                                                            │  └────────────────────────┘  │
                                                            │  serve web/dist em produção  │
                                                            └──────────────────────────────┘
```

Um único processo Node faz tudo: serve a UI, expõe a API REST/WebSocket para o navegador,
o endpoint MCP para as LLMs externas e — quando configurado — fala direto com um provedor
de LLM para ocupar um assento sozinho. O **GameStore** é a única fonte de verdade; qualquer
mudança (lance, comentário, destaque, assento) dispara um broadcast do estado completo via
WebSocket e acorda quem estiver bloqueado em `wait_for_turn`.

## Stack

| Camada | Escolha | Motivo |
|--------|---------|--------|
| Runtime | Node 24, TypeScript, ESM | já instalado na máquina; `tsx` roda TS direto, sem build do servidor |
| Regras de xadrez | `chess.js` 1.x | validação de lances, SAN/UCI, FEN, PGN, detecção de fim de jogo |
| HTTP | `express` 5 | validação própria do header `Host` (DNS rebinding) em todas as rotas, `server/src/mcp/guards.ts` — a do `createMcpExpressApp` do SDK não protegia em `0.0.0.0` nem aceitava túnel |
| MCP | `@modelcontextprotocol/sdk` 1.30 (`McpServer` + `StreamableHTTPServerTransport`) | transporte recomendado; sessões com estado |
| Schemas | `zod` 4 | exigido pelo SDK para `inputSchema`/`outputSchema` |
| Tempo real | `ws` 8 | WebSocket simples para o navegador |
| Frontend | Vite 8 + React 19 + TypeScript | rápido, sem framework pesado |
| Tabuleiro | `react-chessboard` 5.x | drag-and-drop, setas, casas customizáveis, peças embutidas |
| Provedores de LLM | `fetch` nativo (OpenAI-compatível) + `@anthropic-ai/sdk` (import dinâmico) | o subconjunto usado da API compatível é pequeno e estável; para a Messages API o SDK evita drift de `thinking`/`output_config` |
| Testes | `vitest` | store, regras, formatador, tools, API REST, provedores, bots |

## Estrutura de pastas

```
llm-xadrez/
├── docs/                    # esta documentação (fonte de verdade do projeto)
├── shared/
│   └── types.ts             # CONTRATO: tipos do estado, eventos WS, payloads REST
├── server/
│   ├── src/
│   │   ├── index.ts         # bootstrap: express + ws + mcp + bots + static
│   │   ├── config.ts        # PORT, HOST, DATA_DIR, LANG, PROVIDERS_FILE, BOT_*
│   │   ├── log.ts           # logger com redact(): nenhuma chave de API vai para o log
│   │   ├── game/
│   │   │   ├── store.ts     # GameStore: estado, assentos, filas de eventos, persistência
│   │   │   ├── rules.ts     # wrapper chess.js: aplicar lance, lances legais, capturas, material
│   │   │   ├── format.ts    # formatStateForLLM(): texto legível por LLM
│   │   │   └── persist.ts   # current-game.json (debounce) e games/*.pgn
│   │   ├── http/
│   │   │   ├── api.ts       # rotas REST /api/* (jogo, /providers*, /bots/*)
│   │   │   └── ws.ts        # WebSocket /ws: broadcast de estado, server e bot
│   │   ├── mcp/
│   │   │   ├── server.ts    # cria McpServer por sessão; registra tools/prompts/resources
│   │   │   ├── tools.ts     # implementação das tools (funções puras; os bots chamam as mesmas)
│   │   │   ├── prompts.ts   # prompt "chess_teacher"
│   │   │   └── transport.ts # rota /mcp com mapa sessionId → transport
│   │   └── bots/            # o servidor ocupando um assento sozinho (docs/09)
│   │       ├── player.ts    # BotPlayer: loop espera → pensa → age, retries, fallbacks
│   │       ├── manager.ts   # BotManager: um BotPlayer por cor; sit/stop/resume/leave
│   │       ├── prompt.ts    # prompt de sistema do bot (papel, nível, idioma)
│   │       ├── toolset.ts   # as 5 tools do bot + dispatcher validado pelos schemas do MCP
│   │       ├── textmode.ts  # modo "texto estruturado" e parser tolerante
│   │       ├── budget.ts    # orçamento por partida (chamadas, tokens, custo)
│   │       └── providers/   # types · openai-compat · anthropic · registry · fake
│   ├── test/                # vitest (9 arquivos, 192 testes)
│   └── tsconfig.json
├── web/
│   ├── index.html
│   ├── public/              # favicon.svg + fonts/ (Literata auto-hospedada, OFL)
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── api.ts           # fetch /api + hook useGameSocket()
│   │   ├── theme.ts         # tema claro/escuro e preset de casas (localStorage)
│   │   ├── feed.ts · status.ts · bots.ts · favicon.ts · sound.ts · markdown.tsx
│   │   ├── components/      # ver docs/04
│   │   ├── dev/fixtures.ts  # cenários ?mock=… para desenvolver e capturar sem servidor
│   │   └── styles.css       # tokens de design + layout (docs/10)
│   ├── tsconfig.json
│   └── vite.config.ts
├── scripts/
│   ├── mcp-smoke.ts         # cliente MCP de teste: joga uma partida inteira via HTTP
│   ├── mcp-play.ts          # "IA de mentira": cliente MCP que joga/comenta (npm run play)
│   └── bot-smoke.ts         # smoke dos bots internos pela REST (npm run smoke:bot)
├── providers.json           # provedores e perfis de bot — COMMITADO, sem nenhuma chave
├── .env                     # gitignored: chaves de API e configuração local
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

5. **Lance de um bot do servidor**: o `BotPlayer` da cor está bloqueado em
   `store.waitForTurn` (a mesma fila do MCP, sem o teto de 120 s). Acordado, monta a
   conversa com o **mesmo texto** que uma sessão MCP receberia (`formatTurnEvent`), chama o
   provedor e executa a tool **direto** em `mcp/tools.ts` — daí em diante o caminho é o do
   item 1. Mudanças de status/uso do bot viajam num evento WS próprio (`{ type: "bot" }`),
   sem reenviar o estado.

## Sessões MCP e assentos

- Um assento é `human`, `mcp`, `bot` ou `empty`. `mcp` e `bot` são "agentes": têm
  `sessionId`, recebem eventos na fila e esperam a vez. O `GameStore` trata os dois
  igual — ele não sabe o que é um provedor de LLM; quem sabe é o `BotManager`.
- Cada conexão MCP (Streamable HTTP, com `sessionIdGenerator`) tem um `McpServer` próprio,
  mas todos compartilham o mesmo `GameStore`.
- Um bot usa uma **sessão sintética** (`bot:<cor>:<hex>`), que não aparece em
  `ServerInfo.mcpSessions` (a UI mostraria "sem conexão"): o estado dele vive em
  `seat.bot`. Um bot também não expira por ociosidade — pode ficar minutos pensando num
  modelo local, e quem controla o ciclo de vida dele é o `BotManager`.
- `new_game` / `join_game` associam `sessionId` → assento (`seats.white.sessionId`).
- Se a sessão cair e o cliente reconectar com outro `sessionId`, `join_game` na mesma cor
  (ou com o mesmo `my_name`) retoma o assento se a sessão anterior estiver fechada ou
  ociosa há mais de 2 min. `force: true` toma o assento incondicionalmente.
- O assento humano não tem sessão: qualquer navegador conectado age por ele.

## Segurança (escopo local)

- Bind padrão em `127.0.0.1` (no Docker, a porta é publicada em `127.0.0.1` via
  `BIND_ADDR`). Abrir para a rede é uma decisão explícita.
- **Header `Host` validado em todas as rotas** (UI, `/api`, `/ws`, `/mcp`), em qualquer
  bind: só loopback, o host da `PUBLIC_URL` e `ALLOWED_HOSTS` passam (proteção contra DNS
  rebinding). Túnel ou IP da rede precisam estar nessa lista.
- `/mcp` sem autenticação por padrão. Para expor (túnel, rede), `MCP_TOKEN` no `.env`: o
  servidor exige `Authorization: Bearer <token>` ou `?token=<token>` na URL. O token na
  URL existe para Claude.ai/ChatGPT, que não mandam header; é mais fraco (fica salvo na
  configuração do conector e pode aparecer em logs de proxy).
- Sessões MCP ociosas há 30 min são fechadas; um assento de sessão viva não é tomado só
  pelo nome.
- A UI (`/`) não tem senha. O que ela pode fazer de perigoso — gravar `providers.json`,
  testar e listar modelos (o servidor abre conexão para a `baseUrl`) — é
  **administração**: aceita do loopback e de `ADMIN_ALLOW_FROM` (no compose,
  `172.16.0.0/12`, a ponte do Docker), ou com `Authorization: Bearer <ADMIN_TOKEN>` (ou
  `MCP_TOKEN`). O mais é `403 admin_forbidden`. O token digitado na UI fica só no
  `sessionStorage` da aba.
- Nada de `eval`, nada de execução de código vindo das tools.
- **Chaves de API só no ambiente.** `providers.json` guarda apenas o *nome* da variável
  (`apiKeyEnv`), que precisa terminar em `_API_KEY`/`_KEY`/`_TOKEN` e não pode ser
  `MCP_TOKEN`/`ADMIN_TOKEN` (senão bastaria apontar um provedor para um segredo do
  servidor e mandá-lo para uma URL qualquer). `ProviderConfig` não tem campo de chave; a
  API nunca devolve uma (`hasApiKey` + `apiKeyMasked`) nem aceita uma no corpo (`apiKey`,
  `key`, `token`, `authorization`, `extraHeaders` → `400`) — aceitar chave pela UI a
  transformaria num canal de exfiltração. `envKeys` expõe só **nomes** de variáveis.
- Todo texto logado passa por `redact()` (`sk-…`, `Bearer …`, `x-api-key`), e a resposta
  bruta do provedor nunca é persistida.
- Um bot só fala com o `baseUrl` da config: a UI não consegue apontar o servidor para uma
  URL arbitrária sem passar pelas rotas administrativas acima. `baseUrl` com
  `usuário:senha@` é recusada.

## Decisões registradas

- **Uma partida atual** em vez de multi-partida: simplifica a UI e as tools (nenhum
  `game_id` obrigatório). O histórico fica em `data/games/*.pgn`.
- **Estado completo em toda resposta** de tool: custa tokens, mas é exatamente o que evita
  a LLM se perder. O formatador é compacto (ver docs/02).
- **Servidor roda com `tsx`** também em produção: projeto local, sem necessidade de `tsc`
  build para o servidor. Apenas o frontend é buildado (`vite build`).
- **Sem Stockfish na v1**: a IA comenta com o próprio conhecimento. Um `analyze` tool com
  Stockfish WASM está no [roadmap](06-roadmap.md).
- **O bot não é uma sessão MCP interna**: não instanciamos `McpServer` + transporte em
  memória para ele. Chamar `tools.ts` direto é mais simples, sem serialização, sem o teto
  de 120 s, e as tools já são funções puras testadas.
- **Sem CRUD de perfis de bot**: perfis se editam no `providers.json` (ou se escolhe
  `providerId` + `model` direto no pedido de assento). Uma API de perfis só se paga com um
  editor decente na tela "Provedores" — está no roadmap.
- **Sem streaming na v1**: uma requisição ao provedor = uma resposta completa. O comentário
  aparece quando a tool é executada; enquanto isso a UI mostra "pensando há N s".
