# 02 — Contrato MCP (ferramentas, prompt, recursos)

Endpoint: `POST http://localhost:3939/mcp` (Streamable HTTP, sessões com estado).
Com `MCP_TOKEN` definido, o token vai como `Authorization: Bearer <token>` **ou** como
`?token=<token>` na URL (para clientes que não mandam header, como Claude.ai e ChatGPT).
Sessões sem requisição há 30 min são fechadas (docs/03 → MCP).
Servidor MCP: `name: "llm-xadrez"`, `version` do package.json.
Tipos referenciados: `shared/types.ts` (`GameState`, `TurnEvent`, ...).

## Convenções gerais

- Nomes de tools e parâmetros em **inglês** (padrão de tool calling). Textos devolvidos
  (estado formatado, mensagens de erro didáticas) em **português**, configurável por
  `LANG=pt-BR|en` no `.env` (v1 só precisa de pt-BR; deixar o formatador preparado).
- **Toda resposta** de tool devolve:
  - `content[0]` = `{ type: "text", text: <estado formatado para LLM> }` (ver formato abaixo);
  - `structuredContent` = JSON (`GameState` completo ou `TurnEvent & { state: GameState }`).
  - Tools devem declarar `outputSchema` (zod) para o `structuredContent`.
- **Erros de regra** (lance ilegal, não é sua vez, assento ocupado) **não** lançam exceção:
  retornam `isError: true` com texto explicando e, se aplicável, a lista de lances legais.
  Só erros inesperados viram exceção.
- Toda tool que muda o estado faz broadcast WS e acorda `wait_for_turn` do outro assento.
- Toda chamada de tool atualiza `seats[minhaCor].lastSeenAt` se a sessão estiver sentada.
- Mensagens do humano pendentes para a cor da sessão são incluídas no texto de **qualquer**
  tool (não só `wait_for_turn`) e marcadas como entregues (`deliveredTo`) nessa resposta.
- O servidor MCP declara `instructions` (resumo do protocolo de jogo) no `initialize`.
  Elas mandam a IA **começar por `join_game`** quando há partida em andamento ou assento
  esperando uma LLM, e só chamar `new_game` quando o usuário pedir uma partida nova; e
  dizem que `timeout` em `wait_for_turn` é normal (chame de novo).
- Um assento pode ser ocupado por um **bot do servidor** (`SeatKind: "bot"`, docs/09). Do
  ponto de vista de uma sessão MCP externa, um bot é só "outra LLM": ele entra nas mesmas
  filas de evento, aparece como oponente no texto de estado ("LLM (bot do servidor)") e o
  `structuredContent` traz `seats[cor].bot` com provedor, modelo, status e uso. Nada no
  contrato abaixo muda por causa disso.

## Ferramentas

### `new_game`
Cria uma nova partida (encerra a atual, salvando o PGN em `data/games/`) e senta a sessão
chamadora na cor escolhida. **Recusa** (`isError: true`, sem mexer em nada) quando a
partida atual não terminou e (a) já tem lances, ou (b) tem assento esperando uma LLM — o
caso típico de "Aguardando MCP" na UI ou de um servidor recém-reiniciado. O texto da
recusa manda chamar `join_game`; `confirm: true` passa por cima, e só deve ser usado quando
o usuário pediu explicitamente uma partida nova.

| Parâmetro | Tipo | Default | Descrição |
|-----------|------|---------|-----------|
| `my_color` | `"white" \| "black" \| "random"` | `"black"` | cor que a LLM vai jogar |
| `opponent` | `"human" \| "llm"` | `"human"` | `human`: o outro assento é do navegador. `llm`: fica vazio aguardando `join_game` de outra sessão |
| `my_name` | string | `"Claude"` | nome exibido na UI |
| `opponent_name` | string | `"Você"` | nome do humano (ignorado se `opponent = "llm"`) |
| `start_fen` | string | posição inicial | para estudar uma posição específica (aula, final, puzzle) |
| `confirm` | boolean | `false` | obrigatório (`true`) para substituir uma partida em andamento ou com assento esperando uma LLM |

