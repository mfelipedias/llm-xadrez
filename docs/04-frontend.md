# 04 — Frontend (a mesa e o caderno)

Vite + React 19 + TypeScript, em `web/`. Idioma da UI: pt-BR. Sem biblioteca de UI: CSS
próprio em `styles.css` sobre tokens semânticos, e as APIs nativas do navegador
(`<dialog>`, `popover`) no lugar de um Radix da vida.

A forma atual vem do [plano 10](10-plano-redesign-ux.md) — direção **"partida comentada"**,
um caderno de estudos ao lado do tabuleiro — e ganhou os assentos de bot do
[plano 09](09-plano-provedores-gateway.md).

## Direção visual e tokens

- **Duas vozes tipográficas**: a UI usa a sans do sistema (`--font-ui`); o que a professora
  escreve usa **Literata** (`--font-read`), serifa de leitura, **auto-hospedada** em
  `web/public/fonts/literata-latin-var.woff2` (+ itálico), variável `200 900`, OFL 1.1,
  `font-display: swap`. Sem Google Fonts, sem requisição a terceiros.
- **Tema claro e escuro** a partir dos mesmos tokens semânticos. O padrão é o do sistema
  (`prefers-color-scheme`); o botão no header cicla sistema → claro → escuro e a escolha
  fica em `localStorage` (`xadrez.theme`), aplicada como `data-theme` em `<html>`.
