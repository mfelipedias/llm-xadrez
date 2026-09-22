# 10 — Plano de redesign de UX/UI

Documento de planejamento (nada aqui foi implementado). Base: `docs/00-visao.md`,
`docs/04-frontend.md`, `docs/02-contrato-mcp.md`, `shared/types.ts`, `web/src/**` e as
capturas em `docs/img/` e `docs/img/redesign/atual-*.png` (estado atual em `?mock=1`,
capturadas em 1440×900, 1024×768 e 390×844).

Contexto que orienta todas as escolhas: **uma pessoa aprendendo xadrez com uma IA que fala
como professora**, uso pessoal, desktop e celular, servidor local (pode estar off-line).
O produto não é "um site de xadrez": é uma **aula com tabuleiro**. O tabuleiro é o objeto de
estudo; o comentário da professora é o conteúdo; a lista de lances é o índice.

---

## 1. Diagnóstico da UI atual

Capturas de referência: `docs/img/redesign/atual-desktop.png`, `atual-tablet.png`,
`atual-mobile-top.png`, `atual-mobile-bottom.png`, `atual-dialog-nova-partida.png`,
`atual-dialog-conectar.png`.

### 1.1 Hierarquia visual
- **Tudo é um card igual.** `Seats`, `LessonFeed`, `MoveList`, `StatusBar`, `Modal` e os
  itens do feed usam o mesmo trio `background: var(--bg-elev)` + `border: 1px var(--border)`
  + `border-radius` (`styles.css` §assentos, §feed, §status). O tabuleiro — protagonista —
  fica cercado por caixas do mesmo peso; nada diz "olhe aqui primeiro".
- **A informação "de quem é a vez" aparece três vezes** com pesos diferentes: badge `VEZ`
  no `SeatCard` (`Seats.tsx`), borda azul no assento (`.seat-turn`) e a frase do `StatusBar`
  ("Vez das brancas (você)") embaixo do tabuleiro. O `StatusBar` ainda concorre com o
  `preview-banner` (mesma largura, posição diferente).
- **Assentos como dois cards lado a lado acima do tabuleiro** (`.seats` grid 1fr 1fr) não
  seguem a convenção que qualquer app de xadrez usa (adversário em cima, eu embaixo). Em
  celular viram dois blocos empilhados (`@media 520px`) e empurram o tabuleiro ~170 px para
  baixo (`atual-mobile-top.png`).
- **Header com três ações do mesmo peso** ("conectado", "Conectar IA", som). "Conectar IA" é
  a ação nº 1 da primeira execução e está num `btn-small` no canto.
- **Peças capturadas** (`capturedRow` em `App.tsx`) ficam no rodapé da coluna, em texto
  pequeno; em celular viram duas linhas soltas entre o status e o feed.

### 1.2 Densidade e legibilidade
- Base de 15 px (`html, body`) com muitos textos em 0.68–0.85 rem: `feed-time` 10.8 px,
  `feed-tag` 10.2 px, `panel-subtitle` 11.7 px, `messagebox-hint` 11.25 px, `brand-version`
  11.25 px (medidos em `atual-desktop.png` via `getComputedStyle`).
- **Fonte monoespaçada para lances** (`.feed-move-san`, `.movelist table`): notação lida como
  código, não como xadrez. Livros e apps de xadrez usam sans/serif com figurinhas ou letras
  em peso alto.
- **Etiquetas em caixa alta com tracking** em `panel-title` ("AULA", "LANCES"), `seat-head`
  ("BRANCAS"), `feed-tag` ("CAPTURA", "ENTREGUE") — ruído tipográfico que compete com o
  conteúdo real (o comentário).
- O texto do comentário (`.feed-comment` 0.93 rem ≈ 14 px, line-height 1.45) é o conteúdo
  mais importante da tela e é o que recebe menos cuidado tipográfico: mesma fonte, mesmo
  tamanho da UI, medida de ~62 caracteres numa coluna de 430 px (ok) mas com cabeçalho de
  metadados (avatar emoji + nome + categoria + tag + hora) mais alto que a primeira linha.
- Emojis como ícones (`CATEGORY_META`, `authorIcon`, 🔊/🔇) rendem diferente em cada SO e
  quebram a paleta (o 🤖 roxo em `atual-desktop.png` é o único roxo da tela).

### 1.3 Fluxo de "primeira partida" (zero → IA conectada)
Sequência real hoje (`App.tsx`, `Seats.tsx`, `ConnectHelp.tsx`):
1. Abre `localhost:3939` → `loading-card` "Conectando ao servidor…" → estado inicial
   (assento humano + assento vazio, `status: waiting`).
2. O assento vazio mostra "Aguardando IA — conecte via MCP", URL + botão copiar e um link
   "como conectar?" → modal com **quatro** blocos de snippet de uma vez (Claude Code, Claude
   Desktop com JSON de 12 linhas, genérico, duas IAs). O usuário precisa escolher qual é o
   seu caso e sair da UI para o terminal/app.
