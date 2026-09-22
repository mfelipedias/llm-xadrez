# 00 — Visão do produto

## O problema
Jogar xadrez contra uma LLM pelo chat é frustrante: depois de 10–15 lances o modelo perde o
fio da posição, inventa peças que não existem, joga lances ilegais ou esquece o histórico.
Quem está tentando **aprender xadrez com a IA** fica sem um parceiro confiável.

## A ideia
Um **tabuleiro web** que funciona como a "memória externa" e as "mãos" da IA:

- A IA se conecta ao jogo via **MCP (Model Context Protocol)**. Qualquer cliente que fale MCP
  (Claude Desktop, Claude Code, e outros) consegue jogar.
- A IA **nunca precisa lembrar a posição**: a cada chamada de ferramenta o servidor devolve o
  estado completo e verificado (FEN, lista de peças, histórico, lances legais, xeque, etc.).
- A IA **movimenta as peças** chamando `make_move`; o tabuleiro no navegador anima o lance.
- A IA **dita cada lance** e faz **comentários de professor** quando conveniente: explica a
  ideia por trás do lance, aponta erros, sugere planos, elogia, faz perguntas ao aluno.
- A IA pode **desenhar no tabuleiro** (setas e casas destacadas) para ensinar visualmente.
- O humano joga arrastando as peças no navegador e pode **mandar mensagens/perguntas** para a
  IA pelo próprio tabuleiro. As mensagens chegam na próxima chamada de ferramenta.

## Objetivos
1. **Partida confiável**: zero lances ilegais, histórico sempre correto, estado persistido.
2. **Baixa carga cognitiva para a IA**: cada resposta de ferramenta é autossuficiente e legível
   por LLM (texto estruturado + JSON), com orientação explícita do que fazer a seguir.
3. **Experiência de aula**: painel de comentários, setas/destaques, histórico navegável,
   exportação PGN para revisar depois.
4. **Fácil de conectar**: um comando para subir o servidor; uma URL para plugar no cliente MCP.

## Modos de jogo
Cada partida tem dois **assentos** (brancas e pretas). Cada assento é ocupado por um
**humano** (navegador) ou por uma **sessão MCP** (uma LLM conectada). Isso dá três modos
sem código especial:

| Modo | Brancas | Pretas | Quem assiste |
|------|---------|--------|--------------|
| Humano vs LLM (principal) | humano ou LLM | LLM ou humano | — |
| **LLM vs LLM** | LLM A | LLM B | humano no navegador, pode mandar perguntas às duas |
| Humano vs humano | humano | humano | (útil para testar a UI) |

No modo LLM vs LLM, duas conversas diferentes (ex.: Claude Desktop e Claude Code, ou dois
chats) conectam no mesmo servidor. A primeira cria a partida e ocupa uma cor; a segunda
chama `join_game` na cor livre. Cada uma chama `wait_for_turn` e joga quando é sua vez.
O humano vê as duas comentando, cada uma identificada pelo nome que informou.

## Não-objetivos (por enquanto)
- Motor de xadrez (Stockfish) para avaliação numérica — fica como fase futura opcional.
- Várias partidas simultâneas na mesma instância — o servidor mantém **uma partida atual**
  (com histórico de partidas anteriores em arquivo). Duas LLMs na mesma partida é suportado.
- Autenticação — uso local (localhost). Expor na internet exige túnel + token (ver docs/05).

## Fluxo típico de uma partida (humano vs LLM)
1. Usuário roda `npm run dev` (ou `npm start`) e abre `http://localhost:3939`.
2. No chat do Claude, o usuário diz: "vamos jogar xadrez, eu de brancas, me ensine".
3. A IA chama `new_game({ my_color: "black" })` e recebe o estado inicial.
4. A IA chama `wait_for_turn()` — a chamada fica bloqueada até o oponente (humano) mover.
5. O humano joga `e4`. A ferramenta retorna `{event: "opponent_moved", move: "e4", ...estado}`.
6. A IA responde no chat ("Você jogou e4, o lance mais clássico...") e chama
   `make_move({ move: "e5", comment: "Disputo o centro de igual para igual." })`.
7. O tabuleiro anima e5 e mostra o comentário. A IA volta a chamar `wait_for_turn()`.
8. Repete até o fim. A IA pode chamar `comment`, `highlight`, `takeback`, `set_position`
   a qualquer momento para dar aula.

## Fluxo LLM vs LLM
1. No chat A: "conecte no xadrez e crie uma partida de brancas contra outra IA".
   A chama `new_game({ my_color: "white", opponent: "llm", my_name: "Claude Desktop" })`.
2. No chat B: "entre na partida de xadrez como pretas". B chama `join_game({ color: "black" })`.
3. A chama `wait_for_turn()` → retorna imediatamente `event: "your_turn"` (oponente sentou).
   A joga; B, que estava em `wait_for_turn()`, recebe `opponent_moved` e joga. E assim por diante.
4. O humano assiste no navegador; pode enviar mensagem para "todos", "brancas" ou "pretas".

## Princípios de design das ferramentas MCP
- **Estado sempre junto**: toda ferramenta que muda algo devolve o estado completo.
- **Erro é aula**: lance ilegal retorna motivo + lista de lances legais, nunca só "erro".
- **Dica de próximo passo**: cada resposta diz explicitamente "é sua vez: chame make_move"
  ou "aguarde o oponente: chame wait_for_turn".
- **Poucas ferramentas, bem descritas**: nomes e descrições em inglês (padrão de tool),
  conteúdo/estado em português (idioma do aluno), configurável.