Retorna o estado. Se for a vez da LLM (`my_color = white` na posição inicial), o texto diz
"É sua vez: chame make_move". Se `opponent = "llm"`, diz "Aguardando outra LLM entrar com
join_game(color: 'black'). Chame wait_for_turn."

### `join_game`
Entra na partida atual num assento livre (ou retoma o seu), **sem mexer no tabuleiro**.
Sem `color`, escolhe o assento que está esperando uma LLM (o único livre).

| Parâmetro | Tipo | Default | Descrição |
|-----------|------|---------|-----------|
| `color` | `"white" \| "black"` | o assento livre (erro se os dois estiverem livres ou ocupados) | |
| `my_name` | string | `"Claude"` | |
| `force` | boolean | `false` | toma o assento mesmo que outra sessão MCP esteja ativa nele |

Regras de retomada: se o assento é `mcp` e a sessão dona está **fechada**, ou **ociosa há
mais de 5 min** (nenhuma requisição e nenhum `wait_for_turn` pendente), `join_game` o toma
sem `force`. Uma sessão bloqueada em `wait_for_turn` nunca conta como ociosa. **Mesmo
`my_name` não basta** para tomar o assento de uma sessão viva (duas LLMs podem se chamar
"Claude"): o nome só serve para retomar quando o dono já se foi. O erro diz há quanto tempo
o dono teve atividade e sugere `force: true` só se aquela sessão é sua e travou.
Se a sessão chamadora já está sentada e chama `join_game` sem `color` (ou com a mesma cor),
apenas o nome é atualizado; com a outra cor, ela troca de assento (o antigo fica vazio).
Se os dois assentos estão livres e `color` foi omitido, retorna erro pedindo a cor.
Se o assento é `human`, `join_game` **converte para mcp** apenas com `force: true`
(o humano vira espectador). Se o assento é de um **bot do servidor**, o mesmo: só com
`force: true`, e aí o bot é parado — um assento de bot nunca é "retomável" pelo nome,
porque quem controla o ciclo de vida dele é o `BotManager` (o painel tem "Parar" e
"Liberar assento"). Gera evento `opponent_joined` para o outro assento.

### `get_state`
Sem parâmetros. Retorna o estado atual formatado + JSON. Use quando quiser "olhar o
tabuleiro" sem esperar nada. Também entrega mensagens humanas pendentes.

### `make_move`
Joga um lance pela cor da sessão chamadora.

| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| `move` | string | SAN (`"Nf3"`, `"exd5"`, `"O-O"`, `"e8=Q"`) ou UCI (`"g1f3"`, `"e7e8q"`). Aceita variações comuns: `"0-0"`, `"Nf3+"` sem xeque real, `"nf3"` minúsculo (normalizar) |
| `comment` | string? | comentário do professor exibido junto com o lance ("Ataco o cavalo e preparo o roque"). Vai para `MoveRecord.comment` e para o PGN (`{...}`) |
| `comment_category` | `CommentCategory`? | aceito, mas **não é armazenado** na v1: `MoveRecord` não tem categoria e a UI mostra o comentário do lance sempre com o ícone de "plano". Para comentar com outra categoria, use a tool `comment` |

Validação: sessão deve estar sentada; deve ser sua vez; partida ativa; lance legal.
Erro de lance ilegal retorna `isError: true` com:
```
Lance ilegal: "Nf5". Motivos possíveis: nenhum cavalo alcança f5.
Lances legais agora (24): Nf3, Nc3, e4, e3, d4, d3, ... (capturas marcadas com x, xeques com +)
```
Sucesso retorna o estado com o lance aplicado e o texto:
"Você jogou 12...Nf6. Agora é a vez das BRANCAS (Felipe). Chame wait_for_turn."
Se o lance termina a partida: "Xeque-mate! Você venceu (0-1). Partida encerrada."

