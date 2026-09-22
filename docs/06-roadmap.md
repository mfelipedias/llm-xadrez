# 06 — Roadmap e divisão de trabalho

## Fase 1 — MVP jogável (esta rodada)

Executada por três agentes; A e B em paralelo, C depois.

### Agente A — Servidor (`server/`, `scripts/mcp-smoke.ts`, testes)
1. `config.ts`, `game/rules.ts`, `game/store.ts`, `game/format.ts`, `game/persist.ts`.
2. `http/api.ts`, `http/ws.ts`.
3. `mcp/transport.ts`, `mcp/server.ts`, `mcp/tools.ts`, `mcp/prompts.ts`.
4. `index.ts` (bootstrap + static + logs de conexão).
5. Testes vitest (docs/03) — `npm test` verde.
6. `scripts/mcp-smoke.ts`: cliente MCP real (`StreamableHTTPClientTransport` do SDK) que:
   inicializa, lista tools, `new_game(my_color: black)`, humano joga `e4` via REST, LLM
   recebe `opponent_moved` em `wait_for_turn`, joga `e5` com comentário, `comment`,
   `highlight`, lance ilegal (espera `isError`), `takeback`, e por fim um Mate do Pastor
   completo; imprime cada resposta. `npm run smoke` deve terminar com "OK".
7. Também testar o cenário LLM vs LLM no smoke: duas sessões MCP, `new_game(opponent: llm)`
   + `join_game`, 4 lances alternados.

### Agente B — Frontend (`web/`)
1. `index.html`, `main.tsx`, `App.tsx`, `api.ts` (`useGameSocket`, chamadas REST).
2. Componentes de docs/04. Verificar a API exata do `react-chessboard` instalado.
3. `styles.css` responsivo, tema escuro, tipografia legível.
4. Estado de desenvolvimento sem servidor: `web/src/dev/fixtures.ts` com um `GameState`
   de meio-jogo (com comentários, destaques, mensagens) e `?mock=1` na URL para rodar a UI
   com esse fixture e sem WebSocket (útil para desenvolver e para screenshots).
5. `npm run build` (typecheck + vite build) sem erros.

### Agente C — Integração e validação (depois de A e B)
1. `npm install`, `npm test`, `npm run build`, `npm start`.
2. `npm run smoke` contra o servidor rodando.
3. Abrir a UI com Playwright/Chrome: nova partida humano brancas, jogar `e4` arrastando ou
   via clique, conferir que o feed mostra o lance; rodar o smoke em paralelo e conferir que
   o lance/comentário/seta da "IA" aparece; screenshot em `docs/img/ui.png`.
4. Corrigir bugs encontrados (em qualquer pasta), rodar tudo de novo.
5. Conferir `.mcp.json` com Claude Code: `claude mcp list` mostra `xadrez` conectado.
6. Atualizar README com o que foi validado.

## Fase 2 — Qualidade de aula
- Navegação por variantes: a LLM propõe "e se você tivesse jogado X?" via `show_line`
  (sequência de lances numa cópia da posição, exibida como variante sem alterar a partida).
- Histórico de partidas na UI (`/api/games`), reabrir PGN antigo em modo revisão.
- Relógio opcional (só informativo) e contagem de tempo de reflexão de cada lado.
- Perfil do aluno persistido (nível, aberturas preferidas) exposto como recurso MCP para a
  LLM personalizar as aulas.
- i18n completo (en).

## Fase 3 — Motor
- `analyze` tool com Stockfish (WASM ou binário local): avaliação, melhor lance, erros
  (blunder/mistake/inaccuracy) por lance. A LLM usa isso para comentar com precisão.
- Modo "revisão pós-jogo": a LLM percorre a partida com a análise e explica os momentos-chave.
- Barra de avaliação na UI (opcional, pode ser escondida para não dar spoiler).

## Fase 4 — Extras
- Puzzles diários (import de PGN/FEN de bases públicas), com a LLM como tutor.
- Vozes: leitura dos comentários em voz alta (Web Speech API).
- Modo torneio LLM vs LLM com placar acumulado.
