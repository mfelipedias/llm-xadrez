# 04 — Frontend (tabuleiro + aula)

Vite + React 19 + TypeScript, em `web/`. Idioma da UI: pt-BR. Tema escuro por padrão.
Sem biblioteca de UI pesada: CSS próprio em `styles.css` (variáveis de cor, grid responsivo).

## Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ♞ LLM Xadrez      [● conectado]   Brancas: Felipe (você)  Pretas: Claude │  header
├─────────────────────────────────────┬────────────────────────────────────┤
│                                     │  AULA (feed)                       │
│                                     │  ┌ 1. e4  — Felipe                 │
│          TABULEIRO                  │  ┌ 1...e5 — Claude: "Disputo o     │
│      (react-chessboard)             │  │  centro de igual para igual."   │
│   setas / casas destacadas          │  ┌ 💡 Claude: "Repare que..."      │
│   último lance / xeque              │  ┌ ❓ Você → Claude: "por que..."   │
│                                     │  ...                               │
│  [↻ virar] [PGN] [FEN] [↶ voltar]   ├────────────────────────────────────┤
│                                     │  LANCES  1. e4 e5  2. Nf3 Nc6 ...  │
│  status: "Vez das brancas (você)"   ├────────────────────────────────────┤
│                                     │  [todos ▾] [ mensagem para a IA ] ⏎│
│                                     │  [Nova partida] [Desistir] [Empate]│
└─────────────────────────────────────┴────────────────────────────────────┘
```
Em telas < 900 px: coluna única (header, tabuleiro, status, feed, lances, mensagem).

## Componentes (`web/src/components/`)

- **`Board.tsx`** — `react-chessboard` (v5: `<Chessboard options={{...}} />`; **ler o README
  em `node_modules/react-chessboard` para a API exata da versão instalada**).
  - `position = state.fen`; orientação = cor do humano (ou brancas se espectador); botão virar.
  - Drag-and-drop permitido apenas se `status === "active"` e `seats[turn].kind === "human"`.
  - Ao soltar: validar localmente com `chess.js` (`new Chess(fen).move(...)`) para feedback
    instantâneo; se legal, `POST /api/move` com UCI. Promoção: diálogo do próprio
    react-chessboard ou seletor simples (Q/R/B/N).
  - Clique-clique também funciona (selecionar origem, mostrar destinos legais com pontos,
    clicar destino).
  - Destaques: `lastMove` (from/to em amarelo suave), rei em xeque (vermelho), `highlight`
    do estado (casas e setas via `customArrows`/`customSquareStyles` ou equivalente v5).
  - Animação de peça padrão da lib (200 ms).
- **`Seats.tsx`** — quem ocupa cada cor: ícone (👤 humano / 🤖 LLM / ⬚ vazio), nome, e para
  LLM um indicador de atividade ("pensando…" se `lastSeenAt` < 3 s; "aguardando" se em
  `wait_for_turn`; "sem conexão" se `mcpSessions` não contém a sessão do assento).
  Assento `empty`: mostra "Aguardando IA — conecte via MCP" com a URL do `/mcp` e botão copiar,
  e link "como conectar" abrindo `ConnectHelp` (modal com os comandos de docs/05).
- **`LessonFeed.tsx`** — linha do tempo cronológica combinando `history` (lances, com o
  `comment` do lance) e `commentary` e `humanMessages` (entregues ou não). Cada item: avatar
  por autor, categoria com ícone (💡 lesson, 🎯 plan, 💬 reaction, ❓ question, 👏 praise,
  ⚠️ warning, ℹ️ info), texto com markdown mínimo (negrito, itálico, código, listas).
  Auto-scroll para o fim quando chega item novo (a menos que o usuário tenha rolado para cima).
  Clique num lance do feed → `MoveList` seleciona a posição (preview).
- **`MoveList.tsx`** — tabela compacta `nº | brancas | pretas`. Clique navega (preview
  read-only: o tabuleiro mostra `fenAfter` do lance escolhido, com faixa "visualizando lance
  N — voltar ao vivo"). Teclas ← → navegam, End volta ao vivo.
- **`MessageBox.tsx`** — select destino (`todos`/`brancas`/`pretas`; só mostra cores
  ocupadas por LLM) + input + Enter envia `POST /api/message`. Estado de envio.
- **`Controls.tsx`** — Nova partida (abre `NewGameDialog`), Desistir (confirmação inline, sem
  `window.confirm`), Empate, Voltar lance (`POST /api/takeback`), Exportar PGN (link
  `/api/pgn`), Copiar FEN, Limpar desenho.
- **`NewGameDialog.tsx`** — escolha: "Eu de brancas vs IA", "Eu de pretas vs IA",
  "IA vs IA (assistir)", "Dois humanos"; nome do humano (lembrado em `localStorage`); FEN
  inicial opcional (campo avançado). Envia `POST /api/game`.
- **`StatusBar.tsx`** — frase de status: "Vez das brancas (você)", "Claude está pensando…",
  "Xeque!", "Xeque-mate — Claude venceu", "Aguardando a IA entrar", "Empate por afogamento".
- **`ConnectHelp.tsx`** — modal com os snippets de conexão (Claude Code, Claude Desktop,
  genérico), cada um com botão copiar. Conteúdo vem de `server.mcpUrl`.

## Estado e rede (`web/src/api.ts`)
- `useGameSocket()`: abre `ws://<host>/ws`, mantém `{ state, server, connected }`,
  reconecta com backoff. Fonte única de verdade = último `state` recebido.
- `api.move(uci)`, `api.newGame(req)`, `api.message(req)`, `api.takeback()`, `api.resign()`,
  `api.draw()`, `api.clearHighlight()` — `fetch` com tratamento de `ApiError` (toast simples).
- Em dev, Vite faz proxy de `/api`, `/ws` (ws: true) e `/mcp` para `http://localhost:3939`.

## Sons (opcional, pequeno)
`web/public/sounds/{move,capture,check,end}.mp3` (gerar com Web Audio se não houver
arquivos: um "click" sintetizado é suficiente). Toggle no header, preferência em
`localStorage`.

## Acessibilidade e detalhes
- Tabuleiro com coordenadas visíveis; contraste mínimo AA nos textos.
- `aria-live="polite"` no `StatusBar` e no último item do feed.
- Título da aba muda para "♟ Sua vez — LLM Xadrez" quando é vez do humano (útil quando a
  aba está em segundo plano) e volta ao normal depois.
- Favicon: peça de xadrez em SVG inline (`web/public/favicon.svg`).
