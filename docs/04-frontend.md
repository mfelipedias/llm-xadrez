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

- **`Board.tsx`** — `react-chessboard` 5 (`<Chessboard options={{...}} />`).
  - `position = fen` exibido (ao vivo ou preview); orientação = cor do humano (ou brancas se
    espectador / dois humanos); botão virar.
  - Interativo apenas se `status === "active"`, `seats[turn].kind === "human"`, sem preview e
    com WebSocket conectado (`allowDragging` + `canDragPiece` só para peças da cor da vez).
  - Ao soltar/clicar destino: valida localmente com `chess.js` (`new Chess(fen).moves({ square })`);
    se legal, `POST /api/move` com UCI. Se o servidor recusar, toast com o erro e o tabuleiro é
    remontado (`resetKey`) para desfazer o drop.
  - **Promoção:** overlay próprio (`.promotion`, botões ♕ ♖ ♗ ♘ + Cancelar) em vez do diálogo da
    lib; o lance só é enviado depois da escolha (`e7e8q`).
  - Clique-clique: selecionar origem (peça da cor da vez), destinos legais com pontos
    (capturas com anel), clicar destino. Clicar a mesma casa desmarca.
  - Destaques via `options.squareStyles` (camadas de `backgroundImage`): `lastMove` (from/to
    em amarelo), rei em xeque (radial vermelho), `highlight.squares` (verde por default;
    `green/red/blue/yellow/orange/purple` mapeados para a paleta, outras cores CSS passam
    direto), seleção e destinos. Setas via `options.arrows` (`{ startSquare, endSquare, color }`).
  - **Regra do destaque:** o servidor não apaga `state.highlight` ao jogar; `App` só repassa o
    destaque ao `Board` (e habilita "Limpar desenho") quando `highlight.ply === state.ply` e
    não há preview. Assim as setas somem no instante em que qualquer lado joga.
  - Animação de peça 200 ms; `allowDrawingArrows` ligado (o usuário pode desenhar setas
    locais com o botão direito).
  - Nota para automação (Playwright): a lib usa sensores de ponteiro do dnd-kit; um
    `drag` "instantâneo" não move a peça — use clique-clique ou `mousedown` + vários
    `mousemove` + `mouseup`. As casas têm `data-square="e4"`.
- **`Seats.tsx`** — quem ocupa cada cor: ícone (👤 humano / 🤖 LLM / ⬚ vazio), nome, e para
  LLM um indicador de atividade calculado a partir de `server.mcpSessions`:
  "sem conexão" se a sessão do assento não está na lista; "aguardando" se
  `mcpSessions[].waiting === true` (bloqueada em `wait_for_turn`); "pensando…" se
  `lastSeenAt` < 3 s (relógio local re-renderizado a cada 1 s); senão "ociosa"
  (ou "aguardando" quando `waiting` é indefinido — servidores antigos).
  Assento `empty`: mostra "Aguardando IA — conecte via MCP" com a URL do `/mcp` e botão copiar,
  e link "como conectar" abrindo `ConnectHelp` (modal com os comandos de docs/05).
- **`LessonFeed.tsx`** — linha do tempo cronológica combinando `history` (lances, com o
  `comment` do lance) e `commentary` e `humanMessages` (entregues ou não). Cada item: avatar
  por autor, categoria com ícone (💡 lesson, 🎯 plan, 💬 reaction, ❓ question, 👏 praise,
  ⚠️ warning, ℹ️ info), texto com markdown mínimo (negrito, itálico, código, listas).
  Auto-scroll para o fim quando chega item novo (a menos que o usuário tenha rolado para cima).
  Clique num lance do feed → `MoveList` seleciona a posição (preview).
- **`MoveList.tsx`** — tabela compacta `nº | brancas | pretas` + botões ⏮ ◀ ▶ ⏭. Clique navega
  (preview read-only: o tabuleiro mostra `fenAfter` do lance escolhido, com faixa
  "Visualizando lance N — voltar ao vivo"). Teclas ← → navegam, Home/End vão ao início/vivo.
  O preview é cancelado automaticamente ao trocar de partida.
- **`MessageBox.tsx`** — select destino (`todos`/`brancas`/`pretas`; só mostra cores
  ocupadas por LLM) + input + Enter envia `POST /api/message`. Estado de envio.
- **`Controls.tsx`** — dois grupos: sob o tabuleiro (Virar, FEN, PGN = link `/api/pgn` com
  `download`, Voltar lance = `POST /api/takeback` **sem** `plies`, Limpar desenho =
  `POST /api/highlight/clear`, habilitado só com destaque do ply atual) e na coluna lateral
  (Nova partida → `NewGameDialog`; Desistir com confirmação inline "Desistir mesmo? Sim,
  desisto / Não", sem `window.confirm`, e com escolha da cor quando os dois assentos são
  humanos; Empate, que vira "Aceitar empate" quando há `drawOffer` da LLM).
- **`NewGameDialog.tsx`** — escolha: "Eu de brancas vs IA", "Eu de pretas vs IA",
  "IA vs IA (assistir)", "Dois humanos"; nome do humano (lembrado em `localStorage`); FEN
  inicial opcional (campo avançado). Envia `POST /api/game`.
- **`StatusBar.tsx`** — frase de status: "Vez das brancas (você)", "Claude está pensando…",
  "Xeque!", "Xeque-mate — Claude venceu", "Felipe desistiu — Claude venceu", "Aguardando a IA
  entrar (pretas)", "Aguardando jogadores", "Empate por afogamento", "· X ofereceu empate".
  Se o assento do vencedor/perdedor ficou vazio (a LLM chamou `leave_game` depois do fim),
  usa o nome da cor ("Pretas venceu") como fallback.
- **`ConnectHelp.tsx`** — modal com os snippets de conexão (Claude Code, Claude Desktop,
  genérico), cada um com botão copiar. Conteúdo vem de `server.mcpUrl`.

## Estado e rede (`web/src/api.ts`)
- `useGameSocket()`: abre `ws://<host>/ws`, mantém `{ state, server, connected, mock }`,
  reconecta com backoff (1 s → 10 s) e ao voltar a aba para o primeiro plano. Fonte única
  de verdade = último `state` recebido.
- `api.move(uci)`, `api.newGame(req)`, `api.message(req)`, `api.takeback(plies?)`,
  `api.resign(color?)`, `api.draw(color?)`, `api.clearHighlight()` — `fetch` com
  `ApiError` (`status`, `legalMoves`). **O corpo das respostas dos POSTs é ignorado**: a UI
  se atualiza pelo broadcast WS; só o erro (4xx) é usado (toast, com até 12 lances legais).
- `?mock=1` na URL: usa o fixture de `web/src/dev/fixtures.ts`, não abre WebSocket e os
  POSTs só registram no console (bom para ajustar CSS sem servidor).
- Em dev, Vite faz proxy de `/api`, `/ws` (ws: true) e `/mcp` para `http://localhost:3939`
  (`VITE_BACKEND` para trocar).

## Sons (opcional, pequeno)
Sintetizados com Web Audio em `web/src/sound.ts` (`move`, `capture`, `check`, `end`), sem
arquivos. Toggle 🔊/🔇 no header, preferência em `localStorage`.

## Acessibilidade e detalhes
- Tabuleiro com coordenadas visíveis; contraste mínimo AA nos textos.
- `aria-live="polite"` no `StatusBar` e no último item do feed.
- Título da aba muda para "♟ Sua vez — LLM Xadrez" quando é vez do humano (útil quando a
  aba está em segundo plano) e volta ao normal depois.
- Favicon: peça de xadrez em SVG inline (`web/public/favicon.svg`).