### `wait_for_turn`
Bloqueia até acontecer algo relevante para a sessão chamadora ou até o timeout.

| Parâmetro | Tipo | Default | Descrição |
|-----------|------|---------|-----------|
| `timeout_seconds` | number | `25` | máximo `120`. O default fica abaixo dos ~30–60 s de timeout de tool de muitos clientes MCP |

Retorna `TurnEvent & { state }`:
- `your_turn` — é sua vez e o oponente está sentado (retorna imediatamente se já for).
- `opponent_moved` — inclui `opponentMove` (SAN, de/para, captura, xeque).
- `message` — humano enviou mensagem para você ou para todos (`messages[]`). Pode não ser
  sua vez: responda no chat e chame `wait_for_turn` de novo.
- `takeback` — lances desfeitos; olhe o estado e continue.
- `opponent_joined`, `new_game` — situação mudou; releia o estado.
- `game_over` — resultado e motivo.
- `timeout` — nada aconteceu (é normal). Texto: "Nada aconteceu em 25 s. Chame
  wait_for_turn de novo (ou converse com o aluno)".
- `not_seated` — o texto manda chamar `join_game` se há partida em andamento ou assento
  esperando, e `new_game` só se o usuário pediu uma partida nova.

Eventos são enfileirados **por assento**; `wait_for_turn` drena a fila e, se houver mais
de um evento, retorna o mais importante (`game_over` > `opponent_moved` > `your_turn` >
`takeback` > `new_game` > `opponent_joined` > `message`) com todos os `messages` juntos.
Nunca perde eventos que aconteceram enquanto a LLM não estava esperando. Eventos obsoletos
são descartados no drenagem (ex.: `opponent_moved` quando já não é sua vez, `message` já
entregue). Se `timeout_seconds` for omitido/fora da faixa, é limitado a 1–120.

Enquanto bloqueada, a tool envia `notifications/progress` a cada 10 s **se** o cliente
mandou `_meta.progressToken` (mantém vivo o stream SSE em clientes que exigem atividade).
Se a sessão perder o assento durante a espera (`new_game` do humano sem mantê-la, `force`
de outra LLM, `leave_game`), a resposta é `not_seated`. Se o humano cria uma partida pelo
navegador e a sessão continua sentada, chega `new_game` (a cor pode mudar: releia o estado).
`ServerInfo.mcpSessions[].waiting = true` enquanto a sessão está bloqueada aqui (a UI mostra
"aguardando" no assento).

### `comment`
Envia um comentário de professor sem jogar.

| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| `text` | string | o comentário (markdown simples permitido) |
| `category` | `CommentCategory`? | default `"lesson"` |
| `highlight` | `{ squares?: string[] \| {square,color}[], arrows?: {from,to,color?}[] }`? | desenho anexado |

Retorna o estado (curto). Não muda a vez. Se `highlight` vier preenchido, ele fica anexado ao
comentário (`Commentary.highlight`) **e** substitui o destaque atual do tabuleiro
(`state.highlight`, com `ply` = ply atual).

### `highlight`
Desenha no tabuleiro (substitui o destaque anterior).

| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| `squares` | `(string \| {square, color})[]`? | casas a destacar |
| `arrows` | `{from, to, color?}[]`? | setas |
| `clear` | boolean? | apaga tudo (ignora os outros campos) |

Cores aceitas: qualquer CSS color; sugerir `"green"`, `"red"`, `"blue"`, `"yellow"`
(a UI mapeia esses nomes para tons próprios; outras strings CSS passam direto).
**Ciclo de vida do destaque:** o servidor grava `state.highlight` com `ply` = ply atual e
**não** o apaga quando um lance é jogado; é a UI que só desenha o destaque enquanto
`highlight.ply === state.ply`. O servidor apaga o destaque em `takeback`, em `new_game`,
em `highlight(clear: true)` e em `POST /api/highlight/clear` (botão "Limpar desenho").
Chamar `highlight` sem casas nem setas também apaga; `comment` sem `highlight` não mexe no
destaque atual.

