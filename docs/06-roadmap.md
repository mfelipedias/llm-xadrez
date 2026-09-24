# 06 — Roadmap

Estado em **2026-09-23**. O histórico de execução por onda/agente está em
[docs/11](11-execucao.md); aqui fica o que já existe e o que vem depois.

---

## ✅ Fase 1 — MVP jogável (entregue)

Tabuleiro web + servidor MCP: `GameStore` como fonte única de verdade, 10 tools,
prompt `chess_teacher`, 3 recursos, REST + WebSocket para o navegador, persistência e PGN.
Validada de ponta a ponta com cliente MCP real (`npm run smoke`, `npm run play`) e com a UI
no Chromium. Detalhes do que foi verificado: [README](../README.md#validado).

## ✅ Fase 2 — Bots via provedores (entregue)

Plano: [docs/09](09-plano-provedores-gateway.md). O servidor passou a saber ocupar um
assento sozinho, falando com um provedor de LLM — sem cliente de chat no meio.

- `SeatKind` ganhou `"bot"`; o bot é um ocupante como outro qualquer, com sessão sintética,
  fila de eventos e `store.waitForTurn`.
- Camada de provedores: um adaptador OpenAI-compatível com `fetch` nativo (OpenRouter,
  Ollama, LM Studio, LiteLLM, vLLM, llama.cpp, Jan, custom) e um adaptador Anthropic com
  `@anthropic-ai/sdk` por import dinâmico.
- Dois modos de falar com o modelo: tool calling nativo e **texto estruturado**, para
  modelos pequenos; `"auto"` decide na primeira rodada.
- Orçamento por partida (US$ 1,00 / 400k tokens, ajustável por perfil), política de falha
  (`pause` contra humano, `random_legal` contra bot), backoff em 429/5xx.
- UI: seletor por assento em "Nova partida", tela "Provedores", placa de assento com
  status/uso e menu "⋯", `npm run smoke:bot`.

**Pendente desta fase:** nada foi executado contra um provedor pago ou local **real** — só
mocks e o provedor `fake` (ver [docs/05](05-conectar-clientes.md#ou-use-um-bot-do-servidor)).
O primeiro teste com chave de verdade é o próximo passo natural.

## ✅ Fase 3 — Redesign de UX (entregue)

Plano: [docs/10](10-plano-redesign-ux.md). A interface foi reconstruída em cima de tokens
semânticos.

- Tema claro/escuro seguindo o sistema, Literata auto-hospedada, presets de casas.
- Mesa: placas de assento acima e abaixo do tabuleiro, moldura com coordenadas fora,
  régua de lances sob o tabuleiro, banner de fim de partida.
- Caderno com abas Aula/Lances/Ações e o campo de mensagem colado ao pé.
- Onboarding guiado "zero → IA conectada" em quatro passos com detecção automática.
- `<dialog>` e `popover` nativos; toasts acessíveis; modo revisão; modo espectador.
- **Tabuleiro jogável só com o teclado** ([docs/12](12-teclado.md)), regiões `aria-live`
  fixas, notação com figurinhas SVG.

**Medição real:** axe-core 4.x via Playwright, 0 violações em 17 cenários, mais contraste,
alvos e reflow por `getComputedStyle`. **O Lighthouse nunca rodou** nesta máquina — nenhum
doc do projeto afirma nota dele.

**Pendente desta fase:** o fluxo "zero → IA conectada" nunca foi testado com um cliente MCP
no ar (o servidor `xadrez` do `.mcp.json` está com `ConnectionRefused` aqui), e os anúncios
de leitor de tela foram conferidos pelo conteúdo das regiões `aria-live`, não com NVDA ou
VoiceOver de verdade.

## ✅ Fase 3.5 — Conexões e provedores próprios (entregue)

Rodada de correções de conexão, depois de uso real com Docker e clientes diferentes.

- **MCP**: token também por `?token=` (Claude.ai/ChatGPT não mandam header);
  `wait_for_turn` com default de 25 s; `new_game` recusa apagar partida em andamento ou
  com assento esperando sem `confirm: true`, e as instruções mandam usar `join_game`;
  sessões ociosas fechadas em 30 min; assento de sessão viva não se toma pelo nome.
- **Rede**: validação de `Host` em todas as rotas (`PUBLIC_URL`/`ALLOWED_HOSTS`), porta do
  Docker em `127.0.0.1` (`BIND_ADDR`), `extra_hosts` e `env_file` no compose, `/.well-known`
  com 404.
- **Administração**: loopback e `ADMIN_ALLOW_FROM` sempre; de fora, `ADMIN_TOKEN`. A UI
  pede o token quando o servidor recusa.
- **Provedores**: "Novo provedor" na UI (servidor seu na mesma máquina, na rede ou remoto),
  `PUT` como upsert com validação, redes locais sem chave, teste com dica ciente do
  Docker.
- **Onboarding**: snippets corretos por cliente e runtime (Claude Code `-s user`, Claude
  Desktop via `mcp-remote`, Claude.ai/ChatGPT por túnel, Codex, Cursor), sem nunca mostrar
  o token.

**Pendente desta fase:** nada disto foi exercitado com Claude.ai/ChatGPT por um túnel real,
nem contra um Ollama/LM Studio de verdade em outra máquina — a UI foi validada com
`?mock=docker` (axe: 0 violações nos estados novos) e o servidor com os testes.

---

## Fase 4 — Fechar o que ficou aberto

Itens pequenos, herdados das duas fases acima. Ordem sugerida.

1. **Primeiro jogo contra um provedor real.** `npm run smoke:bot -- --provider anthropic`
   (ou `openrouter`, ou um local no ar) com chave de verdade, anotando o que quebrar.
   Conferir de quebra se o `cache_control` está mesmo cacheando (`usage.cachedInputTokens`
   depois de alguns lances) — o prompt de sistema tem ~800 tokens e o prefixo mínimo
   cacheável vai de 512 a 4096 conforme o modelo.
2. **"Zero → IA conectada" com Claude Code no ar**, cronometrado, fechando o critério de
   aceite da Fase 2 do plano 10.
3. **Leitor de tela de verdade** (NVDA no Windows, VoiceOver no macOS) no roteiro de
   [docs/12](12-teclado.md).
4. **Tabela de preços do adaptador Anthropic**: hoje o `estimatedCostUsd` sai de uma tabela
   local, que envelhece. Decidir entre atualizá-la a cada release ou marcar o número como
   aproximado na UI.

## Fase 5 — Aula mais rica

- **Streaming do texto do assistant** para os bots: hoje o comentário só aparece quando a
  tool é executada, e a espera é um "pensando há N s". Com streaming, o texto parcial
  apareceria como "digitando…" no caderno. Exige um canal WS a mais e um acumulador de
  delta que aguente provedores locais heterogêneos — por isso ficou fora da v1
  ([docs/09 §3.7](09-plano-provedores-gateway.md#37-streaming)).
- **Navegação por variantes**: a IA propõe "e se você tivesse jogado X?" via `show_line`
  (sequência de lances numa cópia da posição, exibida como variante sem alterar a partida).
- **Histórico de partidas na UI**: `/api/games` e `/api/games/:id/pgn` já existem no
  servidor; falta a tela e o modo "reabrir PGN antigo em revisão".
- **Relógio opcional** (informativo) e tempo de reflexão de cada lado — com bots, o tempo
  por lance é dado interessante por si só.
- **Perfil do aluno** persistido (nível, aberturas preferidas) exposto como recurso MCP e
  injetado no prompt dos bots, para a aula não recomeçar do zero a cada partida.
- **CRUD de perfis de bot** (`/api/profiles`): estava no plano 09 §5.3 e não foi feito; hoje
  perfis se editam no `providers.json`. Só vale a pena com um editor decente na tela
  "Provedores".
- **i18n completo (en)**: o servidor já formata o estado em `en` por `LANG`; a UI e os
  prompts dos bots continuam só em pt-BR.

## Fase 6 — Motor

- **`analyze`**: Stockfish (WASM ou binário local) com avaliação, melhor lance e
  classificação de erro (blunder/mistake/inaccuracy) por lance.
- **Disponibilizar `analyze` ao bot**: hoje o conjunto de tools de um bot é
  `make_move`/`comment`/`highlight`/`get_state`/`end_game`
  ([docs/02](02-contrato-mcp.md#as-mesmas-tools-por-dentro-os-bots-do-servidor)). Com o
  motor no ar, `analyze` entra nesse conjunto e o professor passa a comentar com números em
  vez de intuição. Duas coisas a resolver junto: o custo (cada análise é uma rodada a mais
  no orçamento) e a tentação de o modelo virar papagaio do motor — o prompt precisa pedir
  explicação, não avaliação.
- **Modo "revisão pós-jogo"**: a IA percorre a partida com a análise e explica os
  momentos-chave.
- **Barra de avaliação na UI**, escondível para não dar spoiler.

## Fase 7 — Extras

- **Torneio bot vs bot**: hoje dá para sentar dois bots e assistir, mas cada partida é
  avulsa. Falta o que faz disso um torneio — uma fila de confrontos (modelo A × modelo B,
  cores alternadas, N partidas), placar acumulado e um resumo por modelo: resultado, lances
  ilegais tentados, tokens e custo por partida. O orçamento por partida já existe; o que
  falta é um teto por **torneio** e uma tela de placar. Serve para comparar modelos de
  verdade, que é a pergunta que todo mundo faz ao ver dois bots jogando.
- **Puzzles diários** (import de PGN/FEN de bases públicas), com a IA como tutora.
- **Vozes**: leitura dos comentários em voz alta (Web Speech API).
