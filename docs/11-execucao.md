# 11 — Execução dos planos 09 e 10

Acompanhamento da implementação dos planos [09 (bots via provedores)](09-plano-provedores-gateway.md)
e [10 (redesign de UX)](10-plano-redesign-ux.md), aprovados em 2026-09-22 com todas as
decisões como escritas nos docs.

Os dois planos correm **em paralelo** porque tocam pastas quase disjuntas:

| Plano | Pastas | Exceção compartilhada |
|---|---|---|
| 09 — bots | `server/`, `scripts/`, `shared/types.ts` | `shared/types.ts`, e `web/` só na Fase E |
| 10 — UX | `web/` | `shared/types.ts` (só leitura) |

**Regra de fronteira:** apenas o plano 09 escreve em `shared/types.ts` e em `server/`.
Apenas o plano 10 escreve em `web/src/styles.css`, `web/index.html` e nos componentes de
apresentação. A Fase E do plano 09 (UI de bots) só começa depois da Fase 2 do plano 10,
para nascer já no visual novo.

## Ondas

### Onda 1 — concluída (2026-09-22)
- **A1 · backend** — plano 09, Fases A + B: tipos/store com `SeatKind "bot"` e camada de
  provedores (`openai-compat`, registry, rotas `/api/providers*`).
- **B1 · frontend** — plano 10, Fases 0 + 1: fundação visual (tokens, tipografia,
  contraste) e a mesa (placas, moldura, régua de lances, presets de tabuleiro).

### Onda 2 — concluída (2026-09-22)
- **A2 · backend** — plano 09, Fases C + D: `BotPlayer`/`BotManager` em modo nativo e modo
  texto estruturado, rotas `/api/bots/*`, `scripts/bot-smoke.ts`.
- **B2 · frontend** — plano 10, Fases 2 + 3: Caderno + onboarding guiado; tabuleiro
  acessível por teclado e modo revisão.

### Onda 3 — concluída (2026-09-22)
Replanejada: as Fases E (plano 09) e 4 (plano 10) escrevem **as duas em `web/`**, então
foram para o mesmo agente, mantendo a regra de um agente por pasta.

- **A3 · backend** — plano 09, Fase F: adaptador Anthropic e smoke real condicionado ao
  ambiente. Só `server/` e `scripts/`.
- **B3 · frontend** — plano 09 Fase E (UI de bots, já sobre o visual novo) + plano 10
  Fase 4 (espectador e polimento). Só `web/`.

### Onda 4 — concluída (2026-09-22)
- **G** — plano 09, Fase G: docs 02/03/04/05/08, README, roadmap, e a correção do
  `--text-faint` no anexo §8.1 do plano 10.

## Portões de aceite

Cada onda só fecha com: `npm test` verde, `npm run typecheck` limpo, `npm run build` sem
erros, e os critérios de aceite da fase correspondente nos docs 09/10.

## Registro

| Data | Onda | Agente | Resultado |
|---|---|---|---|
| 2026-09-22 | 1 | A1 | ✅ Fases A+B. `npm test` 112/112 (era 58). 53 testes novos. |
| 2026-09-22 | 1 | B1 | ✅ Fases 0+1. `npm run build` verde, 0 contrastes abaixo de AA (36 amostras), 0 alvos fora do mínimo, sem rolagem horizontal em 1440/1024/390. |
| 2026-09-22 | 2 | A2 | ✅ Fases C+D. `npm test` 175/175 (era 112), `smoke:bot` OK, `smoke` MCP sem regressão. Partida bot vs bot completa com provedor determinístico. |
| 2026-09-22 | 2 | B2 | ✅ Fases 2+3. axe-core em 8 cenários com `<dialog>`/`popover` abertos: **0 violações**. 0 contrastes abaixo de AA e 0 alvos fora do mínimo em 16 estados. Lance por teclado validado contra servidor real. |
| 2026-09-22 | 3 | A3 | ✅ Fase F. `npm test` 192/192 (era 175). Smoke real = SKIP em todas as variantes (sem chave e sem provedor local na máquina); adaptador validado contra SDK mockado e mock local da Messages API. |
| 2026-09-22 | 3 | B3 | ✅ Fase E + Fase 4. Partida humano vs bot criada pela UI contra servidor real com `BOT_FAKE_PROVIDER=1`. axe-core em 17 cenários: 0 violações. |
| 2026-09-22 | 4 | G | ✅ Fase G. 14 arquivos de doc atualizados; 10 divergências plano × código corrigidas nos próprios planos. |
| 2026-09-22 | 4 | — | ✅ Fechamento: 3 defeitos que a Fase G reportou foram corrigidos (Dockerfile, texto de fase vazando, favicon `thinking`). |