3. Depois de registrar o servidor, ele precisa **saber** que tem de falar no chat ("vamos
   jogar xadrez…"). Isso está no parágrafo introdutório do modal, em itálico.
4. **Não há feedback de que o cliente conectou** enquanto a IA não chama `new_game`/
   `join_game`. `ServerInfo.mcpSessions` já traz a sessão sem assento (`seat` undefined), mas
   a UI ignora esse estado intermediário — o único sinal é o assento continuar "vazio".
5. Dois caminhos concorrentes para criar a partida: o botão "Nova partida" do navegador
   (`NewGameDialog`) e o `new_game` da IA. Se o usuário cria primeiro no navegador e depois
   a IA chama `new_game`, a partida é substituída e a cor pode mudar. O `NewGameDialog` não
   explica isso ("a IA entra nas pretas via MCP" sugere que basta esperar).

Resultado: o momento mais frágil do produto (a pessoa ainda não viu nenhum valor) é um
modal com código, sem progresso e sem confirmação automática.

### 1.4 Estados vazios e de espera
- Feed vazio: uma linha cinza "Os lances e os comentários da IA aparecerão aqui." Não
  orienta (o que fazer agora?).
- Lista de lances vazia: "A partida ainda não começou." — redundante com o status.
- "IA pensando…" só existe como texto pequeno no assento (`SeatActivity`, janela de 3 s
  baseada em `lastSeenAt`) e como frase do `StatusBar`. Nada no tabuleiro indica espera.
- `wait_for_turn` em curso aparece como "aguardando" (verde) — para o aluno "aguardando"
  soa como "a IA está esperando *você*", o que é correto quando é a vez do humano e
  confuso quando não é.
- Fim de partida: só o `StatusBar` muda de cor. Não há momento de encerramento (resultado,
  motivo, botão "revisar" / "nova partida" no lugar certo).

### 1.5 Feedback de erro
- Toasts (`App.tsx` `notify`) somem em 6 s, não têm botão fechar nem `role`, ficam num
  container `aria-live="assertive"` (interrompe o leitor de tela para "FEN copiado").
- Lance ilegal: o tabuleiro é remontado (`boardResetKey`) — a peça "pisca" de volta sem
  animação — e o toast lista até 12 lances legais em texto corrido. Na prática o humano
  quase nunca vê esse erro (validação local com `chess.js` já bloqueia), então o caso
  real é "servidor recusou" (não é sua vez / partida acabou / sem conexão) e a mensagem
  não diz o que fazer.
- Desconexão do WS: só o chip "reconectando…" no header, que **some** em telas < 520 px
  (`.conn { display: none }`). O tabuleiro continua interativo até o `interactive` cair.

### 1.6 Responsividade
- 1440 px: tabuleiro 600 px (limitado por `calc(100vh - 300px)`), feed 453 px de altura,
  lista de lances 230 px. Sobra espaço vertical; o feed mostra ~4 itens.
- 1024 px: tabuleiro 470 px, coluna lateral 320–430 px; o feed fica com ~3 itens e o campo
  de mensagem tem placeholder cortado ("Pergunte algo à IA… (Enter e").
- 390 px: ordem vertical header → 2 cards de assento → tabuleiro (366 px) → 5 botões →
  status → capturadas (2 linhas) → feed 380 px fixo → lances → mensagem → ações. A página
  tem ~2,5 telas de altura; **o último comentário da professora nunca está visível junto
  com o tabuleiro**, e o campo de mensagem fica a duas rolagens da posição.
- `.col-side` é `sticky` com `height: calc(100vh - 82px)`, mas o feed e a lista disputam
  altura com `flex: 1` vs `max-height: 230px`, gerando barras de rolagem aninhadas.

### 1.7 Acessibilidade (medido)
| Item | Onde | Valor | WCAG 2.2 AA |
|------|------|-------|-------------|
| `--text-faint` #6c7a8c sobre `--bg-elev` #161d27 | `feed-time`, `mv-num`, `seat-kind`, `panel-subtitle`, `brand-version` | 3.87:1 em 10.8–13.5 px | falha (1.4.3 pede 4.5:1 em texto normal) |
| `btn-primary` branco sobre #1e88e5 | "Nova partida", "Enviar", "Começar" | 3.68:1 em 13.8 px | falha |
| `feed-tag` #9aa8b8 sobre rgba(255,255,255,.07) | tags "captura", "entregue" | ~2.4:1 (em 10.2 px caixa alta) | falha |
| Tabuleiro | `#main-board` | 0 elementos focáveis; 0 `role`; sem `aria-label` por casa | falha 2.1.1 (teclado) |
| Alvos | `.mv` (2 px de padding vertical ≈ 22 px), `btn-small` ≈ 26 px | < 24×24 | falha 2.5.8 |
| `aria-live` do feed | `LessonFeed` põe `aria-live="polite"` **no último item** | o atributo migra para um nó novo a cada item: leitores não anunciam (a região precisa existir antes da mudança) | falha 4.1.3 |
| Toasts | container `aria-live="assertive"` sem `role`, sem fechar, some em 6 s | interrompe; sem 2.2.1 (tempo ajustável) | parcial |
| Modal | `role=dialog` + Esc + foco inicial no painel, mas **sem focus trap** e sem devolver o foco ao botão que abriu | 2.4.3 | parcial |
| Movimento | `pulse`, `spin`, animação de peça, `scroll-behavior: smooth`, `toast-in` sem `prefers-reduced-motion` | 2.3.3 | falha |
| Tema | só escuro (`color-scheme: dark`) | preferência do sistema ignorada | — |
| Estrutura | um único `h1`; painéis usam `header.panel-title` sem heading; `section[aria-label]` ok | 1.3.1 | parcial |
| Emojis | `aria-hidden` corretamente na maioria; 🔊 no botão tem `aria-label` ok | — | ok |
| Foco visível | `outline 2px var(--accent)` | ok, mas azul sobre borda azul no assento-da-vez some | parcial |

### 1.8 Consistência
- Três formas de "botão pequeno" (`btn-small`, `btn-icon`, `link`) e dois grupos de
  `Controls` renderizados com as **mesmas props** em lugares diferentes (`App.tsx` chama
  `<Controls group="board">` e `<Controls group="game">` passando os 9 callbacks às duas).
- Cores semânticas inconsistentes: amarelo (`--warn`) significa "preview", "pergunta",
  "mensagem pendente", "pensando" e "último lance" ao mesmo tempo; azul significa "vez",
  "aula", "foco", "primário" e "mensagem do humano".
- Vocabulário: "LLM via MCP" no assento, "IA" nos botões, "Claude" nos textos; "meios-lances"
  na lista (jargão); "ociosa" para a IA.

---

## 2. Princípios e direção visual

### 2.1 Princípios
1. **O tabuleiro é a página.** Tudo o mais é margem: nome dos jogadores, o caderno da
   professora e a régua de lances. Nenhum outro elemento recebe borda, sombra ou cor de
   fundo que dispute com ele.
2. **A voz da professora tem tipografia própria.** O comentário é texto para *ler*, não
   UI. Ele ganha uma família serifada de leitura, medida confortável e o lance a que se
   refere em destaque — exatamente como uma partida comentada num livro.
3. **Cor só quando tem significado.** Quatro cores semânticas e nenhuma decorativa:
   verde = bom/plano, âmbar = atenção/pergunta, vermelho = ameaça/xeque, tinta (azul-
   escuro) = explicação. As mesmas quatro cores valem para setas, casas, categorias de
   comentário e tags. Amarelo de "último lance" e azul de "seleção" ficam **fora** dessa
   escala (dessaturados) para não parecerem comentário.
4. **Estados de espera dizem o que está acontecendo e o que fazer.** Nada de "aguardando"
   sem objeto.
5. **Sistema, não template.** Poucos tokens, dois raios, duas sombras, uma escala tipográfica.
   Cards só onde há conteúdo agrupável (o comentário); listas são listas.

### 2.2 Direção: "partida comentada" (caderno de estudos)
Identidade tirada do próprio universo do assunto: o **livro de partidas comentadas**
(lances em negrito com figurinhas, comentário em serifa corrida, diagramas) e o **caderno
de estudo** (anotação do aluno em margem, pergunta em caneta). Não é skeuomorfismo — não
há textura de papel nem madeira — mas as convenções tipográficas do xadrez impresso.

Ver §8.2 para as alternativas consideradas e por que esta ganhou.

### 2.3 Tipografia
| Papel | Família | Justificativa |
|-------|---------|---------------|
| Voz da professora (comentários, perguntas, mensagens do aluno) | **Literata** (variável, eixo `opsz`, latin), auto-hospedada via `@fontsource-variable/literata`; fallback `Charter, "Iowan Old Style", Georgia, serif` | Serifa desenhada para leitura em tela (Google Play Books). Marca "isto é texto de aula" sem parecer jornal. Auto-hospedar porque o app roda em `localhost` e pode estar sem internet; ~4 arquivos woff2 (regular/itálico + eixo de peso) ≈ 120 KB, carregados com `font-display: swap`. |
| UI (botões, nomes, status, formulários) | pilha do sistema: `system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` | Zero bytes, nativa em cada SO, contraste claro com a serifa. Peso 500 para rótulos, 600 para nomes/ações primárias, nunca 700+. |
| Lances (SAN) | mesma sans, `font-weight: 600`, `font-variant-numeric: tabular-nums`, figurinhas SVG inline (`<San>`; ver §5) | Retira o monoespaçado. Figurinha (♘f3) é a convenção dos livros e reduz o esforço de ler "N", "B", "R" para quem está aprendendo. |
| Código (URL MCP, comandos, FEN) | `ui-monospace, "Cascadia Code", Consolas, monospace` | Só onde é código de verdade. |

Escala (base 16 px, razão ~1.2; `rem`):

| Token | px | Uso |
|-------|----|-----|
| `--fs-xs` | 12 | hora, contadores; **nunca abaixo de 12** |
| `--fs-sm` | 14 | rótulos, tags, hints |
| `--fs-md` | 16 | UI padrão, lances na régua |
| `--fs-lg` | 17 | comentário (Literata, `line-height: 1.55`) |
| `--fs-xl` | 20 | nome do jogador, título de modal |
| `--fs-2xl` | 26 | banner de fim de partida |

Medida do comentário: 60–70 caracteres (coluna de 400–440 px em Literata 17 px). Sem caixa
alta com tracking em rótulos; hierarquia por peso e cor, não por caixa.

### 2.4 Paleta e tokens (resumo; tabela completa em §8.1)
Tema escuro e claro a partir dos **mesmos tokens semânticos**. Base neutra ligeiramente
fria no escuro (não é #111 tingido; é um cinza-azulado de baixa saturação, próximo do que
já existe, para não jogar fora o que funciona) e **branco frio** no claro (não creme).

Cores semânticas (iguais nos dois temas, com variantes de contraste):
- **tinta** (`--ink`): azul-escuro `#2f5fa8` / claro `#8fb4ff` — explicação (`lesson`, `info`),
  foco, link. É a "caneta da professora".
- **verde** (`--good`): `#2e8b57` / `#5fcf8a` — plano, elogio, seta "boa ideia".
- **âmbar** (`--attn`): `#b7791f` / `#f2c14e` — pergunta, atenção, mensagem pendente.
- **vermelho** (`--threat`): `#c5382f` / `#ff7b72` — ameaça, xeque, desistir.
- **grafite** (`--student`): `#5b6470` / `#a8b0bb` — o aluno (mensagens do humano).

Elas passam AA sobre os fundos de texto correspondentes (verificar com a tabela em §8.1
antes de implementar; os valores escuros foram escolhidos para ≥ 4.5:1 sobre `#151a21`).

### 2.5 Tabuleiro
- **Casas**: preset padrão "papel e oliva" — clara `#ece6d6`, escura `#7f8f66`. Justificativa:
  o verde-oliva dessaturado deixa as setas verdes (`#2e8b57`) ainda legíveis (diferença de
  saturação e luminosidade) e as vermelhas/azuis saltam; o "papel" conversa com a serifa.
  Preferência persistida em `localStorage` com dois presets alternativos: "madeira"
  (`#f0d9b5` / `#b58863`, o mais familiar para quem vem do lichess) e "ardósia" (o atual
  `#dfe6ec` / `#7a94a8`).
- **Peças**: manter o conjunto padrão do react-chessboard (derivado do cburnett, o mais
  legível em tamanhos pequenos). Não trocar por Unicode nem por conjunto ornamental.
- **Coordenadas**: **fora** das casas, numa moldura de 18 px ao redor do tabuleiro
  (`BoardFrame`), `--fs-xs`, cor `--text-muted`. Dentro das casas (como hoje, `showNotation`)
  as letras competem com as peças e com os destaques. Moldura também dá lugar ao "quem está
  em cima/embaixo" e ao indicador de vez.
- **Último lance**: lavagem âmbar dessaturada a 35 % (`color-mix(in oklab, var(--attn) 35%, transparent)`)
  na origem e 45 % no destino. Hoje é #f6d55c a 45/55 %, que briga com casas amarelas de
  destaque da IA.
- **Xeque**: radial vermelho no rei (manter), mais **contorno** 2 px na casa para quem não
  distingue vermelho/verde.
- **Setas e casas da IA** (`highlight`): mapear `green/red/blue/yellow` para os quatro
  semânticos; setas com **halo** branco/escuro de 1 px (via `filter: drop-shadow` no SVG
  do react-chessboard, `.board-wrap svg [data-arrow]` — validar seletor na versão instalada)
  para legibilidade sobre qualquer casa. Casas destacadas: preenchimento a 55 % + contorno
  interno 3 px da mesma cor (redundância para daltonismo).
- **Seleção/destinos legais**: seleção com contorno `--ink` (não preenchimento), destinos com
  ponto `--text` a 30 % (manter), capturas com anel (manter).
- **Modo revisão**: em vez do `inset 3px var(--warn)`, a moldura inteira muda para o tom
  "papel" com o rótulo "revisando lance 12" na própria moldura, e o tabuleiro perde a
  sombra — sinal claro de "isto é uma cópia", sem parecer alerta.

### 2.6 Espaçamento e ritmo
Escala de 4 px: `--sp-1: 4`, `-2: 8`, `-3: 12`, `-4: 16`, `-5: 24`, `-6: 32`, `-7: 48`.
Regra: dentro de um componente `sp-2/3`; entre componentes `sp-4/5`; entre regiões `sp-6`.
Raio: `--r-sm: 6` (controles), `--r-md: 10` (cartão de comentário), tabuleiro `--r-sm`.
Sombra: só no tabuleiro (ao vivo) e em modais/toasts. Mais nada flutua.

---

## 3. Arquitetura de informação e layout

### 3.1 Regiões
1. **Cabeçalho mínimo**: marca, estado da conexão (sempre visível, também no celular como
   ponto colorido), tema, som, "Conectar IA" só quando há assento vazio (senão vira
   "IAs conectadas: 1" com popover).
2. **Mesa**: placa do adversário (em cima) → tabuleiro com moldura → placa do jogador
   (embaixo) → régua de lances → ferramentas do tabuleiro. Quando o humano é espectador,
   pretas em cima, brancas embaixo (convenção), botão "virar" mantém.
3. **Caderno** (coluna direita no desktop; painel inferior/aba no celular): feed da aula,
   campo de mensagem colado ao fim do feed (é a mesma conversa), ações da partida no rodapé.
4. **Camadas**: toasts (canto inferior direito no desktop, topo no celular), modais
   (`<dialog>`), banner de fim de partida sobre a mesa.

### 3.2 Desktop (≥ 1100 px)

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│ ♞ LLM Xadrez                                        ● conectado   ☾ tema  ♪ som    │
├───────────────────────────────────────────┬────────────────────────────────────────┤
│  ● Claude · pensando ▮▮▮        ♟♟♞ +1   │  Caderno                               │
│  ┌─┬─┬─┬─┬─┬─┬─┬─┐                        │                                        │
│ 8│ │ │ │ │ │ │ │ │                        │  11. ♖xe4  Felipe            00:04     │
│ 7│ │ │ │ │ │ │ │ │                        │  ┃ Claude · pergunta                   │
│ 6│ │ │ │ │ │ │ │ │   moldura com          │  ┃ Você recuperou o peão com 11.♖xe4.  │
│ 5│ │ │ │ │ │ │ │ │   coordenadas fora     │  ┃ Pergunta: qual peça branca ainda    │
│ 4│ │ │ │ │ │ │ │ │                        │  ┃ não entrou no jogo?                 │
│ 3│ │ │ │ │ │ │ │ │                        │                                        │
│ 2│ │ │ │ │ │ │ │ │                        │  11… d6  Claude                        │
│ 1│ │ │ │ │ │ │ │ │                        │  ┃ Abro a diagonal do bispo de c8…     │
│  └─┴─┴─┴─┴─┴─┴─┴─┘                        │                                        │
│   a b c d e f g h                         │  ┃ Claude · atenção  ✎                 │
│  ○ Felipe · sua vez        ♟♟ +0          │  ┃ Meu bispo de f6 e o cavalo de e7    │
│                                           │  ┃ vigiam d5…                          │
│  ⟲ 1.e4 e5 2.♘f3 ♘c6 3.♗c4 … 11.♖xe4 d6 ▸ │      Felipe → todos · aguardando       │
│  (régua rolável; ← → navegam)             │      qual seria um bom plano…          │
│                                           ├────────────────────────────────────────┤
│  ↻ virar   voltar lance   limpar desenho  │ [para: todos ▾] Pergunte à professora… │
│  FEN · PGN                                ├────────────────────────────────────────┤
│                                           │ Nova partida        Empate   Desistir  │
└───────────────────────────────────────────┴────────────────────────────────────────┘
```

Decisões de layout:
- **Placas** (`SeatPlate`) substituem os dois cards: uma linha cada, alinhada à largura do
  tabuleiro, com disco ○/● da cor, nome, estado (para IA) e capturas + saldo de material à
  direita. A placa de quem tem a vez ganha um traço `--ink` de 3 px na borda esquerda e o
  texto "sua vez" / "pensando" — o `StatusBar` desaparece; seu texto de fim de partida
  migra para o `GameBanner`.
- **Régua de lances** (`MoveRibbon`) sob o tabuleiro: uma linha horizontal rolável, lance
  ativo com fundo "papel", auto-rolagem para o fim. Substitui a tabela `MoveList` no
  desktop (a tabela fica disponível como visão alternativa no Caderno — aba "Lances" — para
  quem prefere colunas). Justificativa: a régua fica onde os olhos já estão (tabuleiro), a
  navegação ← → passa a ter um alvo visual, e libera a coluna direita inteira para a aula.
- **Caderno** = só o feed. Sem título "AULA" em caixa alta: a coluna tem um cabeçalho fino
  com abas "Aula · Lances" (segunda aba oculta se a régua bastar — decisão do usuário, §9).
- **Mensagem** fixa ao pé do feed (mesma conversa). O seletor de destino vira chips
  ("todos", "Claude", "Claude Code") só quando há duas IAs.
- **Ações da partida** no rodapé da coluna, "Nova partida" primário, "Desistir" à direita
  em estilo neutro (vermelho só na confirmação).

### 3.3 Tablet (768–1099 px)
Mesma grade com coluna lateral de 320 px e tabuleiro `min(100% , 100vh - 260px)`. Régua
de lances mostra só os últimos 6 lances com botão "…". Ferramentas do tabuleiro viram um
menu "⋯" (FEN, PGN, limpar desenho) com "virar" e "voltar lance" visíveis.

### 3.4 Celular (< 768 px)

```
┌──────────────────────────────┐
│ ♞ LLM Xadrez        ●  ☾  ♪  │  header 44 px
├──────────────────────────────┤
│ ● Claude · pensando   ♟♟♞ +1 │  placa (36 px)
│ ┌────────────────────────┐   │
│ │                        │   │  tabuleiro = 100vw − 2×16, coords fora
│ │                        │   │
│ │                        │   │
│ └────────────────────────┘   │
│ ○ Felipe · sua vez     ♟♟    │  placa
│ ⟲ 9.d5 ♗f6 10.♖e1 ♘e7 11.… ▸ │  régua
├──────────────────────────────┤
│ ┃ Claude · atenção   agora   │  ÚLTIMO COMENTÁRIO (balão fixo,
│ ┃ Meu bispo de f6 e o cavalo │  2 linhas + "ver tudo")
│ ┃ de e7 vigiam d5…  ver tudo │
├──────────────────────────────┤
│  Aula (31)   Lances   Ações  │  abas (sticky)
│  …feed rolável…              │
├──────────────────────────────┤
│ [Pergunte à professora…] ➤   │  input fixo no rodapé (safe-area)
└──────────────────────────────┘
```

- O balão do último comentário resolve o problema central do celular: **ler o comentário
  sem perder o tabuleiro**. Toque expande em folha inferior (bottom sheet) com o feed.
- Abas "Aula / Lances / Ações" abaixo do balão; "Ações" guarda virar, voltar lance, FEN,
  PGN, limpar, empate, desistir, nova partida.
- Header perde a versão e mantém o ponto de conexão (com `aria-label`).
- Alvos ≥ 44 px no celular, ≥ 28 px no desktop.

### 3.5 Modo espectador (IA vs IA)
- As duas placas viram "balões de professor": cada placa mostra, além do estado, o **último
  comentário daquela IA** (2 linhas, expansível) com a cor da tinta da IA — brancas usam
  `--ink`, pretas usam uma segunda tinta `--ink-2` (roxo-ardósia `#6b5ea8` / `#b9adf0`),
  a única exceção à regra das quatro cores, justificada porque duas vozes precisam ser
  distinguíveis no feed sem ler o nome.
- No feed, itens da IA das brancas alinham à esquerda com traço `--ink`; da IA das pretas,
  traço `--ink-2`; mensagens do humano ficam centrais, em grafite, com o chip do destino.
- Campo de mensagem com chips de destino sempre visíveis ("todos · Claude Desktop · Claude Code").
- Ferramentas do tabuleiro: "voltar lance", "desistir" e "empate" ocultas (não há assento
  humano; hoje já estão `disabled`, mas ocupam espaço).

### 3.6 Modo revisão (histórico)
- Entrar: clique num lance da régua/feed, ← →, ou botão "revisar" no `GameBanner` de fim.
- Sinal: moldura do tabuleiro em "papel", rótulo "revisando 11…d6" na moldura, botão
  "voltar ao vivo" na régua (não banner separado), peças sem arrastar.
- O feed rola até o comentário daquele ply e o destaca com o traço da categoria; o
  `highlight` anexado ao comentário (`Commentary.highlight`) é desenhado no tabuleiro
  durante a revisão daquele ply (hoje só o `state.highlight` do ply atual aparece).
- Se chegar lance novo enquanto revisa: chip "+1 lance ao vivo" na régua; nada muda no
  tabuleiro sem ação do usuário.

### 3.7 "Aguardando IA conectar" como onboarding guiado
Substitui o `seat-empty` + `ConnectHelp` por um **painel de passos no lugar do Caderno**
(a coluna direita está vazia mesmo nesse momento) e uma placa "assento livre" na mesa.

```
┌──────────────────────────────────────┐
│ Conecte a professora                 │
│                                      │
│ ✓ 1. Servidor no ar                  │  (WS conectado → verde automaticamente)
│                                      │
│ ● 2. Registre no seu cliente         │
│    [Claude Code] [Claude Desktop] [Outro]   ← segmented, lembra a escolha
│    claude mcp add --transport http … │  [copiar]
│    Cole no terminal e abra o claude. │
│                                      │
│ ○ 3. Peça a aula no chat             │
│    "vamos jogar xadrez, eu de        │  [copiar]
│     brancas, me ensine"              │
│                                      │
│ ○ 4. A IA entra na partida           │
│    (detectamos automaticamente)      │
│                                      │
│ Prefere assistir IA vs IA ou jogar   │
│ contra outra pessoa? Nova partida →  │
└──────────────────────────────────────┘
```

- Passo 2 vira ✓ quando `server.mcpSessions` ganha uma sessão (mesmo sem assento) — a UI
  já recebe isso via `WsServerMessage.server`. Texto: "Claude Code conectou. Agora é no chat."
- Passo 3/4 viram ✓ quando `seats[cor].kind === "mcp"`; o painel se fecha com uma transição
  para o feed e um toast "Claude entrou nas pretas".
- Se a sessão conecta e fica 60 s sem sentar: "A IA está conectada mas ainda não entrou.
  No chat, diga: …" com o texto do passo 3.
- Se o WS cair: passo 1 volta a ○ com "Servidor parado? Rode `npm start`".
- "Nova partida" continua no rodapé para os outros modos; o `NewGameDialog` ganha uma
  nota: "Se a IA criar a partida pelo chat, ela substitui esta."
- O modal `ConnectHelp` continua existindo como "Ver todas as opções" (link no passo 2).

---

## 4. Microinterações e feedback

| Momento | Comportamento proposto | Reduzir movimento |
|---------|------------------------|-------------------|
| Lance (qualquer lado) | animação da peça 180 ms (lib), lavagem de último lance aparece com fade 120 ms; a placa de quem jogou pisca uma vez o traço lateral | sem fade; peça "teleporta" (`animationDurationInMs: 0`) |
| IA pensando | placa: três pontos pulsando + "pensando há 12 s" (contador; se > 90 s, "demorando — a IA pode ter perdido a conexão, veja o chat"); moldura do tabuleiro ganha um traço `--ink` fino que "respira" a 2 s | pontos estáticos "…", sem respiração |
| Comentário chega | novo cartão entra com fade 150 ms; se o usuário rolou para cima, chip "1 comentário novo ↓" no pé do feed (já existe "ir para o fim", vira contador); som "tique" suave; título da aba "💬 Claude — LLM Xadrez" enquanto a aba não tem foco | sem fade |
| Setas/casas da IA | aparecem junto com o comentário (fade 150 ms), somem no próximo lance com fade 300 ms (hoje somem abruptamente ao mudar o ply); em revisão, reaparecem para o ply do comentário | sem fade |
| Sua vez | placa muda para "sua vez", som "toc" curto, título "♟ Sua vez — LLM Xadrez" (já existe); favicon com ponto (SVG dinâmico) | igual |
| Lance ilegal / recusado | a peça volta animada (200 ms) em vez de remontar o tabuleiro; toast com verbo: "Não é sua vez — a IA ainda está pensando" / "Partida encerrada — comece uma nova"; lances legais não vão para o toast (o tabuleiro já mostra os destinos) | peça volta sem animação |
| Xeque | radial + contorno no rei, placa do lado em xeque com "xeque!", som de dois tons (existe) | igual |
| Fim de partida | `GameBanner` sobre o tabuleiro (não cobre as peças: aparece na moldura superior, 56 px): "Xeque-mate — Claude venceu · 0-1" + [Revisar] [Nova partida] [PGN]; som de fim (existe) | igual |
| Desistir | confirmação inline (existe) vira um `popover` ancorado ao botão com "Desistir a partida? Claude vence." [Desistir] [Cancelar]; foco vai para "Cancelar" | igual |
| Empate | botão "Oferecer empate" → "Empate oferecido — aguardando a IA" (estado no botão, não toast) | igual |
| Voltar lance | peças voltam animadas; comentários do ply desfeito ficam no feed com opacidade 60 % e tag "desfeito" (não somem: são aula) | sem animação |
| Copiar FEN/PGN | o próprio botão vira "✓ copiado" por 1,5 s (padrão do `CopyButton`), sem toast | igual |
| Conexão caiu | barra fina no topo "Reconectando…", tabuleiro perde interação com `cursor: wait`, sem overlay | igual |
| Sons | manter síntese Web Audio (sem arquivos); adicionar "tique" de comentário e "entrou" de assento; volume 0.15–0.3; toggle no header (existe) | — |

`@media (prefers-reduced-motion: reduce)` desliga: `pulse`, `spin` (vira barra
indeterminada estática), `scroll-behavior: smooth`, fades, e passa `animationDurationInMs: 0`
para o react-chessboard via `matchMedia`.

---

## 5. Componentes

### 5.1 Inventário
| Componente | Ação | Props principais |
|------------|------|------------------|
| `BoardFrame` | **novo** | `orientation`, `coords: boolean`, `mode: "live" \| "review" \| "thinking"`, `reviewLabel?`, `children` (o `Board`) |
| `Board` | muda | remove `showNotation`; recebe `theme: "paper" \| "wood" \| "slate"`, `reducedMotion`; devolve o `interactive` com "peça volta" em vez de `resetKey`; expõe `onKeyboardMove` (§6) |
| `SeatPlate` | **novo** (substitui `Seats`/`SeatCard`) | `color`, `seat`, `session?`, `isTurn`, `captured: PieceType[]`, `materialDelta`, `latestComment?: Commentary` (espectador), `thinkingSince?` |
| `MoveRibbon` | **novo** | `history`, `activePly`, `onSelect(ply \| null)`, `liveCount?` (lances novos durante revisão) |
| `MoveList` | mantém como aba | idem hoje, sem monoespaçada, com `<San>` |
| `San` | **novo** | `san: string`, `figurine?: boolean` → renderiza `♘f3` com SVG inline da peça e letras para fallback/leitor de tela (`aria-label="cavalo f3"`) |
| `Notebook` | **novo** (substitui `LessonFeed`) | `state`, `activePly`, `onSelectPly`, `tab: "lesson" \| "moves"`, `unread` |
| `Annotation` | **novo** (item do feed) | `kind: "move" \| "comment" \| "message"`, `author`, `category`, `ink: "ink" \| "ink-2" \| "student"`, `highlight?`, `undone?` |
| `MessageBox` | muda | `targets: {value, label}[]` como chips; `placeholder` contextual ("Pergunte à professora…" / "Nenhuma IA conectada — conecte uma para conversar") |
| `BoardTools` | **novo** (era `Controls group="board"`) | `onFlip`, `onTakeback`, `onClearHighlight`, `fen`, `pgnUrl`, `canTakeback`, `hasHighlight` |
| `GameActions` | **novo** (era `Controls group="game"`) | `onNewGame`, `onResign`, `onDraw`, `drawOffer`, `humanColors`, `busy` |
| `GameBanner` | **novo** (substitui `StatusBar` no fim de partida) | `state` → texto de `statusText()` + `onReview`, `onNewGame` |
| `ConnectWizard` | **novo** (substitui `seat-empty` + ordem do `ConnectHelp`) | `mcpUrl`, `wsConnected`, `sessions: ServerInfo["mcpSessions"]`, `seats`, `client: "code" \| "desktop" \| "other"` |
| `ConnectHelp` | mantém como "todas as opções" | idem |
| `Modal` | muda → `<dialog>` nativo | `open`, `onClose`, `title`, `returnFocusTo?` |
| `Toast`/`Toaster` | **novo** | `kind: "error" \| "info"`, `action?`, `timeout` (0 = fica até fechar), `role="status"`/`"alert"` |
| `ThemeToggle` | **novo** | `value: "system" \| "light" \| "dark"` |
| `StatusBar` | **sai** | texto migra para `SeatPlate` (vez/xeque) e `GameBanner` (fim/espera) |
| `Seats` | **sai** | — |
| `preview-banner` | **sai** | vira `BoardFrame mode="review"` + botão na régua |

### 5.2 Biblioteca de primitivos: recomendação
Opções avaliadas:
- **Radix Primitives** (Dialog, Popover, Tabs, Toast, Select, Tooltip): acessibilidade
  pronta, headless. Custo: ~35–60 KB gz somados, mais uma dependência por primitivo, e o
  Select/Tooltip do Radix têm comportamento touch que precisa ajuste.
- **shadcn/ui**: exige Tailwind + copiar componentes; o projeto é CSS puro e um dev; muda a
  forma de estilizar tudo. Não vale.
- **CSS puro + APIs nativas** (recomendado): `<dialog showModal()>` (focus trap, Esc,
  `inert` no fundo, devolução de foco — de graça), atributo `popover` para a confirmação
  de desistir e o menu "⋯", `<details>`/segmented com `role="tablist"` feito à mão (30
  linhas), toast próprio com `role`. Select nativo já basta (dois valores).

Justificativa: bundle atual do web é pequeno (react + react-chessboard + chess.js); a
única coisa que faltava para acessibilidade dos modais era o `<dialog>`, que resolve
mais do que o Radix Dialog em zero bytes. Reavaliar Radix só se surgir Tooltip rico ou
Combobox (fase 2 do roadmap, histórico de partidas).

---

## 6. Acessibilidade (WCAG 2.2 AA) — checklist por área

**Global**
- [ ] Todos os textos ≥ 4.5:1; ícones/bordas de estado ≥ 3:1 (1.4.3, 1.4.11). Tabela em §8.1.
- [ ] Nenhum texto < 12 px; zoom 200 % sem perda (1.4.4); reflow a 320 px (1.4.10).
- [ ] `prefers-reduced-motion` respeitado em todas as animações (2.3.3).
- [ ] `prefers-color-scheme` + toggle manual persistido; `color-scheme` acompanha (sem critério, mas esperado).
- [ ] Foco visível 2 px com `outline-offset` e cor que contraste com o fundo *e* com bordas de estado (2.4.7, 2.4.11 — foco não obscurecido por header sticky: `scroll-margin-top`).
- [ ] Alvos ≥ 24×24 CSS px no desktop, 44 no celular (2.5.8).
- [ ] Estrutura: `h1` marca, `h2` "Mesa" (visualmente oculto) e "Caderno", `h3` por placa; landmarks `main`, `aside[aria-label="Caderno"]`, `nav[aria-label="Lances"]` na régua (1.3.1, 2.4.1).
- [ ] Sem informação só por cor: categoria de comentário tem ícone SVG + texto; setas/casas têm cor + contorno; vez tem texto "sua vez" (1.4.1).

**Tabuleiro (2.1.1, 4.1.2)**
- [ ] `role="grid"` no wrapper, `aria-label="Tabuleiro, vez das brancas"`, 64 células
  `role="gridcell"` com `aria-label="e4, peão branco"` / `"e5, vazia"` geradas por cima do
  react-chessboard (camada transparente `position: absolute` com as 64 células, `pointer-events: none`,
  ou usar o `squareRenderer`/`customSquare` da v5 — validar API instalada).
- [ ] Navegação por teclado: Tab entra no tabuleiro (uma parada: `tabindex=0` na célula
  ativa, roving tabindex), setas movem a célula ativa, `Enter`/`Espaço` seleciona a peça e
  depois o destino, `Esc` cancela, `Home`/`End` primeira/última coluna; teclas de letra+número
  ("e", "4") pulam para a casa. Promoção: o diálogo já existe, vira `<dialog>` com foco na Dama.
- [ ] Conflito com ← → do histórico: dentro do `grid` as setas movem a célula; fora, navegam
  lances (já é assim para inputs).
- [ ] Anúncios: `aria-live="polite"` numa região **fixa e vazia** (`#sr-moves`) que recebe
  "Claude jogou cavalo f3, xeque" / "Você jogou e4" / "Sua vez"; região separada
  `aria-live="polite"` para comentários (`#sr-comments`: "Claude, atenção: …" com o texto
  inteiro) — nunca mover o atributo entre nós (4.1.3).
- [ ] Seta/casa da IA descrita: o cartão de comentário com desenho ganha texto oculto
  "desenho: seta verde de c6 para d4, casa d5 destacada em vermelho".

**Caderno / feed**
- [ ] Cada item é `article` com `aria-labelledby` (autor + categoria); lances clicáveis são
  `button` com nome "Ver posição após 11…d6".
- [ ] Botão "1 comentário novo" com `aria-live` próprio.
- [ ] Mensagem do humano: estado "aguardando entrega/entregue" como texto, não só cor.

**Formulários e diálogos**
- [ ] `<dialog>` com `aria-labelledby`, foco inicial no primeiro campo, retorno de foco ao
  gatilho (2.4.3); rádios do `NewGameDialog` com `aria-describedby` para o hint; erros com
  `role="alert"` (existe) e `aria-invalid`.
- [ ] Confirmação de desistir como `popover` com foco em "Cancelar"; botão primário não é o
  destrutivo (3.3.4 — reversão de ação legal: desistir não tem volta, pedir confirmação).
- [ ] `MessageBox`: `label` visível ("Para: todos") em vez de `aria-label` só; `Enter` envia,
  `Shift+Enter` quebra linha (vira `textarea` auto-altura).

**Toasts**
- [ ] `role="status"` (info) / `role="alert"` (erro); botão fechar; erro fica até fechar ou
  ≥ 10 s; pausa no hover/foco (2.2.1).

**Régua de lances**
- [ ] `nav` + lista `ol` com `li > button`, `aria-current="true"` no ativo (existe na tabela);
  instrução oculta "use ← → para navegar".

---

## 7. Plano de implementação em fases

Tamanhos: P = até meio dia, M = 1–2 dias, G = 3+ dias. Ordem pensada para **nunca quebrar
o que funciona**: primeiro tokens (só CSS), depois estrutura, depois comportamento.

### Fase 0 — Fundação visual (P) · só `styles.css` + `index.html`
- Tokens novos (§8.1) em `:root` + `[data-theme="dark"]` + `@media (prefers-color-scheme)`;
  mapear os nomes antigos (`--bg-elev`, `--accent`…) para os novos para nada quebrar.
- Base 16 px; escala `--fs-*`; remover `text-transform: uppercase` + tracking dos rótulos;
  lances sem monoespaçada; Literata auto-hospedada aplicada em `.feed-comment .md` e
  `.feed-human .md`.
- Corrigir contrastes (`--text-faint`, `btn-primary`, tags) e tamanhos mínimos.
- `prefers-reduced-motion`; `meta color-scheme: light dark`.
- Aceite: Lighthouse a11y ≥ 90 (de partida), nenhuma mudança de layout, `npm run build` ok,
  screenshots `docs/img/redesign/f0-*.png` lado a lado com `atual-*.png`.

### Fase 1 — Mesa: placas, moldura, régua (M)
- `SeatPlate` (substitui `Seats`), `BoardFrame` com coordenadas fora, `MoveRibbon`,
  `BoardTools`/`GameActions` (separar `Controls`), `GameBanner` (fim de partida) e retirada
  do `StatusBar`.
- Presets de tabuleiro + toggle de tema no header.
- Aceite: partida completa em `?mock=1` e contra o `npm run smoke` sem regressão; ← → e
  cliques navegam pela régua; celular sem rolagem horizontal; alvo mínimo cumprido.

### Fase 2 — Caderno e onboarding (M)
- `Notebook` + `Annotation` (feed reestilizado, chip de novos, mensagem colada ao pé,
  chips de destino); layout mobile com balão do último comentário + abas + input fixo.
- `ConnectWizard` com detecção automática (sessão sem assento → passo 2 ✓; assento → fecha).
- `Modal` → `<dialog>`; `Toaster` acessível; confirmação de desistir como `popover`.
- Aceite: fluxo "zero → IA conectada" testado com Claude Code real, com tempos anotados;
  Lighthouse a11y ≥ 95; axe sem "critical/serious".

### Fase 3 — Tabuleiro acessível e modo revisão (G)
- Camada `grid` do tabuleiro com teclado e `aria-label` por casa; regiões `aria-live`
  fixas; `<San>` com figurinhas SVG; halo nas setas; destaque de comentário em revisão;
  chip "+1 lance ao vivo".
- Aceite: partida inteira jogada só com teclado (roteiro em `docs/`), NVDA/VoiceOver
  anunciam lance, vez e comentário; screenshots de revisão e espectador.

### Fase 4 — Espectador e polimento (P/M)
- Balões duplos nas placas (IA vs IA), `--ink-2`, sons novos, favicon dinâmico, título da
  aba com comentário, contador "pensando há N s".
- Aceite: sessão IA vs IA (`scripts/mcp-play.ts` ou dois clientes) com screenshots.

### Como validar em cada fase
1. `docs/img/redesign/<fase>-{desktop,tablet,mobile}.png` gerados com o mesmo script
   Playwright usado para `atual-*.png` (1440×900, 1024×768, 390×844, `?mock=1`).
2. Lighthouse (aba Acessibilidade) no `?mock=1` e numa partida real; meta ≥ 95 a partir da F2.
3. Tabela de contraste recalculada com o mesmo `eval` (getComputedStyle) usado neste diagnóstico.
4. Roteiro manual: (a) zero → IA conectada, (b) jogar 5 lances, (c) revisar e voltar,
   (d) lance recusado, (e) desistir e cancelar, (f) IA vs IA, (g) só teclado, (h) celular
   em modo retrato com teclado virtual aberto (input não pode cobrir o balão).
5. Extender o `fixtures.ts` com cenários por query (`?mock=waiting`, `?mock=llmvsllm`,
   `?mock=finished`, `?mock=empty`) para screenshots dos estados sem servidor.

---

## 8. Anexos

### 8.1 Tokens de design propostos

```css
:root {
  /* espaçamento e forma */
  --sp-1: 4px;  --sp-2: 8px;  --sp-3: 12px; --sp-4: 16px;
  --sp-5: 24px; --sp-6: 32px; --sp-7: 48px;
  --r-sm: 6px;  --r-md: 10px;
  --shadow-board: 0 12px 32px rgb(0 0 0 / .35);
  --shadow-float: 0 8px 24px rgb(0 0 0 / .28);

  /* tipografia */
  --font-ui: system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-read: "Literata Variable", Charter, "Iowan Old Style", Georgia, serif;
  --font-code: ui-monospace, "Cascadia Code", Consolas, Menlo, monospace;
  --fs-xs: .75rem; --fs-sm: .875rem; --fs-md: 1rem; --fs-lg: 1.0625rem;
  --fs-xl: 1.25rem; --fs-2xl: 1.625rem;
  --lh-ui: 1.4; --lh-read: 1.55;

  /* tabuleiro (preset "papel e oliva") */
  --sq-light: #ece6d6; --sq-dark: #7f8f66;
  --sq-last: color-mix(in oklab, var(--attn) 38%, transparent);
  --sq-select: var(--ink);
  --sq-check: var(--threat);
  --sq-dot: color-mix(in oklab, var(--text) 30%, transparent);
  --arrow-good: var(--good); --arrow-attn: var(--attn);
  --arrow-threat: var(--threat); --arrow-ink: var(--ink);
}

/* tema claro (padrão quando o sistema pede claro) */
:root, :root[data-theme="light"] {
  color-scheme: light;
  --bg: #f6f7f9;         /* fundo da página (branco frio, não creme) */
  --surface: #ffffff;    /* caderno, modais */
  --surface-2: #eef0f3;  /* lance ativo, chips */
  --paper: #f3efe4;      /* moldura em revisão, cartão de comentário */
  --border: #d9dde3;
  --border-strong: #b9c0ca;
  --text: #1b1f26;       /* 15.6:1 sobre --surface */
  --text-muted: #4e5866; /* 7.2:1 */
  --text-faint: #6b7583; /* 4.9:1 — mínimo para texto */
  --ink: #2f5fa8;        /* 5.6:1 sobre branco */
  --ink-2: #6b5ea8;      /* 5.9:1 */
  --good: #24784a;       /* 5.4:1 */
  --attn: #8a5a12;       /* 5.9:1 (texto); âmbar de setas: #c9931f */
  --threat: #b8322a;     /* 6.0:1 */
  --student: #5b6470;
  --on-ink: #ffffff;
  --focus: #2f5fa8;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { /* mesmos valores do bloco abaixo */ }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #12161c;
  --surface: #181d25;
  --surface-2: #222933;
  --paper: #2a2823;      /* "papel" apagado para revisão/cartão */
  --border: #2a323d;
  --border-strong: #3c4652;
  --text: #e8edf2;       /* 14.9:1 sobre --surface */
  --text-muted: #aab4c0; /* 8.4:1 */
  --text-faint: #8a95a3; /* 5.4:1 */
  --ink: #8fb4ff;        /* 8.0:1 */
  --ink-2: #b9adf0;      /* 8.6:1 */
  --good: #5fcf8a;       /* 9.3:1 */
  --attn: #f2c14e;       /* 10.6:1 */
  --threat: #ff7b72;     /* 6.6:1 */
  --student: #a8b0bb;
  --on-ink: #0d1420;
  --focus: #8fb4ff;
  --shadow-board: 0 14px 36px rgb(0 0 0 / .55);
}
```

Regras de uso: texto usa `--text*`; estado usa `--ink/--good/--attn/--threat`; fundo de
cartão de comentário = `--surface` com traço lateral 3 px da categoria; nunca `rgba(255,255,255,.07)`
solto (usar `--surface-2`). Botão primário = `--ink` com `--on-ink` (verificar ≥ 4.5:1 nos
dois temas — os valores acima passam).

Mapa antigo → novo (para a F0 não quebrar nada): `--bg`→`--bg`, `--bg-elev`→`--surface`,
`--bg-elev-2`→`--surface-2`, `--accent`→`--ink`, `--accent-strong`→`--ink`, `--ok`→`--good`,
`--warn`→`--attn`, `--danger`→`--threat`, `--busy`→`--attn`, `--font`→`--font-ui`,
`--mono`→`--font-code`, `--radius`→`--r-md`, `--radius-sm`→`--r-sm`.

### 8.2 Direções alternativas ("moods")

**A. Clube de xadrez clássico** — madeira, couro, verde-feltro, serifa de transição
(Playfair/Cormorant), ornamentos, peças Staunton. *Prós*: forte identidade, emocional,
"lugar de aprender". *Contras*: envelhece rápido, texturas custam bytes e legibilidade em
celular, verde-feltro conflita com setas verdes, corre para o kitsch; o comentário da IA
em tipografia "antiga" soa pomposo para uma professora que fala em português coloquial.

**B. Estúdio moderno minimalista** — o que existe hoje, mais disciplinado: cinza-azulado,
sans única, monoespaçada para lances, cards. *Prós*: pouco esforço, neutro, cabe qualquer
conteúdo. *Contras*: é o "template escuro" que o brief pede para evitar; nada nele vem do
xadrez ou da aula; a monoespaçada trata lances como logs; não diferencia a voz da
professora da UI.

**C. Partida comentada / caderno de estudos** (recomendada) — convenções do xadrez impresso
(figurinhas, lances em negrito, comentário em serifa de leitura), cores de caneta como
sistema semântico, tabuleiro "papel e oliva", superfícies planas. *Prós*: identidade que
nasce do assunto e do uso (ler e estudar), escala bem para claro/escuro, o feed vira um
texto legível, e o modo espectador (duas tintas) e a revisão (moldura de papel) têm
metáforas naturais. *Contras*: exige auto-hospedar uma fonte (~120 KB) e construir o
`<San>` com figurinhas; serifa em telas de baixa densidade precisa de tamanho ≥ 16 px
(por isso 17 px).

### 8.3 Referências de convenção usadas
- Placa do adversário em cima / do jogador embaixo; régua horizontal de lances no celular;
  coordenadas fora do tabuleiro; figurinhas na notação: convenções compartilhadas por
  lichess, chess.com e pela literatura impressa — o aluno as reconhece sem aprender.
- Cores das setas: verde = bom, vermelho = ameaça, azul = ideia/alternativa, amarelo =
  atenção — mesmo mapa das ferramentas de análise mais usadas, que a IA já tende a seguir
  (`highlight` aceita `green/red/blue/yellow`).

---

## 9. Decisões que precisam da sua validação antes de implementar

1. **Direção "partida comentada"** (serifa Literata auto-hospedada para a voz da professora
   + sans do sistema para a UI) em vez de manter tudo em fonte do sistema.
2. **Régua horizontal de lances sob o tabuleiro** substituindo a tabela `MoveList` no
   desktop (tabela vira aba opcional no Caderno) — ou manter tabela + régua?
3. **Placas acima/abaixo do tabuleiro** (adversário em cima) no lugar dos dois cards lado a
   lado, com o `StatusBar` eliminado (vez/xeque na placa, fim de partida no `GameBanner`).
4. **Preset de tabuleiro "papel e oliva"** como padrão (com "madeira" e "ardósia" como
   opções) e **notação com figurinhas** por padrão.
5. **CSS puro + `<dialog>`/`popover` nativos** em vez de Radix/shadcn; tema claro/escuro
   seguindo o sistema por padrão, com toggle.