- **Cores por significado**, não por enfeite: `--text`/`--text-muted`/`--text-faint` para
  texto; `--ink` (voz das brancas), `--ink-2` (voz das pretas), `--good`, `--attn`,
  `--threat` para estado. Tabela completa e razões de contraste no
  [anexo §8.1 do plano 10](10-plano-redesign-ux.md#81-tokens-de-design-propostos).
- **Presets de casas** (`data-board`, em `localStorage`): "Papel e oliva" (padrão),
  "Madeira", "Ardósia".
- `prefers-reduced-motion` desliga as animações, inclusive a da peça.

## Layout

Desktop (≥ 1100 px): duas colunas — a **mesa** à esquerda, o **caderno** à direita.

```
┌───────────────────────────────────────────────────────────────────────────┐
│ ♞ LLM Xadrez v0.1.0   ● conectado  [1 IA conectada] [Provedores] [◐] [🔊] │ header
├───────────────────────────────────┬───────────────────────────────────────┤
│  ● Claude · pensando há 8 s   ⋯   │  Aula  6    Lances  6    (Ações)      │ abas
│  openrouter · claude-sonnet-4.6   │  ┌──────────────────────────────────┐ │
│  12k tok · US$ 0,03               │  │ 1. e4          Você        12:27 │ │
│ ┌───────────────────────────────┐ │  │ 1… e5          Claude      12:27 │ │
│ │                               │ │  │   Disputo o centro de igual      │ │
│ │          TABULEIRO            │ │  │   para igual.                    │ │
│ │   coordenadas fora das casas  │ │  │ 💡 Claude · Aula                 │ │
│ │                               │ │  │   Repare que o bispo de c4…      │ │
│ └───────────────────────────────┘ │  │ ❓ Você → Claude   · entregue    │ │
│  ○ Felipe · sua vez         ♟♟    │  └──────────────────────────────────┘ │
│  ⟲ 1. e4 e5  2. ♘f3 ♞c6  3. ♗c4  │  [Pergunte à professora…]   [Enviar]  │
├───────────────────────────────────┤                                       │
│ [↻ Virar] [↶ Voltar lance] [FEN]  │  [Nova partida] [Empate] [Desistir]   │
│ [PGN] [Limpar desenho] [Casas ▾]  │                                       │
└───────────────────────────────────┴───────────────────────────────────────┘
```

- **≤ 1099 px (tablet)**: as ferramentas secundárias do tabuleiro (FEN, PGN, limpar
  desenho, preset de casas) entram num menu **"⋯"** e só "Virar" e "Voltar lance" ficam
  à vista. Medido: a 1024 px os seis controles mais o `select` quebravam em duas linhas e
  comiam ~40 px de altura do tabuleiro.
- **≤ 900 px**: coluna única. (O plano previa 768; a 900 px as duas colunas já deixavam o
  tabuleiro menor do que ele fica sozinho.)
- **≤ 767 px (celular)**: o último comentário vira um balão colado ao tabuleiro, o caderno
  ganha a aba **Ações** (que guarda as ferramentas e os botões de partida), as abas grudam
  no topo e o campo de mensagem no rodapé. Alvos de toque sobem para 44 px.

Capturas por fase em [`docs/img/redesign/`](img/redesign/): `f0-*` (fundação visual, com
`atual-*` ao lado para comparar), `f1-*` (mesa), `f2-*` (caderno e onboarding), `f3-*`
(teclado e revisão) e `f4-*` (espectador e polimento), cada um em desktop, tablet, celular
e tema claro.

## Componentes (`web/src/components/`)

### A mesa

- **`Board.tsx`** — `react-chessboard` 5 (`<Chessboard options={{...}} />`).
  - `position = fen` exibido (ao vivo ou revisão); orientação = cor do humano (ou brancas
    se espectador / dois humanos); botão virar.
  - Interativo apenas se `status === "active"`, `seats[turn].kind === "human"`, fora da
    revisão e com WebSocket conectado.
  - Ao soltar/clicar destino: valida localmente com `chess.js`; se legal, aplica o **lance
    otimista** (a peça já vai para o destino) e chama `POST /api/move`. Se o servidor
    recusar, a peça **volta animada** e o erro vira toast — sem remontar o tabuleiro.
  - **Promoção:** overlay próprio (`.promotion`) em vez do diálogo da lib; o lance só é
    enviado depois da escolha (`e7e8q`).
  - Clique-clique: selecionar origem, destinos legais com pontos (capturas com anel),
    clicar destino. Clicar a mesma casa desmarca.
  - Destaques via `options.squareStyles`: último lance (origem e destino, este mais forte),
    rei em xeque, `highlight.squares`, seleção e destinos. Setas via `options.arrows`, com
    **halo escuro** para funcionar sobre casa clara e escura.
  - **Regra do destaque:** o servidor não apaga `state.highlight` ao jogar; o `App` só
    repassa o destaque (e habilita "Limpar desenho") quando `highlight.ply === state.ply` e
    não há revisão. Em revisão, o `highlight` anexado ao comentário daquele ply é desenhado
    no lugar.
  - Nota para automação (Playwright): a lib usa sensores de ponteiro do dnd-kit; um `drag`
    "instantâneo" não move a peça — use clique-clique, o teclado, ou `mousedown` + vários
    `mousemove` + `mouseup`. As casas têm `data-square="e4"`.
- **`BoardKeyboard.tsx`** — camada de teclado: uma grade `role="grid"` transparente de 64
  células por cima do tabuleiro, com `pointer-events: none` e **uma** parada de tabulação
  (roving tabindex). Setas movem a casa ativa, Enter/Espaço selecionam e jogam, Esc
  cancela, Home/End vão às pontas da fileira, e "letra + número" pula direto para a casa.
  Cada casa se anuncia como `"e4, peão branco, destino possível"`. Roteiro completo em
  [docs/12](12-teclado.md).
- **`BoardFrame.tsx`** — moldura com as coordenadas **fora** das casas, e o rótulo
  "Revisando 11… ♞f6" quando está no histórico.
- **`SeatPlate.tsx`** — uma placa por assento, na largura do tabuleiro: adversário em cima,
  você embaixo. Substituiu `Seats` **e** o texto de vez/xeque que ficava no `StatusBar`.
  Mostra nome, tipo (`humano` / `IA via MCP` / o bot), de quem é a vez, peças capturadas e
  saldo de material. Em três situações ela muda de cara:
  - **assento MCP**: "sem conexão" se a sessão sumiu de `server.mcpSessions`; "aguardando"
    se `waiting === true` (bloqueada em `wait_for_turn`); "pensando…" se `lastSeenAt` < 3 s;
    senão "ociosa";
  - **assento de bot** (docs/09): provedor · modelo, o status do loop (`pronta`,
    `esperando a vez`, `pensando…`, `jogando…`, `erro`, `limite de gasto atingido`,
    `parada`), o contador "pensando há N s" a partir de `bot.thinkingSince` (que fica em
    tom de alerta depois de 90 s), e o uso discreto — `12k tok · US$ 0,03 · 1 ilegal`.
    O menu **"⋯"** (`popover` nativo) leva **Parar / Retomar**, **Trocar de modelo** e
    **Liberar assento**;
  - **modo espectador** (IA vs IA): a placa vira balão de professor, com o último
    comentário daquela IA na tinta da voz dela (`--ink` / `--ink-2`).
- **`MoveRibbon.tsx`** — régua de lances sob o tabuleiro, onde os olhos já estão: uma
  linha rolável que se auto-centra no lance ativo, com o botão "voltar ao vivo" e, quando
  chegam lances durante a revisão, o contador "+N" nele ("2 lances novos ao vivo" para o
  leitor de tela).
- **`GameBanner.tsx`** — o fim de partida na mesa: resultado, e as ações do momento
  (revisar, nova partida, PGN).
- **`BoardTools.tsx`** — Virar, Voltar lance (`POST /api/takeback` **sem** `plies`), FEN,
  PGN (link `/api/pgn` com `download`), Limpar desenho e preset de casas. Entre 768 e
  1099 px, as quatro últimas vão para o menu "⋯".

### O caderno

- **`Notebook.tsx`** — a coluna da aula, com abas **Aula / Lances** (e **Ações** no
  celular). Reúne o feed, o campo de mensagem colado ao pé e o contador de itens novos.
- **`Annotation.tsx`** — um item do feed: lance, comentário ou mensagem. Cada item é um
  `article` com autor, categoria (ícone SVG **+ rótulo em texto**), hora e markdown
  mínimo; lances são botões ("Ver posição após 11…d6"); o desenho anexado ganha descrição
  em texto oculto; o estado da mensagem ("entregue"/"aguardando") é palavra, não cor.
- **`MoveList.tsx`** — a tabela `nº | brancas | pretas`, agora como aba "Lances". No
  desktop a navegação principal continua sendo a régua.
- **`MessageBox.tsx`** — `textarea` que cresce com o texto (Enter envia, Shift+Enter quebra
  linha) e destino com rótulo visível. Com duas IAs na mesa, o destino vira chips
  ("todos · Claude Desktop · Claude Code"); com uma só, não há escolha e o seletor some.
  Assentos `bot` contam como IA para tudo isso.
- **`San.tsx` / `Figurine.tsx`** — notação com **figurinhas SVG** (`♞f3`), desenhadas em
  `currentColor`, com a leitura em português escondida ao lado ("cavalo f3") para leitor
  de tela. Substituíram os glifos Unicode, que dependiam da fonte de símbolos do sistema.
- **`CategoryIcon.tsx`** — o ícone SVG de cada categoria de comentário (aula, plano,
  reação, pergunta, elogio, alerta, sistema), sempre acompanhado do rótulo.

### Diálogos, avisos e onboarding

- **`Modal.tsx`** — `<dialog showModal()>` nativo: armadilha de foco, Esc, `inert` no resto
  da página e devolução do foco a quem abriu, em zero byte de biblioteca.
- **`ConnectWizard.tsx`** — o caminho principal de "zero → IA conectada": enquanto falta
  alguém no tabuleiro, a coluna do caderno (que estaria vazia mesmo) mostra **quatro
  passos com detecção automática** — 1. servidor no ar (WebSocket conectado; parado, o
  texto diz `docker compose up -d` ou `npm start` conforme `server.runtime`), 2. cliente
  registrado (`server.mcpSessions` tem uma sessão com `active !== false`, mesmo sem
  assento — sessões velhas, prestes a expirar, não contam), 3. aula pedida no chat, 4. IA
  na partida (a sessão sentou; o painel se fecha). O passo 2 escolhe o cliente (Claude
  Code / Claude Desktop / Claude.ai e ChatGPT / Codex / Outro, lembrado em
  `localStorage`) e traz a URL do `/mcp` com botão copiar. A frase do passo 3 muda com a
  partida: com um assento esperando, *"entre na partida de xadrez que está esperando
  (join_game) e jogue de pretas"*.
- **`ConnectHelp.tsx`** — "ver todas as opções": os snippets de conexão de
  [docs/05](05-conectar-clientes.md), cada um com copiar, e um atalho para a tela
  "Provedores" ("ou deixe o próprio servidor jogar"). Os snippets dos dois componentes
  vêm de **`web/src/connect.ts`** e dependem de `server.runtime` e `server.mcpAuth`: com
  token, levam o marcador `<MCP_TOKEN>` (a UI nunca conhece o valor) e um aviso de que ele
  está no `.env`.
- **`NewGameDialog.tsx`** — **um seletor por assento** (Humano / Aguardar MCP / Bot do
  servidor), com os quatro modos antigos virando atalhos que só preenchem os seletores.
  Quando o assento é bot, entra o `BotPicker`; se o provedor for pago, um aviso inline diz
  o limite que a partida vai respeitar. Nome do humano lembrado em `localStorage`; FEN
  inicial opcional no campo avançado.
- **`BotPicker.tsx`** — perfil pronto **ou** "provedor + modelo" (`GET
  /api/providers/:id/models`). Nenhuma chave aparece aqui: se o provedor precisa de uma e
  ela não está no ambiente, a UI mostra o **nome da variável que falta** e nada mais.
- **`ChangeBotDialog.tsx`** — "Trocar de modelo" de um assento de bot
  (`POST /api/bots/:color/resume`); é também o caminho para retomar um bot parado por erro
  ou por orçamento.
- **`ProvidersDialog.tsx`** — a tela **Provedores**, no botão do header (que só aparece
  quando o servidor expõe a camada). Lista os provedores com estado (● ok / ○ sem chave /
  ✗ erro), testa a conexão (resultado e a **dica** do servidor em destaque no cartão),
  lista modelos com busca, cria provedores (**"Novo provedor"**: nome, id gerado do nome,
  tipo de API, URL base com atalhos — Ollama/LM Studio nesta máquina, com
  `host.docker.internal` quando `runtime === "docker"`, outra máquina da rede, URL remota —,
  variável da chave com `datalist` de `envKeys`, modo de ferramenta, local/pago, timeout em
  segundos) e edita os existentes (campo opcional vazio vai como `null` e limpa). Salvar
  roda o teste em seguida. Erros de campo com `aria-invalid` + `aria-describedby`, foco no
  primeiro inválido; depois de criar, o foco vai para o título do cartão novo. Se o
  servidor recusa com `403 admin_forbidden`, a tela pede o **token de administração**
  (guardado em `sessionStorage`, `xadrez.adminToken`, e mandado como `Authorization:
  Bearer` em gravação, teste e modelos) e repete a ação; sem token aceito, fica em leitura e
  explica `ADMIN_TOKEN`/`ADMIN_ALLOW_FROM`. `canAdmin` do `GET /api/providers` mostra esse
  estado logo ao abrir. **A chave de API nunca passa por aqui**: o campo é somente leitura e mostra o que o
  servidor devolve (`sk-or-…a1b2`); o que se edita é o *nome da variável de ambiente*.
  Perfis de bot são listados **em leitura** — não existe CRUD de perfis, e a tela diz isso:
  quem quiser mudar um perfil edita o `providers.json`.
- **`Toaster.tsx`** — `role="alert"` no erro, `role="status"` na informação, botão fechar
  em todos, 10 s para erro e 4 s para informação, e o relógio **pausa** enquanto o ponteiro
  está sobre a pilha ou há foco dentro dela. Um toast pode ficar até ser fechado
  (`timeout: 0`) e levar uma ação: é o caso do **aviso de bot parado** — quando um assento
  de bot entra em `error` ou `budget_exceeded`, o toast não some sozinho e traz o botão
  **Retomar** ([`ui-bot-erro.png`](img/ui-bot-erro.png)).
- **`GameActions.tsx`** — Nova partida (primária), Empate (vira "Aceitar empate" com
  oferta pendente) e Desistir, cuja confirmação é um `popover` nativo com o foco inicial em
  "Cancelar", nunca na ação destrutiva. No modo espectador, desistir e empate somem.
- **`LiveRegions.tsx`** — duas regiões `aria-live` **fixas**, que existem desde o primeiro
  render e vazias: `#sr-moves` (lance, xeque, de quem é a vez) e `#sr-comments` (comentário
  novo, inteiro). Antes o `aria-live` era posto no último item do feed, e um atributo que
  migra de nó não é anunciado.
- **`ThemeToggle.tsx`**, **`CopyButton.tsx`** — utilitários.

## Estado e rede (`web/src/api.ts`)

- `useGameSocket()`: abre `ws://<host>/ws`, mantém `{ state, server, connected, mock }`,
  reconecta com backoff (1 s → 10 s) e ao voltar a aba para o primeiro plano. Fonte única
  de verdade = último `state` recebido. Mensagens tratadas: `hello`, `state`, `server` e
  **`bot`** — esta última aplica o patch de status/uso no assento e em `server.bots` sem
  esperar um `state` novo, para a placa não piscar.
- `api.move`, `newGame`, `message`, `takeback`, `resign`, `draw`, `clearHighlight`;
  `api.bots.{sit,stop,resume,leave}`; `api.providers.{list,test,models,save,addPreset,remove}`.
  Tudo com `ApiError` (`status`, `legalMoves`, e `code`/`adminTokenAccepted`/`hint` quando
  o servidor manda). `getAdminToken`/`setAdminToken` cuidam do token de administração. **O corpo dos POSTs é ignorado**: a UI se
  atualiza pelo broadcast WS; só o erro (4xx) é usado.
- Em dev, Vite faz proxy de `/api`, `/ws` (ws: true) e `/mcp` para `http://localhost:3939`
  (`VITE_BACKEND` para trocar).

### Cenários sem servidor (`?mock=…`)

`web/src/dev/fixtures.ts` serve um `GameState` + `ServerInfo` completos, sem WebSocket; os
POSTs de jogo só aparecem no console. As rotas `/api/providers*` respondem em todos os
cenários — leitura com fixture, e gravação (PUT, preset, DELETE) numa cópia em memória, com
teste de conexão simulado (inclusive falhas com `hint`) — para a tela "Provedores" poder
ser vista e exercitada sem backend. `&admin=token` simula um navegador de outro computador
com token aceito (403 até digitar qualquer token); `&admin=none`, sem token aceito. Úteis para ajustar CSS e
para gerar capturas sempre iguais:

| URL | Cenário |
|-----|---------|
| `?mock=1` | meio-jogo, humano (brancas) vs IA via MCP (pretas) |
| `?mock=waiting` | aguardando a IA conectar — é o que abre o `ConnectWizard` |
| `?mock=llmvsllm` | espectador: duas IAs via MCP jogando |
| `?mock=finished` | partida encerrada por xeque-mate |
| `?mock=empty` | nenhuma partida começou, os dois assentos livres |
| `?mock=bots` | humano (brancas) vs **bot do servidor** (pretas), pensando |
| `?mock=botsvsbots` | dois bots do servidor jogando: espectador com balões duplos |
| `?mock=docker` | servidor em Docker com `MCP_TOKEN`: pretas esperando MCP, uma sessão inativa que não conta como conectada |

Capturas desta rodada (formulário de provedor, dica de teste, token de administração,
onboarding em Docker) em [`docs/img/conexoes/`](img/conexoes/).

Qualquer outro valor cai no cenário padrão.

## Sons (`web/src/sound.ts`)

Sintetizados com Web Audio, sem arquivo de áudio: `move`, `capture`, `check`, `end`,
`comment` e `join`. Ligados por padrão, preferência em `localStorage`, e só tocam depois da
primeira interação (regra de autoplay). Os dois últimos são discretos de propósito: numa
partida IA vs IA eles tocariam muitas vezes.

## Favicon e título da aba (`web/src/favicon.ts`)

O mesmo cavalo do `public/favicon.svg`, redesenhado em `data:` com um ponto no canto quando
há algo esperando por você: **sua vez** (âmbar) ou **comentário novo não lido** (azul). O
título da aba acompanha ("♟ Sua vez — LLM Xadrez" ou "💬 <começo do comentário> — LLM
Xadrez") e volta ao normal quando a aba reaparece.

O módulo também prevê um estado `thinking` (ponto cinza), **hoje sem uso**: o `App` só
chama `setFavicon` com `turn`, `comment` e `idle`.

## Acessibilidade

Meta: WCAG 2.2 AA. O que foi **medido**, e como:

- **axe-core 4.x via Playwright**, com as tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`,
  `wcag22aa` e `best-practice`: **0 violações em 17 cenários**, incluindo com `<dialog>` e
  `popover` abertos.
- **Contraste, alvos de toque e reflow** calculados por `getComputedStyle` — o mesmo
  medidor do diagnóstico do plano 10: 0 textos abaixo de 4,5:1, 0 alvos abaixo do mínimo
  (24 px no desktop, 44 no celular), sem rolagem horizontal em 1440, 1024 e 390 px.
- **Uma partida inteira jogada só com o teclado**, contra o servidor real. Roteiro
  reproduzível em [docs/12](12-teclado.md).

**O Lighthouse nunca rodou** neste projeto: não há Chrome nem LH CLI nesta máquina, e
nenhuma fase produziu nota dele. Onde o plano 10 pedia "Lighthouse a11y ≥ 95", o que
existe é a medição acima.

Ainda **não verificado**: leitura com NVDA ou VoiceOver de verdade (os anúncios foram
conferidos pelo conteúdo das regiões `aria-live`, não por um leitor de tela real).

Decisões que a leitura do código pode estranhar:

- O balão do último comentário no celular é `aria-hidden`: o mesmo comentário está, com
  autor e categoria, no primeiro item da aba "Aula" logo abaixo. Por isso ele também não
  tem botão "ver tudo" — um elemento focável dentro de conteúdo `aria-hidden` viola
  `aria-hidden-focus`.
- A grade de teclado do tabuleiro tem `pointer-events: none` e é **uma só** parada de
  tabulação; os `div[role="button"]` que o dnd-kit injeta são saneados pelo seletor
  `[aria-roledescription="draggable"]` — cuidado ao atualizar o `react-chessboard`
  ([docs/12](12-teclado.md) explica).