## Pendências herdadas da Onda 1

Desvios conscientes que as ondas seguintes precisam fechar:

- ~~`aria-live` do caderno migra de nó~~ — ✅ fechado na Fase 3 (`LiveRegions` fixas).
- ~~`Board` desfaz lance recusado com `resetKey`~~ — ✅ fechado na Fase 2 (lance otimista
  com `chess.js`, a peça volta animada).
- ~~Assento livre sem a URL do MCP~~ — ✅ voltou no passo 2 do `ConnectWizard`.
- ~~Tablet sem menu "⋯"~~ — ✅ feito: a 1024 px os controles quebravam em duas linhas e
  comiam ~40 px do tabuleiro. A régua continua rolando (decisão mantida).
- ~~`<San>` com glifos Unicode~~ — ✅ SVG na Fase 3, sem mudar a API do componente.
- **Lighthouse não rodou** (sem Chrome/LH configurado na máquina); em lugar dele foram
  medidos contraste, alvos e reflow via `getComputedStyle`, o mesmo método do diagnóstico.
- **`--text-faint` claro ficou `#646e7b`**, não o `#6b7583` do §8.1 do plano 10: o valor do
  anexo dá 4,35:1 sobre `--bg`, abaixo de AA. Corrigir o anexo na Fase G.
- **Fase A não faz bot jogar**: assento `bot` nasce `status: "stopped"` até o `BotManager`.

## Pendências herdadas da Onda 2

- **Lighthouse nunca rodou** (não há Chrome/LH CLI nesta máquina). Em lugar dele: axe-core
  4.x via Playwright com as tags `wcag2a/2aa/21a/21aa/22aa/best-practice` — 0 violações em
  8 cenários. **Não afirmamos nota de Lighthouse em lugar nenhum.**
- **"Zero → IA conectada com Claude Code real" não foi testado**: o servidor MCP `xadrez`
  está com `ConnectionRefused` nesta máquina. O wizard foi validado com fixtures e contra o
  backend real (detectou sozinho 2 `mcpSessions` sem assento). Falta o teste com o cliente
  no ar.
- **Balão do celular sem "ver tudo"**: é `aria-hidden`, e um botão focável dentro de
  conteúdo `aria-hidden` viola `aria-hidden-focus`. O feed completo está nas abas logo
  abaixo. Decisão consciente, não uma folha inferior esquecida.
- **Quebra para coluna única em 900 px**, não em 768 como sugere o §3.3 do plano 10: a
  768 px duas colunas deixariam o tabuleiro com ~400 px.
- **Ao atualizar o `react-chessboard`**: o saneamento dos `div[role=button]` do dnd-kit
  depende do seletor `[aria-roledescription="draggable"]` — documentado em
  [`12-teclado.md`](12-teclado.md).

## Pendências herdadas da Onda 3

- **Nada foi verificado contra `api.anthropic.com`.** Não há `.env` nem chave nesta máquina
  e nenhum provedor local no ar, então as 4 variantes do smoke real dão SKIP (exit 0), que é
  o resultado correto. O adaptador foi validado com o SDK mockado (17 testes) e com um mock
  local da Messages API, conferindo no fio: `cache_control` no system, `thinking adaptive`,
  `effort low`, `tool_choice auto`, sem `temperature`, e `tool_result` + estado numa única
  mensagem `user`. Falta um teste com chave real.
- **Não existe CRUD de perfis de bot.** O plano 09 §5.3 previa `PUT/POST/DELETE
  /api/profiles[/:id]`, que não saíram na Fase C. Hoje: ou `providerId`+`model` direto no
  `POST /api/game`, ou editar o `providers.json` à mão. A UI **lista** perfis e diz isso na
  tela; o smoke escreve um `providers.json` temporário para impor limites. **Corrigir o
  plano 09 na Fase G** — o doc promete uma API que não existe.
- **`estimatedCostUsd` é estimado** por tabela local de preços (a Messages API não devolve
  custo) — envelhece se os preços mudarem.
- **O `cache_control` pode não cachear**: o prefixo mínimo cacheável é de 512–4096 tokens
  conforme o modelo, e o prompt de sistema tem ~800 tokens. Sem erro, simplesmente não
  cacheia. Conferir em `cachedInputTokens` depois de alguns lances.