### `takeback`
Desfaz lances (para corrigir um erro do aluno ou refazer uma posição de aula).

| Parâmetro | Tipo | Default |
|-----------|------|---------|
| `plies` | number (1–10) | `2` |

Retorna estado. Gera evento `takeback` para o oponente e apaga o destaque. Se `plies` for
maior que o histórico, desfaz tudo. Funciona também depois de um fim decidido pelo tabuleiro
(mate, afogamento, ...): a partida volta a ficar em andamento. Não funciona depois de
desistência/empate acordado/aborto.

### `end_game`
| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| `how` | `"resign" \| "draw" \| "abort"` | `resign`: a cor da sessão perde. `draw`: empate acordado. `abort`: sem resultado |

`draw` também serve para **aceitar** uma oferta de empate do humano (`state.drawOffer`), que
chega como mensagem: `Ofereço empate. Para aceitar, chame end_game(how: "draw")...`.
Gera `game_over` para o oponente.

### `leave_game`
Sem parâmetros. Libera o assento da sessão (vira `empty`, mas o **nome é mantido** para a
UI continuar mostrando "X venceu" e o PGN manter os headers). Útil antes de outra LLM
entrar. Se a partida estava em andamento, ela fica em `status: "waiting"` até alguém sentar.

## Prompt: `chess_teacher`
Argumentos: `student_level` (`"beginner" | "intermediate" | "advanced"`, default beginner),
`language` (default `"pt-BR"`). Retorna uma mensagem de usuário que instrui a LLM a:
1. Chamar `new_game`/`join_game`, depois alternar `make_move` ↔ `wait_for_turn`.
2. **Ditar cada lance** em texto no chat ("Jogo 5. Bb5, cravando o cavalo") — o aluno lê no
   chat e vê no tabuleiro.
3. Comentar como professor: explicar a ideia dos seus lances, reagir aos lances do aluno
   (elogiar bons, explicar suavemente os ruins sem dar spoiler da refutação toda), sugerir
   planos, usar `highlight` para mostrar ameaças, fazer perguntas socráticas no `comment`.
4. Nunca confiar na memória: **sempre** ler `legalMoves`/`pieces` da última resposta antes
   de escolher o lance. Se `make_move` falhar, escolher entre os lances legais devolvidos.
5. Jogar no nível do aluno (não esmagar iniciante; jogar sólido e instrutivo).
6. Responder mensagens do humano (`messages[]`) com `comment` e no chat.

## Recursos
- `xadrez://game/state` — texto formatado do estado (o mesmo de `get_state`). `mimeType: text/plain`.
- `xadrez://game/pgn` — PGN da partida atual. `mimeType: application/x-chess-pgn`.
- `xadrez://game/state.json` — `GameState` em JSON.

## Formato do texto de estado (para LLM)

Gerado por `formatStateForLLM(state, perspective)` em `server/src/game/format.ts`.
`perspective` = cor da sessão chamadora (ou `null` para espectador). Exemplo:

```
# Partida 3f2a — lance 12, vez das BRANCAS (Felipe, humano)
Você joga de PRETAS como "Claude". Status: em andamento. Sem xeque.
Último lance: 11...Nf6 (você). Material: igual (0).
➡ Próximo passo: não é sua vez. Chame wait_for_turn.

FEN: r1bq1rk1/ppp2ppp/2np1n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 4 12

Brancas (Felipe): K g1 · Q d1 · R a1 f1 · B c1 c4 · N c3 f3 · P a2 b2 c2 d3 e4 f2 g2 h2
Pretas (você):    K g8 · Q d8 · R a8 f8 · B c5 c8 · N c6 f6 · P a7 b7 c7 d6 e5 f7 g7 h7
Capturadas: brancas tomaram — · pretas tomaram —

   +------------------------+
 8 | r  .  b  q  .  r  k  . |
 7 | p  p  p  .  .  p  p  p |
 6 | .  .  n  p  .  n  .  . |
 5 | .  .  b  .  p  .  .  . |
 4 | .  .  B  .  P  .  .  . |
 3 | .  .  N  P  .  N  .  . |
 2 | P  P  P  .  .  P  P  P |
 1 | R  .  B  Q  .  R  K  . |
   +------------------------+
     a  b  c  d  e  f  g  h

Histórico: 1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. d3 Nf6 5. Nc3 d6 6. O-O O-O ... 11. h3 Nf6

Lances legais (é a vez das brancas; 31): a3 a4 b3 b4 Bd2 Be3 Bg5 Bxf7+ ... (capturas: Bxf7+, Nxe5; xeques: Bxf7+)

Mensagens do aluno (1 nova):
 - [lance 12] "por que você jogou o cavalo pra f6 e não pra h5?"
```

Em modo LLM vs LLM, os últimos 3 comentários do oponente aparecem numa seção
"Últimos comentários de <nome>". Respostas de erro e de tools "leves" (`comment`,
`highlight`, `end_game`, `leave_game`, `wait_for_turn` com `timeout`) usam a versão
**curta** (sem ASCII, sem lista de lances legais).

Regras do formatador:
- Sempre incluir: cabeçalho, próximo passo, FEN, listas de peças, ASCII, histórico completo
  em SAN numerado, lances legais **só quando for a vez de `perspective`** (senão, contagem
  apenas), capturas/material, mensagens pendentes, resultado final se terminou.
- Comentários anteriores **não** entram no estado (a LLM já os tem no seu contexto); apenas
  os últimos 3 comentários do oponente (modo LLM vs LLM) para dar contexto de conversa.
- Manter abaixo de ~1.500 tokens mesmo em partidas longas (histórico em SAN é compacto).

## As mesmas tools, por dentro: os bots do servidor

Quando o assento é de um **bot do servidor** (docs/09), não há transporte MCP no meio: o
`BotPlayer` chama as mesmas funções puras de `server/src/mcp/tools.ts`, com um
`ToolContext` cuja sessão é sintética (`bot:<cor>:<hex>`). Isso é deliberado — o contrato
de jogo é um só, e qualquer correção numa tool vale para os dois caminhos.

O que muda é o **conjunto oferecido ao modelo** (`server/src/bots/toolset.ts`):

| Tool | Sessão MCP | Bot do servidor |
|------|-----------|-----------------|
| `make_move` | ✓ | ✓ |
| `comment` | ✓ | ✓ |
| `highlight` | ✓ | ✓ |
| `get_state` | ✓ | ✓ |
| `end_game` | ✓ (`resign`/`draw`/`abort`) | ✓ **sem `abort`** |
| `wait_for_turn` | ✓ | — o servidor entrega o evento por `store.waitForTurn`, sem o teto de 120 s |
| `new_game`, `join_game`, `leave_game` | ✓ | — quem senta e levanta o bot é o `BotManager` (`/api/bots/*`) |
| `takeback` | ✓ | — só o humano desfaz lances |

Numa rodada que **não** é de lance (o aluno mandou uma mensagem, ou a partida acabou), o
conjunto encolhe para `comment`, `highlight` e `get_state`: o prompt diz explicitamente
"não é sua vez de jogar".

Os JSON Schemas anunciados ao provedor saem dos **mesmos shapes zod** destas tools, via
`z.toJSONSchema`, e os argumentos são revalidados com eles antes de executar — um modelo
não consegue chamar uma tool com argumento fora do contrato, nem chamar uma que não está
na lista: nos dois casos ele recebe um `tool` result de erro, em português, dizendo o que
fazer. Prompt, orçamento e política de falha dos bots estão em
[docs/03 → "Bots do servidor"](03-servidor.md#bots-do-servidor-serversrcbots).