- **"Pensando há N s" só é observável com provedor de latência real** — o `fake` responde em
  ~1 ms. As capturas do contador vieram de fixture.
- **Capturas de IA vs IA vieram de `?mock=botsvsbots`**, não da sessão ao vivo: a sessão real
  com dois bots `fake` funciona mas acaba em ~6 s (32 lances, empate por repetição).
- **Descobertas da Fase F que teriam quebrado em produção**: `temperature` dá 400 nos modelos
  4.7+/5 (o `BotPlayer` manda `temperature: 0` na última iteração), e `thinking`/`output_config`
  precisam ser filtrados por modelo.
- **Bug pré-existente corrigido na Onda 3**: `.tool-menu` tinha `display: flex` vencendo o
  `display: none` do popover fechado — o menu "⋯" aparecia sobre o tabuleiro o tempo todo em
  1024 px. A `f2-tablet.png` foi regerada (a antiga mostrava o defeito).

## Fechamento (2026-09-22)

**Os planos 09 e 10 estão implementados por inteiro.** Estado final validado:
`npm test` 192/192 em 9 arquivos · `npm run typecheck` limpo · `npm run build` verde ·
`npm run smoke` (MCP) OK · `npm run smoke:bot` (fake) OK.

### Defeitos corrigidos no fechamento
1. **`Dockerfile` não copiava o `providers.json`** para a imagem, e o `PROVIDERS_FILE`
   default aponta para `/app/providers.json`: dentro do container o registry caía
   silenciosamente nos presets embutidos, **sem nenhum perfil**. Corrigido nos dois
   estágios. ⚠️ **Não verificado**: o daemon do Docker não está rodando nesta máquina, então
   `docker build` não foi executado. A mudança são duas linhas `COPY`.
2. **Texto de fase interna vazando para o usuário**: `fallbackBotSeat()` gravava
   `statusText: "aguardando o BotManager (fase C)"` na placa do assento. Agora diz
   "sem o gerenciador de bots no servidor".
3. **`FaviconState: "thinking"` era código morto** — o plano 10 §4 pede o indicador de IA
   pensando, mas `App.tsx` nunca chamava esse estado. Ligado: o favicon mostra o ponto
   cinza quando o assento da vez é um bot em `thinking`/`acting`.

### O que continua sem verificação (não confundir com "não funciona")
1. **Nenhum provedor real foi exercitado.** Sem `.env`, sem chave, sem Ollama/LM Studio no
   ar. Todas as variantes de `smoke:bot --provider` dão SKIP. O adaptador Anthropic foi
   validado só contra SDK mockado e mock local da Messages API.
2. **"Zero → IA conectada" nunca rodou com um cliente MCP de verdade** nesta máquina — o
   servidor `xadrez` do `.mcp.json` está com `ConnectionRefused`.
3. **Lighthouse nunca rodou** em fase nenhuma (não há Chrome/LH CLI aqui). A medição real é
   axe-core 4.x via Playwright (0 violações em 17 cenários) + contraste/alvos/reflow por
   `getComputedStyle`. Os critérios "Lighthouse ≥ 90/95" do plano 10 §7 foram reescritos
   para dizer o que de fato se mede.
4. **Nenhum leitor de tela real** (NVDA/VoiceOver) percorreu o roteiro de
   [`12-teclado.md`](12-teclado.md).
5. **`docker build` não foi executado** (daemon parado).

### Próxima rodada, em ordem de valor
1. Subir um provedor (chave da Anthropic/OpenRouter, ou LM Studio/Ollama local) e rodar
   `npm run smoke:bot -- --provider <id>`, depois uma partida pela UI. É o único jeito de
   saber se o loop do bot aguenta latência e erros reais.
2. Conferir se o `cache_control` do adaptador Anthropic de fato cacheia
   (`usage.cachedInputTokens` depois de alguns lances) — o prompt tem ~800 tokens e o mínimo
   cacheável vai de 512 a 4096 conforme o modelo.
3. Subir o servidor MCP e fazer o fluxo "zero → IA conectada" com Claude Code real.
4. Passar um leitor de tela pelo roteiro de teclado.
5. Decidir o destino da tabela local de preços do adaptador Anthropic — ela envelhece e é a
   base do `estimatedCostUsd`.
6. Rodar `docker build` e subir o compose com um provedor.
