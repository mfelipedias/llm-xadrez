# 09 — Plano: bots via provedores/gateways (OpenRouter, locais, Anthropic)

> **Status: plano, nada implementado.** Documento de planejamento para o servidor conseguir
> "sentar" uma IA num assento sozinho, conectando-se a um provedor de LLM por API, sem
> depender de um cliente MCP externo. Ao implementar, atualizar `docs/02`, `docs/03`,
> `docs/04` e `shared/types.ts` conforme a seção 5.

## 0. Contexto e objetivo

Hoje uma LLM só joga se um cliente MCP (Claude Desktop, Claude Code, Jan, Codex...) conectar
em `/mcp` e chamar as tools. O objetivo é adicionar um terceiro tipo de ocupante de assento,
o **bot**, que o próprio servidor opera: um loop agentic que chama um provedor de chat com
tool calling e executa **as mesmas funções de tool** de `server/src/mcp/tools.ts` sobre o
mesmo `GameStore`. Casos de uso alvo:

| Caso | Brancas | Pretas |
|------|---------|--------|
| Humano vs bot do OpenRouter | humano | bot (`openrouter`, `anthropic/claude-sonnet-4.6`) |
| Dois bots de provedores diferentes | bot (`openrouter`, modelo A) | bot (`ollama`, modelo B) |
| Bot local vs Claude via MCP | bot (`lmstudio`, modelo local) | sessão MCP (`join_game`) |
| Humano vs Claude direto pela API | humano | bot (`anthropic`, `claude-opus-5`) |

Provedores cobertos:
- **Gateways**: OpenRouter, LiteLLM proxy, qualquer gateway OpenAI-compatível (base URL custom).
- **Locais/homelab**: Ollama (`/v1`), LM Studio, llama.cpp server, vLLM, Jan local server.
- **Anthropic** (Messages API) — opcional, adaptador próprio.

### O que foi verificado nesta máquina (2026-09-22, sem instalar nada)

| Item | Resultado |
|------|-----------|
| `ollama` no PATH / `%LOCALAPPDATA%\Programs\Ollama` | **não instalado**. Existe `~/.ollama/` com par de chaves e `models/` **vazio** (resquício) |
| porta 11434 (Ollama) | fechada |
| LM Studio | CLI presente em `C:\Users\mfeli\.lmstudio\bin\lms.exe`; `lms server status` → "not running"; `lms ls` falha ("daemon is not running"); `~/.lmstudio/models/` **vazio**; há `server-logs/2026-05` (foi usado em maio) |
| porta 1234 (LM Studio) | fechada |
| porta 8080 (llama.cpp) / 1337 (Jan) | fechadas |
| `node_modules` | não há `openai` nem `@anthropic-ai/sdk`; Node **24.14.1**, `zod` **4.6** (tem `z.toJSONSchema`), fetch nativo |

Conclusão: **não há como fazer smoke local com modelo real sem uma ação do usuário**
(baixar um modelo no LM Studio e subir o servidor em `:1234`, ou instalar Ollama). O plano
prevê o smoke como opcional/condicional (seção 8).

### Formatos de API confirmados (docs oficiais, set/2026)

- **OpenRouter**: `POST https://openrouter.ai/api/v1/chat/completions`, `Authorization: Bearer`,
  `tools[]` (function + JSON Schema), `tool_choice` (`auto|none|{function}`),
  `parallel_tool_calls`; resposta `finish_reason: "tool_calls"` + `message.tool_calls[]`
  (`id`, `function.name`, `function.arguments` **string JSON**); resultado volta como
  `{ role: "tool", tool_call_id, content }`; a lista `tools` deve ir em **toda** requisição.
  Filtro de modelos com tools: `GET /api/v1/models?supported_parameters=tools`. Headers
  opcionais `HTTP-Referer` e `X-Title` para aparecer no ranking. Streaming: acumular
  `delta.tool_calls`.
- **Ollama**: base `http://localhost:11434/v1`; `/v1/chat/completions` com `tools` e
  streaming com tools OK; **`tool_choice` não suportado** (ignorar/omitir); exige um valor
  qualquer de API key no cliente (ignorado). `GET /v1/models` existe; `GET /api/tags` é o
  nativo (traz tamanho/família — útil para a UI). Endpoint nativo `/api/chat` também aceita
  `tools`, mas não precisamos dele: o `/v1` cobre.
- **LM Studio**: base `http://localhost:1234/v1`; `/v1/models`, `/v1/chat/completions`
  com tool use (nativo para modelos com template de tools; "default tool use" por prompt
  para os demais — qualidade varia); sem API key. Há também `GET /api/v0/models` (estado
  loaded/unloaded, tipo, contexto) — útil mas não obrigatório.
- **llama.cpp server / vLLM / Jan / LiteLLM**: OpenAI-compatível. Tool calling em
  llama.cpp requer `--jinja`; em vLLM requer `--enable-auto-tool-choice --tool-call-parser
  <parser>`. Quando não configurado, o modelo devolve texto em vez de `tool_calls` → cai no
  modo "texto estruturado" (seção 2.4).
- **Anthropic Messages API**: `tools[{ name, description, input_schema }]`, resposta com
  blocos `tool_use { id, name, input }` e `stop_reason: "tool_use"`; resultados voltam numa
  mensagem `user` com blocos `tool_result { tool_use_id, content, is_error? }`. Modelos
  atuais (IDs exatos, sem sufixo de data): `claude-opus-5` ($5/$25 por MTok in/out),
  `claude-sonnet-5` ($2/$10), `claude-haiku-4-5` ($1/$5), `claude-fable-5-1` ($10/$50).
  Nos modelos 4.6+ usar `thinking: { type: "adaptive" }` + `output_config.effort`
  (`low`/`medium` bastam para escolher lances); **não** usar `tool_choice: any/tool` no
  Fable 5.1 (400) — usar `auto` + instrução no prompt. Sem prefill de assistant.

## 1. Modelo conceitual: `BotPlayer` ocupa um assento

### 1.1 Três tipos de ocupante, uma só interface de jogo

```
Seat.kind:  "human"  → navegador (REST /api/move)
            "mcp"    → sessão MCP externa (tools via /mcp)
            "bot"    → BotPlayer interno (mesmas tools, chamadas em processo)   ← NOVO
            "empty"
```

Princípio: **o `GameStore` não sabe o que é um provedor de LLM.** Para ele, o bot é
apenas "um ocupante com `sessionId`" — exatamente como uma sessão MCP. O `BotPlayer`
registra uma **sessão sintética** (`sessionId = "bot:<color>:<uuid>"`) com
`store.sessionOpened(id)`, senta com `store.seat(color, { kind: "bot", name, sessionId })`
e a partir daí chama `toolMakeMove(ctx, args)`, `toolComment(ctx, args)`, etc. com um
`ToolContext { store, session: { id }, lang }` — o mesmo contexto que `server.ts` monta
para uma sessão MCP. Isso garante:

- **Reuso total** de `tools.ts` (validação, textos de erro didáticos com lances legais,
  `withState`, entrega de mensagens do humano, `touchSession`). Nada de duplicar regras.
- **Mesmos eventos**: `pushEvent`, filas por assento, `waitForTurn`, `opponent_moved`,
  `message`, `takeback`, `game_over`, `new_game`, `not_seated` funcionam sem mudança.
- **UI quase igual**: o assento mostra ícone/nome/atividade; só muda o rótulo
  ("bot · openrouter/…") e um badge de status mais rico (seção 5.3).

### 1.2 O que o bot NÃO expõe à LLM

O loop do bot gerencia ciclo de vida; a LLM só recebe tools de jogo:

| Tool | Exposta à LLM do bot? | Motivo |
|------|-----------------------|--------|
| `make_move` | sim | |
| `comment` | sim | |
| `highlight` | sim | |
| `get_state` | sim | raramente necessária (o estado já vai em toda mensagem), mas barata |
| `takeback` | opcional (`allowTakeback`, default **off**) | evitar bot desfazendo lances do aluno por conta própria |
| `end_game` | sim, só `resign`/`draw` (`abort` filtrado) | aceitar empate oferecido pelo humano |
| `wait_for_turn` | **não** | o runner espera via `store.waitForTurn` internamente (seção 3.1) |
| `new_game`, `join_game`, `leave_game` | **não** | o servidor/UI controla quem senta |

### 1.3 Onde vive

```
server/src/
├── bots/                    # (implementado no plural; era `bot/` no plano)
│   ├── player.ts            # BotPlayer: sessão sintética, loop, cancelamento, orçamento
│   ├── manager.ts           # BotManager: um BotPlayer por cor; start/stop; reage a new_game/unseat
│   ├── prompt.ts            # system prompt (professor/adversário, nível, idioma)
│   ├── toolset.ts           # tools expostas (nome, descrição, JSON Schema via z.toJSONSchema) e dispatcher → tools.ts
│   ├── textmode.ts          # parser tolerante "MOVE: … | COMMENT: …" e prompt do modo texto
│   ├── budget.ts            # contagem de tokens/chamadas por partida, limites
│   └── providers/           # (implementado aninhado em bots/, não solto em server/src/)
│       ├── types.ts         # ChatProvider, ChatMessage, ToolSpec, ChatResult, ProviderError
│       ├── openai-compat.ts # OpenRouter, LiteLLM, Ollama /v1, LM Studio, llama.cpp, vLLM, Jan, custom
│       ├── anthropic.ts     # Messages API via @anthropic-ai/sdk (import dinâmico)
│       ├── registry.ts      # carrega providers.json + .env, resolve chaves, presets
│       └── fake.ts          # provider determinístico para testes (joga do livro/aleatório)
└── http/api.ts              # + rotas /api/providers*, /api/bots/*, POST /api/game com seats
```

*(Corrigido na Fase G: o plano propunha `server/src/bot/` e `server/src/providers/`; a
implementação usa `server/src/bots/` e `server/src/bots/providers/`, para manter tudo que
é "bot" debaixo de uma pasta só.)*

## 2. Camada de provedores

### 2.1 Abstração `ChatProvider`

Interface mínima, neutra, orientada a **uma rodada** de chat com tools (o loop fica no bot):

```ts
// server/src/providers/types.ts
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema (de z.toJSONSchema)
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

export interface ToolCall { id: string; name: string; args: Record<string, unknown>; rawArgs?: string }

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** "auto" | "none" | { name } — adaptadores ignoram quando o provedor não suporta (Ollama). */
  toolChoice?: "auto" | "none" | { name: string };
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ChatResult {
  text: string;                 // texto do assistant (pode ser vazio)
  toolCalls: ToolCall[];        // vazio se não houve
  finishReason: "stop" | "tool_calls" | "length" | "other";
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; costUsd?: number };
  raw?: unknown;                // para debug (LOG_LEVEL=debug), nunca persistido
}

export interface ChatProvider {
  readonly id: string;                        // "openrouter", "ollama-local"...
  readonly kind: "openai" | "anthropic";
  readonly supportsTools: boolean;            // capacidade declarada (config), não detecção
  chat(req: ChatRequest): Promise<ChatResult>;
  listModels(): Promise<ModelInfo[]>;         // GET /v1/models (ou /api/v1/models no OpenRouter)
  test(): Promise<{ ok: true; latencyMs: number; models: number } | { ok: false; error: string }>;
}

export interface ModelInfo { id: string; name?: string; contextLength?: number; supportsTools?: boolean; pricing?: { prompt?: number; completion?: number } }
```

`ProviderError` carrega `status` (401/402/404/429/5xx), `retryable: boolean`,
`retryAfterMs?` e `body` (truncado, sem cabeçalhos) para o loop decidir backoff.

### 2.2 Adaptador OpenAI-compatível (um só para 7 provedores)

Diferenças conhecidas, tratadas por **flags na config do provedor** (não por detecção):

| Flag | Default | Usa em |
|------|---------|--------|
| `baseUrl` | — | todos (`https://openrouter.ai/api/v1`, `http://localhost:11434/v1`, `http://localhost:1234/v1`, ...) |
| `apiKeyEnv` | — | OpenRouter/LiteLLM; para locais pode ser vazio → manda `Bearer local` (Ollama exige algo, LM Studio ignora) |
| `toolChoice` | `true` | `false` no Ollama (não suporta `tool_choice`) |
| `parallelToolCalls` | `false` | mandamos `parallel_tool_calls: false` onde aceito (OpenRouter); ignorado nos locais |
| `extraHeaders` | `{}` | OpenRouter: `HTTP-Referer`, `X-Title: "LLM Xadrez"` |
| `extraBody` | `{}` | OpenRouter: `usage: { include: true }`, `reasoning: { effort: "low" }`; vLLM/llama.cpp: nada |
| `toolMode` | `"native"` | `"text"` força modo texto estruturado (seção 2.4); `"auto"` começa nativo e cai para texto se a 1ª resposta não trouxer `tool_calls` |
| `modelsPath` | `/models` | OpenRouter aceita `?supported_parameters=tools`; Ollama pode complementar com `/api/tags` |
| `timeoutMs` | `60000` (cloud) / `180000` (local) | modelos locais em CPU demoram |

*(Corrigido na Fase G: o `extraBody` do preset OpenRouter ficou `usage: { include: true }`
— que faz o gateway devolver o custo em dólares no `usage`, alimentando o orçamento — em
vez de `provider: { sort: "price" }`, que escolheria a rota mais barata mas esconderia o
preço. O `modelsQuery` saiu como campo próprio, separado de `modelsPath`.)*

Detalhes de implementação:
- `function.arguments` chega como **string JSON**; parse tolerante (aceitar objeto já
  parseado — alguns servidores locais fazem isso; tentar `JSON.parse`, senão tentar extrair
  o primeiro `{...}` balanceado; se falhar, devolver `tool` result com erro pedindo JSON
  válido). Sempre validar com o schema zod correspondente **antes** de executar.
- Sem streaming na v1 (seção 3.7). Uma requisição = uma resposta completa.
- IDs de tool call ausentes (alguns servidores locais) → gerar `call_<n>`.
- Modelos com "reasoning" (DeepSeek-R1, Qwen3 thinking) podem devolver `<think>…</think>`
  no `content` → stripar antes de usar o texto como comentário.
- Recomendação de **implementação com `fetch` nativo** (Node 24), sem o pacote `openai`:
  o subconjunto usado (chat completions + models) é pequeno e estável; o SDK `openai`
  traz tipagem gigante, retries próprios (que atrapalham nosso backoff), e `Responses API`
  que não existe nos locais. ~200 linhas cobrem tudo, e testamos com um `fetch` mockado.

### 2.3 Adaptador Anthropic

- **Usar o SDK oficial `@anthropic-ai/sdk`** (dependência nova, opcional em runtime:
  import dinâmico só quando um provedor `kind: "anthropic"` está configurado). Motivos:
  tipos oficiais (`Anthropic.Tool`, `MessageParam`, `ToolUseBlock`), classes de erro
  tipadas (`RateLimitError`, `AuthenticationError`), retries/timeouts corretos, e o formato
  de `thinking`/`output_config` muda com frequência — seguir o SDK evita drift.
- Mapeamento: `system` → parâmetro `system` (com `cache_control: { type: "ephemeral" }` —
  o system prompt + `tools` são estáveis durante a partida → cache barato);
  `tool` results → mensagem `user` com `tool_result[]` (todos os resultados de uma rodada
  numa única mensagem); `toolChoice: "auto"` sempre (nunca `any`/`tool`, incompatível com
  Fable 5.1); `thinking: { type: "adaptive" }` + `output_config: { effort: "low" }` por
  padrão (configurável por preset) para latência baixa em lances triviais.
- `max_tokens` 4096 (comentários são curtos). Sem streaming na v1.
- Alternativa se quiser zero dependência: também dá para fazer com `fetch`
  (`POST /v1/messages`, headers `x-api-key`, `anthropic-version`), mas o SDK é a
  recomendação — decisão a validar (seção 10, decisão 3).

### 2.4 Modelos sem tool calling confiável: modo "texto estruturado"

Modelos locais pequenos (≤ 8B) frequentemente: ignoram `tools`, chamam tool com nome
errado, devolvem JSON quebrado ou "narram" a chamada em texto. Para eles, o bot usa
`toolMode: "text"`:

1. **Sem `tools` na requisição.** O system prompt descreve o formato de resposta:
   ```
   Responda SOMENTE neste formato, uma informação por linha:
   MOVE: <lance em SAN exatamente como aparece em "Lances legais">
   COMMENT: <1 a 3 frases em português explicando a ideia, como professor>
   ARROWS: <opcional, ex.: e2-e4, g1-f3>
   ```
   (Alternativa JSON `{"move": "...", "comment": "..."}` como fallback aceito pelo parser;
   a versão em linhas é mais robusta em modelos fracos e não sofre com aspas.)
2. A mensagem de usuário é o `formatStateForLLM(state, color)` (já tem FEN, ASCII, peças,
   histórico e a lista de lances legais) + "É sua vez. Escolha um lance da lista."
3. **Parser tolerante** (`textmode.ts`), nesta ordem:
   - strip `<think>…</think>`, cercas de código, markdown `**`;
   - regex `^\s*MOVE\s*[:=]\s*([^\n|]+)` (case-insensitive) — também aceita `Lance:`,
     `Move:`, `Jogada:`;
   - senão, tenta JSON com chave `move`;
   - senão, varre o texto por **tokens que batem com algum SAN/UCI legal** (normalizando
     `0-0`, `+`, `#`, minúsculas via `parseMove`); se houver exatamente um candidato, usa-o;
     se mais de um, prefere o que aparece em negrito ou o primeiro;
   - `COMMENT:` → texto do comentário (default: o resto do texto sem a linha MOVE, truncado
     a 600 chars); `ARROWS:` → `highlight` opcional.
4. Se nada legal foi extraído ou `make_move` recusou: **retry** (até `maxRetriesPerMove`,
   default 3) reenviando a resposta do modelo + o erro didático de `make_move` (que já
   inclui a lista de lances legais) + "Responda apenas com MOVE: <um destes>". No último
   retry, `temperature: 0`.
5. **Fallback final** (configurável `onMoveFailure`): `"random_legal"` (default em bot vs
   bot: joga um lance legal aleatório e publica comentário de sistema "⚠ o modelo não
   conseguiu escolher um lance; joguei X automaticamente"), ou `"pause"` (default em humano
   vs bot: assento fica em `status: "error"`, UI oferece "tentar de novo"/"trocar modelo").

O mesmo parser é usado como **rede de segurança no modo nativo**: se um modelo com
`tools` responder só texto contendo um lance, o bot aproveita em vez de gastar outra rodada.

## 3. Loop do bot

### 3.1 Esqueleto (`BotPlayer.run()`)

```
start():
  sessionId = "bot:" + color + ":" + uuid;  store.sessionOpened(sessionId)
  store.seat(color, { kind: "bot", name, sessionId, bot: { providerId, model, status: "idle" } })
  loop enquanto !cancelled:
    ev = await store.waitForTurn(color, 30_000, { sessionId, signal })   // interno, sem cap de 120 s: só repete
    switch ev.event:
      not_seated            → sair do loop (alguém tirou o bot; manager finaliza)
      new_game              → reset da conversa (history = []), continua (cor pode ter mudado: reler seatForSession)
      game_over             → 1 rodada "comente o resultado" (só `comment`), depois idle até new_game/stop
      timeout               → continue
      message (não é vez)   → rodada de RESPOSTA: prompt "o aluno perguntou X; responda com comment" (só tools comment/highlight)
      opponent_moved / your_turn / takeback (é vez) → rodada de LANCE
    (mensagens vêm junto no evento; o texto de estado já as inclui — a tool as marca entregues)
```

Uma **rodada** (`playTurn`) é o mini-loop agentic:

```
messages = [system] + históricoRecente + [user: formatTurnEvent(ev, state, color)]
for i in 1..maxIterationsPerTurn (default 6):
  status = "thinking"; res = await provider.chat({ model, messages, tools, signal, ... })
  contabiliza usage; status = "acting"
  if res.toolCalls vazio:
      if modo texto ou parser acha lance no res.text → executa make_move
      elif é minha vez e ainda não movi → messages += [user: "Você precisa jogar: chame make_move com um lance legal"]; continue
      else break            # ex.: rodada de resposta a mensagem, terminou com texto → publica como comment
  for call in res.toolCalls:
      result = dispatch(call)   # → toolMakeMove/toolComment/... com ToolContext{store, session}
      messages += [assistant(call), tool(result.content[0].text, isError)]
      if call.name == "make_move" && !result.isError → moved = true
  if moved && !res.toolCalls.some(c => c.name != "make_move") → break   # já jogou; não força mais rodadas
  if moved && i >= 2 → break                                            # deixou comentar 1x após o lance
if !moved && é minha vez → fallback onMoveFailure (seção 2.4)
status = "waiting"
```

Regras:
- O bot **não** usa a tool `wait_for_turn`: recebe o evento direto de `store.waitForTurn`
  (mesma fila/prioridade/validação de eventos obsoletos que o MCP). Vantagens: sem limite
  de 120 s, sem progress notifications, `serverInfo().mcpSessions[].waiting` continua
  refletindo "aguardando" para a UI sem código extra.
- **Uma rodada por vez por bot** (mutex): eventos que chegam durante a rodada ficam na
  fila e são drenados no próximo `waitForTurn` (a fila descarta `opponent_moved` obsoleto).
- Texto solto do assistant (fora de tool call) numa rodada de lance vira `comment` de
  categoria `plan` **só se** nenhuma tool `comment`/`make_move.comment` foi usada na
  rodada e o texto tiver > 20 chars (evita duplicar).
- `make_move` sem `comment` em modelos capazes: o prompt pede para sempre incluir
  `comment` (aula). Não forçamos com uma 2ª rodada (custo).

### 3.2 Prompt de sistema (`prompt.ts`)

Reaproveita o conteúdo do prompt MCP `chess_teacher` (`server/src/mcp/prompts.ts`) com
adaptações: (a) não menciona `wait_for_turn`/`new_game`; (b) inclui o **papel**
(`teacher` = explica, joga no nível do aluno, faz perguntas; `opponent` = joga o melhor
que sabe, comenta curto; `silent` = só lances, útil para bot vs bot rápido); (c) **nível**
(`beginner|intermediate|advanced`) e **idioma**; (d) regra de ouro repetida: "Escolha
sempre um lance da lista 'Lances legais' da última mensagem; nunca confie na memória";
(e) limite de tamanho dos comentários (≤ 120 palavras) para controlar custo; (f) no modo
bot vs bot: "Você joga contra outra IA chamada X; comentários são para o espectador humano".
Prompt é **estável durante a partida** (sem timestamps) para aproveitar cache de prefixo
(Anthropic explícito; OpenRouter/OpenAI automático).

### 3.3 Como o estado entra na conversa

- A mensagem `user` de cada rodada é `formatTurnEvent(ev, state, color)` — o mesmo texto
  que uma sessão MCP recebe de `wait_for_turn` (prefixo "O oponente jogou 12. Bxf7+ …" +
  estado completo com lances legais). Nada novo a escrever.
- Resultados de tools são o `content[0].text` de `CallToolResult` (já didático).
- **Janela de histórico**: como cada mensagem de estado é autossuficiente, o histórico
  enviado ao provedor é **curto por design**: system + últimas `historyTurns` rodadas
  (default 4 rodadas ≈ 8–12 mensagens) + rodada atual. Isso mantém o custo por lance
  ~constante (≈ 2–4k tokens de entrada) mesmo em partidas longas, e dá ao modelo memória
  dos próprios comentários recentes (continuidade da aula). `historyTurns: 0` = stateless.

### 3.4 Lance ilegal

`toolMakeMove` já devolve `isError: true` com o motivo + lista de lances legais (capturas e
xeques marcados). O bot devolve isso como `tool` result com `isError` e continua o
mini-loop; conta como iteração. Após `maxIllegalPerTurn` (default 3) → fallback
`onMoveFailure`. Métrica `illegalMoves` no status do assento (UI e log) — indicador de
qualidade do modelo.

### 3.5 Timeouts, cancelamento, erros

- `AbortController` por rodada; `timeoutMs` do provedor cancela a requisição HTTP;
  timeout total da rodada `turnTimeoutMs` (default 120 s cloud / 300 s local). Estourou →
  `onMoveFailure`.
- **Cancelamento**: `BotManager` observa o store: `new_game` via REST que não mantém o
  bot, `unseat`, `join_game force` de uma sessão MCP no assento do bot, ou `POST
  /api/bots/:color/stop` → `player.stop()` aborta a rodada em curso (signal), cancela o
  waiter e marca `sessionClosed`. Rodada abortada **não** executa tool calls tardios
  (checa `signal.aborted` antes de cada dispatch).
- `new_game` via REST **mantendo** o bot (seat `kind: "bot"` na nova partida) → o mesmo
  `BotPlayer` recebe o evento `new_game`, zera histórico e orçamento.
- Erros de provedor: `401/403` → status `error` "chave inválida", para; `402` (OpenRouter
  sem crédito) → para; `404` modelo → para; `429`/`5xx`/rede → **backoff exponencial com
  jitter** (1 s, 2 s, 4 s… máx 30 s, respeita `retry-after`), até `maxRetriesPerCall`
  (default 4), depois `onMoveFailure`. Todos os erros viram `Commentary` de sistema
  (categoria `warning`) no feed com texto curto, sem vazar corpo/cabeçalhos.
- Shutdown do servidor: `BotManager.stopAll()` no `shutdown()` de `index.ts`.
- Reinício do servidor com `current-game.json` contendo assento `bot`: `restoreSeat`
  recria o bot **se** o provedor ainda existe na config e `BOT_AUTORESUME=true`; senão o
  assento vira `empty` mantendo o nome (mesmo comportamento do `mcp`). Default: recriar
  (é a expectativa de quem deixou um bot vs bot rodando).

### 3.6 Custo e orçamento (`budget.ts`)

Por partida e por bot: `calls`, `inputTokens`, `outputTokens`, `cachedInputTokens`,
`estimatedCostUsd` (OpenRouter devolve `usage` com custo quando `usage: { include: true }`
no body; Anthropic calcula pela tabela de preços do preset; locais = 0). Limites
configuráveis no perfil do bot: `maxTokensPerGame` (default 400k), `maxCallsPerTurn`,
`maxUsdPerGame` (default 1.00 em provedores pagos). Ao exceder → bot para com status
`budget_exceeded`, comentário de sistema, e a UI oferece "aumentar limite e continuar".

### 3.7 Streaming

**Não na v1.** O comentário só é exibido quando a tool `comment`/`make_move` é executada;
streaming de texto parcial exigiria um canal WS extra e complica o parser de tool calls
(delta acumulado) em provedores locais heterogêneos. A UI mostra "pensando…" com o tempo
decorrido. Candidato à fase 5 (streaming apenas do texto do assistant, exibido como
"digitando…" no feed).

### 3.8 Mensagens do humano

Já funcionam: `POST /api/message` gera evento `message` para assentos que não são humanos
(hoje só `mcp` — passa a incluir `bot`). O bot recebe o evento em `waitForTurn`, faz uma
rodada de resposta com tools `comment`/`highlight` apenas e prompt curto ("O aluno
perguntou: …. Responda com a tool comment, em até 120 palavras, e desenhe se ajudar").
Se a pergunta chega **junto** com `opponent_moved`, o texto do estado já inclui as
mensagens pendentes e o prompt pede "responda à pergunta no comment do seu lance ou com
comment separado". Oferta de empate do humano chega como mensagem (`store.offerDraw`) → o
bot pode chamar `end_game(how: "draw")`.

## 4. Configuração e UI

### 4.1 Arquivos

- **`providers.json`** (raiz, **commitado com presets sem chaves**; o usuário edita ou a
  UI grava): lista de provedores e perfis de bot. Chaves de API **nunca** ficam aqui: cada
  provedor aponta para um nome de variável (`apiKeyEnv`).
- **`.env`** (gitignored): `OPENROUTER_API_KEY=…`, `ANTHROPIC_API_KEY=…`,
  `LITELLM_API_KEY=…`. Docker: passam pelo `docker-compose.yml` como hoje `MCP_TOKEN`.
- Variáveis novas em `config.ts`: `PROVIDERS_FILE` (default `./providers.json`),
  `BOT_AUTORESUME` (default `true`), `BOT_DEFAULT_PROFILE` (id do perfil sugerido na UI) e
  — acrescentada na Fase C — `BOT_FAKE_PROVIDER` (`1` injeta o provedor determinístico
  `fake`/`fake-1` no registry, para `npm run smoke:bot` rodar sem rede e sem custo).
- Presets embutidos (`registry.ts`, usados quando `providers.json` não existe e para o
  botão "adicionar preset" na UI):

| Preset id | baseUrl | apiKeyEnv | toolMode | Modelos sugeridos (confirmar em `/models` na implementação) |
|-----------|---------|-----------|----------|--------------------------|
| `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | native | `anthropic/claude-sonnet-4.6`, `openai/gpt-5-mini`, `google/gemini-2.5-flash`, `deepseek/deepseek-chat-v3-0324`, `meta-llama/llama-3.3-70b-instruct` (filtrar `supported_parameters=tools`) |
| `anthropic` | (SDK) | `ANTHROPIC_API_KEY` | native | `claude-opus-5` (padrão), `claude-sonnet-5`, `claude-haiku-4-5` |
| `ollama` | `http://localhost:11434/v1` | — | auto | o que `/api/tags` listar; sugerir `qwen3:8b`, `llama3.1:8b` (tools OK) |
| `lmstudio` | `http://localhost:1234/v1` | — | auto | o que `/v1/models` listar |
| `llamacpp` | `http://localhost:8080/v1` | — | auto | — |
| `vllm` | `http://localhost:8000/v1` | — | native | — |
| `jan` | `http://localhost:1337/v1` | — | auto | — |
| `litellm` | `http://localhost:4000/v1` | `LITELLM_API_KEY` | native | — |
| `custom` | (usuário) | (usuário) | auto | — |

### 4.2 Perfil de bot (`BotProfile`)

Separa "provedor" (onde) de "perfil" (como): `{ id, name, providerId, model, role,
level, temperature, toolMode?, historyTurns, limits }`. A UI escolhe um perfil por
assento; perfis rápidos podem ser criados inline no diálogo ("provedor + modelo").

### 4.3 UI

> **Corrigido na Fase G (2026-09-22).** Esta seção foi escrita antes do
> [plano 10](10-plano-redesign-ux.md), que reconstruiu a interface. Três componentes
> citados aqui **não existem mais**: `Seats` virou `SeatPlate`, `StatusBar` foi dissolvido
> (vez/xeque na placa, fim de partida no `GameBanner`, anúncios em `LiveRegions`) e
> `LessonFeed` virou `Notebook` + `Annotation`. E **o editor de perfis não saiu**: a tela
> "Provedores" **lista** perfis em leitura; criar ou mudar um perfil é editar o
> `providers.json`, ou escolher `providerId` + `model` direto no diálogo de nova partida
> (ver a correção em §5.3). A lista abaixo fica como registro do que foi pedido; o
> parágrafo "Onde isso foi parar" diz onde cada item aterrissou.

- **Diálogo "Nova partida"** (`NewGameDialog.tsx`): em vez dos 4 modos fixos, cada assento
  (Brancas / Pretas) tem um seletor `Humano | Aguardar MCP | Bot` e, se Bot, um segundo
  seletor de perfil (provedor + modelo, com custo estimado/1k lances quando conhecido) e
  nome. Os 4 modos atuais viram atalhos no topo ("Eu de brancas vs bot", "Bot vs bot",
  "Eu vs IA via MCP", "Dois humanos") que só preenchem os seletores. Aviso inline quando o
  provedor é pago: "Este provedor cobra por uso (OpenRouter). Limite: US$ 1,00 por partida."
- **Tela "Provedores"** (`ProvidersDialog.tsx`, botão no header): lista de provedores com
  estado (● ok / ○ sem chave / ✗ erro), botão **Testar conexão** (`POST
  /api/providers/:id/test` → latência e nº de modelos), **Listar modelos** (`GET
  /api/providers/:id/models`, com busca), editar `baseUrl`/`apiKeyEnv`/flags, "Adicionar
  preset". Chave de API: campo mostra apenas `sk-or-…a1b2` (mascarado pelo servidor) e
  "definida via .env"; **a UI não envia nem recebe a chave** (seção 6). Perfis de bot:
  lista + editor simples (papel, nível, temperatura, limites).
- **`Seats.tsx`**: `kind === "bot"` → ícone ⚙️ (ou 🤖 com sub-rótulo), "bot ·
  openrouter/anthropic/claude-sonnet-4.6", status vindo de `seat.bot.status`
  (`idle | waiting | thinking | acting | error | budget_exceeded | stopped`), tokens/custo
  acumulados discretos ("12k tok · $0.03"), botões "Parar" / "Retomar" / "Trocar modelo".
- **`StatusBar.tsx`**: "Claude (bot) está pensando… 8 s"; erro em vermelho com o texto
  curto.
- **`MessageBox.tsx`**: destinos incluem assentos `bot` (hoje só `mcp`).
- **`LessonFeed.tsx`**: avatar para `bot`; comentários de sistema de erro/orçamento com
  ícone ⚠️.
- **`ConnectHelp.tsx`**: seção "ou deixe o servidor jogar: configure um provedor".

**Onde isso foi parar (implementado na Fase E, sobre o visual do plano 10):**

| Pedido acima | Onde ficou |
|---|---|
| Diálogo "Nova partida" com seletor por assento | `NewGameDialog.tsx` + `BotPicker.tsx`, com os 4 atalhos no topo e o aviso de custo (US$ 1,00 / 400k tokens por partida) |
| Tela "Provedores" | `ProvidersDialog.tsx`, aberta pelo botão **Provedores** no header (só aparece quando o servidor expõe a camada, i.e. `server.providers !== undefined`) e por um link no `ConnectHelp` |
| Editor de perfis de bot | **não existe.** A tela lista perfis em leitura e diz isso na própria tela |
| `Seats.tsx` com estado/tokens/custo e botões | `SeatPlate.tsx`: provedor/modelo, status do loop, tokens e custo estimado, e o menu "⋯" com **Parar / Retomar · Trocar de modelo · Liberar assento** (`popover` nativo) |
| "Trocar modelo" | `ChangeBotDialog.tsx` → `POST /api/bots/:color/resume` com `{ profileId }` ou `{ providerId, model }` |
| `StatusBar.tsx` "está pensando… 8 s" | `SeatPlate` (contador a partir de `bot.thinkingSince`); o erro curto aparece na placa **e** num toast persistente com ação "Retomar" |
| `MessageBox.tsx` com destino `bot` | feito: `isAiSeat()` trata `mcp` e `bot` igual |
| `LessonFeed.tsx` com avatar de bot e ⚠️ de sistema | `Notebook`/`Annotation`: comentários de sistema de erro e de orçamento entram com a categoria `warning` |
| `ConnectHelp.tsx` "ou deixe o servidor jogar" | feito: botão que abre a tela "Provedores" |

Capturas: [`ui-bot.png`](img/ui-bot.png) (humano vs bot em andamento),
[`ui-bot-nova-partida.png`](img/ui-bot-nova-partida.png),
[`ui-bot-provedores.png`](img/ui-bot-provedores.png),
[`ui-bot-menu.png`](img/ui-bot-menu.png),
[`ui-bot-trocar-modelo.png`](img/ui-bot-trocar-modelo.png) e
[`ui-bot-erro.png`](img/ui-bot-erro.png) (toast persistente com "Retomar").

## 5. API e tipos

### 5.1 `shared/types.ts` (compatível: só adições/opcionais)

```ts
export type SeatKind = "human" | "mcp" | "bot" | "empty";          // + "bot"

export type BotStatus = "idle" | "waiting" | "thinking" | "acting" | "error" | "budget_exceeded" | "stopped";

export interface BotSeatInfo {
  providerId: string;        // "openrouter"
  model: string;             // "anthropic/claude-sonnet-4.6"
  profileId?: string;
  toolMode: "native" | "text";
  status: BotStatus;
  statusText?: string;       // "chave inválida", "429: aguardando 4 s"...
  thinkingSince?: string;    // ISO, para a UI contar o tempo
  usage: { calls: number; inputTokens: number; outputTokens: number; estimatedCostUsd?: number; illegalMoves: number };
}

export interface Seat {
  kind: SeatKind;
  name: string;
  sessionId?: string;        // bot também tem (sessão sintética)
  connectedAt?: string;
  lastSeenAt?: string;
  bot?: BotSeatInfo;         // só para kind === "bot"
}

// MoveRecord.by: SeatKind já cobre "bot" automaticamente.
// Commentary.author permanece Color | "system".

/* ---------- REST ---------- */
export type SeatRequest =
  | { kind: "human"; name?: string }
  | { kind: "mcp" }                              // = empty, aguardando join_game
  | { kind: "bot"; profileId?: string; providerId?: string; model?: string; name?: string; role?: BotRole; level?: StudentLevel };

export interface NewGameRequest {
  humanSeats?: HumanSeating;                     // legado, continua aceito
  humanName?: string;
  startFen?: string;
  seats?: { white: SeatRequest; black: SeatRequest };   // novo; tem precedência sobre humanSeats
}

export type BotRole = "teacher" | "opponent" | "silent";
export type StudentLevel = "beginner" | "intermediate" | "advanced";

export interface ProviderPublic {              // NUNCA contém a chave
  id: string; name: string; kind: "openai" | "anthropic"; baseUrl?: string;
  apiKeyEnv?: string; hasApiKey: boolean; apiKeyMasked?: string;   // "sk-or-…a1b2"
  toolMode: "native" | "text" | "auto"; local: boolean; paid: boolean;
  lastTest?: { ok: boolean; at: string; latencyMs?: number; error?: string; models?: number };
}
export interface BotProfile { id: string; name: string; providerId: string; model: string; role: BotRole; level: StudentLevel; temperature?: number; toolMode?: "native" | "text"; historyTurns?: number; limits?: { maxTokensPerGame?: number; maxUsdPerGame?: number; maxIterationsPerTurn?: number } }

/* ---------- WS ---------- */
export type WsServerMessage =
  | { type: "hello"; state: GameState; server: ServerInfo }
  | { type: "state"; state: GameState }
  | { type: "server"; server: ServerInfo }
  | { type: "bot"; color: Color; bot: BotSeatInfo };      // novo: status/tokens sem reenviar o estado inteiro

export interface ServerInfo { version; mcpUrl; mcpSessions: [...]; providers?: ProviderPublic[]; bots?: Record<Color, BotSeatInfo | null> }
```

Notas: `ServerInfo.mcpSessions` **não** lista sessões de bot (evita a UI mostrar "sem
conexão"); `seat.bot.status` substitui a heurística `lastSeenAt`. O zod
`seatSchema`/`moveRecordSchema` em `tools.ts` precisa incluir `"bot"` (e `bot` opcional)
para o `outputSchema` do MCP não rejeitar estados com bot — **sessões MCP externas passam
a ver `kind: "bot"` no oponente**; o `formatStateForLLM` rotula como "LLM (bot)".

### 5.2 `GameStore`

Mudanças pequenas e localizadas:
- Introduzir `isAgentSeat(seat) = kind === "mcp" || kind === "bot"` e usar nos 6 pontos
  que hoje testam `kind === "mcp"` (`seatForSession`, `isSessionGone`, `unseat`,
  `takeback`, `addHumanMessage`, `endGame`, `offerDraw`, `newGame` evento `new_game`,
  `restoreSeat`). `joinGame` com `force` sobre um assento `bot` → o manager para o bot.
- `SeatInit` ganha `bot?: BotSeatInfo`; `makeSeat` copia; novo `updateBot(color, patch)`
  que muda `seat.bot` sem `touch()` completo (emite `bot` em vez de `change`, para não
  rebroadcastar o estado inteiro a cada "pensando").
- `newGame` via REST: se um assento novo é `bot`, o **`BotManager`** (não o store) cria o
  `BotPlayer`; o store só recebe `SeatInit { kind: "bot", name, sessionId, bot }`. Se o bot
  antigo tem o mesmo perfil, é reaproveitado (recebe `new_game`), senão parado e recriado.

### 5.3 Rotas REST novas (`api.ts`)

| Método | Rota | Body / resposta |
|--------|------|-----------------|
| GET | `/api/providers` | `{ providers: ProviderPublic[], profiles: BotProfile[], presets: string[] }` |
| PUT | `/api/providers/:id` | `Partial<ProviderConfig>` **sem** `apiKey` (só `apiKeyEnv`) → grava `providers.json` |
| POST | `/api/providers/preset` | `{ preset: "ollama" }` → adiciona |
| DELETE | `/api/providers/:id` | remove (recusa se um bot ativo usa) |
| POST | `/api/providers/:id/test` | `{ ok, latencyMs, models }` ou `{ ok: false, error }` (erro sem corpo bruto) |
| GET | `/api/providers/:id/models` | `ModelInfo[]` (cache 5 min; `?refresh=1`) |
| POST | `/api/game` | aceita `seats` (5.1); cria bots via manager; resposta `GameState` |
| POST | `/api/bots/:color/stop` | para o bot (assento fica `bot` com `status: "stopped"`) |
| POST | `/api/bots/:color/resume` | retoma (zera erro; opcional `{ profileId }` para trocar modelo) |
| POST | `/api/bots/:color/sit` | senta um bot num assento `empty` da partida atual (equivalente a `join_game`) |
| POST | `/api/bots/:color/leave` | libera o assento (`empty`, mantém nome) |

Erros: `409` se o assento está ocupado por humano/MCP ativo, `400` provedor sem chave
(`"Provedor openrouter sem OPENROUTER_API_KEY no .env"`), `502` erro do provedor no teste.

> **Corrigido na Fase G (2026-09-22): não existe CRUD de perfis de bot.** A linha
> `PUT/POST/DELETE /api/profiles[/:id]` estava nesta tabela e **nunca foi implementada** —
> nem na Fase C, nem depois. Hoje há dois caminhos para escolher o modelo de um bot:
>
> 1. **`providerId` + `model` direto**, em `POST /api/game` (dentro de `seats`) ou em
>    `POST /api/bots/:color/{sit,resume}`. É o que a UI faz pelo `BotPicker`;
> 2. **editar `providers.json` à mão**, que é onde os perfis (com papel, nível, temperatura
>    e limites) vivem. O servidor relê o arquivo ao subir.
>
> A UI **lista** perfis em leitura (`GET /api/providers` devolve `profiles`) e diz na tela
> que a edição é no arquivo. O `scripts/bot-smoke.ts` grava um `providers.json` temporário
> justamente porque não há rota para criar um perfil com limites apertados.
>
> Duas rotas administrativas que a tabela também não previa e **existem**:
> `POST /api/providers/preset` (adiciona um preset embutido) e o par
> `PUT`/`DELETE /api/providers/:id`, todas protegidas por `canAdmin()`: só de `localhost`
> ou, se `MCP_TOKEN` estiver definido, com `Authorization: Bearer <token>`.
>
> Se o CRUD de perfis voltar à mesa, ele entra no [roadmap](06-roadmap.md) — não aqui.

### 5.4 WebSocket

- `{ type: "bot", color, bot }` a cada mudança de `seat.bot` (throttle 250 ms para
  tokens; imediato para mudança de `status`).
- `{ type: "server", server }` inclui `providers` (públicos) para a UI não precisar de
  fetch inicial.

*(Corrigido na Fase G: **não há throttle de 250 ms**. `ws.ts` emite `{ type: "bot" }`
imediatamente a cada `store.updateBot()`, e é o `BotPlayer` que evita o barulho: o
`setStatus()` só chama `updateBot` quando status, texto ou uso realmente mudaram. Como o
uso só é contabilizado uma vez por chamada ao provedor — não há streaming na v1 —, a
frequência já é de poucas mensagens por lance. O `{ type: "server" }` esse sim continua com
throttle de 500 ms, como antes do plano 09, e passou a incluir `providers`, `profiles` e
`bots`.)*

## 6. Segurança e privacidade

- **Chaves só no servidor**, lidas de variáveis de ambiente (`.env`, gitignored, ou
  ambiente do Docker). `providers.json` guarda só o nome da variável. A API nunca devolve
  a chave: `hasApiKey` + `apiKeyMasked` (4 últimos chars). Nenhuma rota aceita chave no
  body (impede que a UI, servida sem autenticação, vire um canal de exfiltração).
- **Logs**: `log.ts` ganha um `redact()` aplicado a toda string logada pelos módulos
  `providers`/`bot` (regex para `sk-`, `Bearer …`, `x-api-key`). Em `LOG_LEVEL=debug`,
  o corpo das requisições é logado **sem** headers. `raw` de `ChatResult` nunca persiste.
- **Persistência**: `current-game.json` guarda `seat.bot` (providerId/model/usage) mas
  nunca chaves; PGN ganha header `White/Black` = nome do bot e `WhiteType/BlackType`
  = `"program"` (padrão PGN) + `Annotator`.
  *(Corrigido na Fase G: os headers `WhiteType`/`BlackType`/`Annotator` **não foram
  implementados**. O PGN sai com `Event`, `Site`, `Date`, `Round`, `White`, `Black` e
  `Result`, e o nome do bot entra em `White`/`Black` como o de qualquer jogador. O resto
  vale: `current-game.json` guarda `seat.bot` sem nenhuma chave.)*
- **Rede**: bots só falam com `baseUrl` da config; UI não pode apontar para URL arbitrária
  sem passar pela tela de provedores (que só funciona em localhost — `PUT /api/providers`
  recusa se `req.ip` não é loopback **ou** se `MCP_TOKEN` está definido e o header não
  bate). Aviso na tela quando `HOST=0.0.0.0`.
- **Custo**: limite por partida (`maxUsdPerGame`, `maxTokensPerGame`) e por rodada;
  aviso obrigatório (checkbox "entendi que este provedor cobra") na primeira vez que um
  provedor `paid: true` é usado numa sessão de navegador (localStorage). OpenRouter:
  mostrar preço do modelo (de `/models`) e permitir `provider.max_price` no `extraBody`.
- **Privacidade**: o que sai para o provedor é só o estado da partida + mensagens do
  humano + nomes exibidos. Nome padrão do humano ("Você") não é dado pessoal; documentar
  que mensagens do chat vão para o provedor escolhido.
- **Prompt injection via mensagens do humano**: baixo risco (o humano é o dono), mas as
  tools expostas ao bot não incluem nada destrutivo além de `end_game(resign)`.

## 7. Riscos e trade-offs

| Risco | Impacto | Mitigação |
|-------|---------|-----------|
| Modelos locais pequenos jogam mal e "ensinam" errado | qualidade de aula ruim; lances ilegais frequentes | modo texto + lista de lances legais; métrica `illegalMoves` visível; presets recomendam ≥ 8B com tools; rótulo "qualidade experimental" na UI; futuro: `analyze` com Stockfish (fase 3 do roadmap) para o bot checar-se |
| Latência de modelos locais em CPU (30–120 s/lance) | experiência lenta | status "pensando… Ns" com tempo; `turnTimeoutMs` alto para locais; `historyTurns` baixo reduz prompt; sugerir modelos quantizados |
| Formatos de tool calling divergem (args string vs objeto, ids ausentes, `tool_choice` não suportado, `<think>`) | falhas silenciosas | flags por provedor + parser tolerante + validação zod; testes unitários com fixtures reais de cada provedor |
| OpenRouter roteia para provedores diferentes por chamada | comportamento variável | `provider.order`/`allow_fallbacks` no `extraBody` do preset (opcional) |
| Custo inesperado (loop de lances ilegais, comentários longos) | dinheiro | limites por rodada/partida, `maxIterationsPerTurn`, `max_tokens` 1–4k, aviso de custo |
| Reentrância: humano faz takeback enquanto o bot pensa | bot joga um lance para posição antiga | `make_move` valida contra o estado atual (ilegal → erro didático → nova rodada); rodada em curso é abortada em `takeback` (signal) e o evento `takeback` dispara nova rodada |
| Bot vs bot infinito (ex.: xeque perpétuo ou 200 lances) | custo/tempo | chess.js já declara empate por repetição/50 lances; `maxPliesPerGame` opcional (default 300 → abort com comentário) |
| `wait_for_turn` (MCP) × loop interno do bot | nenhum conflito: ambos usam `store.waitForTurn` com `sessionId` próprio | — |
| Dependência nova (`@anthropic-ai/sdk`) | tamanho/atualização | import dinâmico; provedor Anthropic é opcional |
| `seatSchema` do MCP muda (`"bot"`) | clientes MCP antigos com `outputSchema` estrito | é o nosso servidor que valida; clientes só leem. Sem quebra |
| Dois processos (dev: `tsx watch` reinicia) | bots morrem no reload | `BOT_AUTORESUME` recria do `current-game.json` |

Decisão de design importante: **o bot não é uma sessão MCP interna** (não instanciamos
`McpServer` + transporte em memória). Chamar `tools.ts` direto é mais simples, sem
serialização, sem o cap de 120 s, e as tools já são funções puras testadas. Se um dia
quisermos "bot via MCP" (ex.: usar um cliente MCP embutido como Jan), é outro adaptador.

## 8. Fases de implementação

Esforço relativo: **P** (≤ meio dia), **M** (1–2 dias), **G** (3+ dias).

### Fase A — Fundações de tipos e store (P)
- `SeatKind` + `"bot"`, `BotSeatInfo`, `SeatRequest`, `NewGameRequest.seats`, WS `bot`.
- `isAgentSeat` no store; `updateBot`; `restoreSeat` para `bot`; zod schemas em `tools.ts`.
- `formatStateForLLM` rotula `bot`; `MessageBox`/`LessonFeed`/`Seats` aceitam `bot`
  (render mínimo).
- **Aceite**: `npm test` verde; testes novos em `store.test.ts`: assento `bot` recebe
  eventos `opponent_moved`/`message`/`takeback`; `seatForSession` acha bot; `newGame` com
  `seats` REST; snapshot do formatador com bot.

### Fase B — Camada de provedores (M)
- `providers/types.ts`, `openai-compat.ts` (fetch), `registry.ts` (presets, `providers.json`,
  `.env`, máscara), `fake.ts`.
- Rotas `/api/providers*` (list/test/models/put/preset/delete) + `redact()` em `log.ts`.
- **Aceite**: testes unitários com `fetch` mockado (fixtures de resposta OpenRouter, Ollama
  e LM Studio: tool_calls com `arguments` string, sem id, com `<think>`; 429 com
  `retry-after`; 401); `registry` nunca serializa a chave; `GET /api/providers` mascara.

### Fase C — BotPlayer + BotManager, modo nativo (G)
- `bot/player.ts`, `manager.ts`, `toolset.ts` (`z.toJSONSchema(z.object(inputShapes.make_move))`
  etc.), `prompt.ts`, `budget.ts`; integração em `index.ts` (shutdown) e `api.ts`
  (`POST /api/game` com `seats`, `/api/bots/*`).
- **Aceite**: com `FakeProvider` (joga do livro, responde mensagens, um cenário devolve
  lance ilegal e depois corrige): humano vs bot joga 10 lances via REST; bot vs bot chega
  ao fim (Mate do Pastor scriptado); mensagem do humano vira `comment`; `new_game` reseta
  histórico; `stop` aborta rodada em curso sem executar tool tardio; orçamento excedido →
  `budget_exceeded`; erro 401 → `error`. Smoke `scripts/bot-smoke.ts` contra servidor real
  com `PROVIDER=fake`.

### Fase D — Modo texto estruturado (M)
- `textmode.ts` (prompt + parser), `toolMode: "auto"` com detecção na 1ª rodada, retries
  com temperatura 0, `onMoveFailure`.
- **Aceite**: testes de parser com ~30 fixtures (`MOVE: Nf3`, `**Lance:** e4!`, JSON,
  `<think>`, texto com 2 lances, lance ilegal, UCI, `0-0`); loop com `FakeProvider` em
  modo texto completa uma partida.

### Fase E — UI (M)
- `NewGameDialog` com seletor por assento + atalhos; `ProvidersDialog`; `Seats`/`StatusBar`
  com status/tokens/custo e botões; aviso de custo; fixture `?mock=1` com bot.
- **Aceite**: `npm run build`; Playwright: criar partida humano vs bot (fake), ver
  "pensando…" → lance + comentário no feed; tela de provedores testa conexão e lista
  modelos (contra `fake`); screenshot `docs/img/ui-bot.png`.
- **Como saiu:** a Fase E foi para depois da Fase 2 do plano 10, para nascer no visual
  novo — `SeatPlate` e `ChangeBotDialog` no lugar de `Seats`/`StatusBar` (ver §4.3), e os
  fixtures viraram dois cenários próprios, `?mock=bots` e `?mock=botsvsbots`. A partida
  humano vs bot foi criada pela UI contra o servidor real com `BOT_FAKE_PROVIDER=1`.
  **O contador "pensando há N s" só é observável com um provedor de latência real** — o
  `fake` responde em ~1 ms, então a captura dele veio de fixture. As capturas de IA vs IA
  também vieram de `?mock=botsvsbots`: a sessão real com dois bots `fake` funciona, mas
  acaba em ~6 s (32 lances, empate por repetição).

### Fase F — Anthropic + smoke real (P–M)
- `providers/anthropic.ts` com `@anthropic-ai/sdk` (dependência nova; import dinâmico),
  cache_control no system, adaptive thinking + effort low.
- Smoke opcional condicionado ao ambiente: `npm run smoke:bot -- --provider lmstudio` só
  roda se `GET http://localhost:1234/v1/models` responder (senão "SKIP"). Mesmo para
  `ollama` (`:11434`) e `openrouter` (se `OPENROUTER_API_KEY` definido; limitado a 4
  lances e `maxUsdPerGame: 0.05`). **Nesta máquina hoje: nenhum local disponível** (seção
  0) — o usuário precisa subir o LM Studio com um modelo (ex.: `lms server start` após
  baixar um modelo com tools) ou instalar o Ollama.
- **Aceite**: adaptador Anthropic com SDK mockado (tool_use → tool_result numa única
  mensagem user); smoke real "SKIP" ou "OK".

> **O que de fato foi verificado na Fase F (2026-09-22).** O adaptador Anthropic foi
> validado contra o **SDK mockado** (17 testes) e contra um **mock local da Messages API**,
> conferindo no fio: `cache_control` no `system`, `thinking: adaptive`, `effort: low`,
> `tool_choice: "auto"`, ausência de `temperature` e `tool_result` + estado numa única
> mensagem `user`. **Nada foi executado contra `api.anthropic.com`**, nem contra OpenRouter,
> LM Studio, Ollama ou qualquer outro provedor real: não há `.env` com chave nesta máquina
> e nenhum servidor local no ar, então as 4 variantes do smoke real dão **SKIP** (exit 0),
> que é o resultado correto. Um teste com chave real continua pendente.
>
> Duas descobertas que teriam quebrado em produção e entraram no adaptador:
> `temperature` devolve **400** nos modelos 4.7+/5 (o `BotPlayer` manda `temperature: 0` na
> última iteração da rodada), e `thinking`/`output_config` precisam ser filtrados por
> modelo. O `estimatedCostUsd` da Messages API é **estimado** por uma tabela local de
> preços — a API não devolve custo —, então envelhece se os preços mudarem. E o
> `cache_control` pode simplesmente não cachear: o prefixo mínimo cacheável é de 512–4096
> tokens conforme o modelo e o prompt de sistema tem ~800 — sem erro, só sem cache.
> Confira em `cachedInputTokens` depois de alguns lances.

### Fase G — Polimento (P)
- Docs: atualizar `02`, `03`, `04`, `05` (seção "ou use um bot"), `08` (variáveis no
  compose), README. `providers.json` de exemplo commitado; `.env.example` com as chaves
  vazias. Roadmap: streaming de texto, `analyze` para o bot, torneio bot vs bot.
- **Feito em 2026-09-22.** Além da lista acima: `01-arquitetura` e `00-visao` ganharam o
  terceiro tipo de assento, e as divergências entre este plano e o código foram corrigidas
  no próprio texto (marcadas com "Corrigido na Fase G"): §1.3 (pastas), §2.2 (`extraBody`
  do OpenRouter), §4.1 (`BOT_FAKE_PROVIDER`), §4.3 (componentes de UI e ausência do editor
  de perfis), §5.3 (**não existe CRUD de perfis**), §5.4 (sem throttle no evento `bot`) e
  §6 (sem os headers `WhiteType`/`BlackType`/`Annotator` no PGN).

Ordem: A → B → C → D → E → F → G. B e A são independentes (paralelizáveis); D depende de C;
E pode começar após A com fixtures. Total estimado: ~2 semanas de trabalho de um agente
por fase, com A+B em paralelo.

## 9. Diagrama e exemplo de configuração

### 9.1 Fluxo (humano de brancas vs bot do OpenRouter de pretas)

```
 Navegador                    Servidor (Node)                                   Provedor
 ─────────                    ───────────────                                   ────────
 POST /api/game ───────────►  api.ts: seats.black = {kind:"bot", profile}
   {seats:{white:human,        │
    black:bot}}                ▼
                              BotManager.start("black", profile)
                               │  sessionOpened("bot:black:…")
                               │  store.seat("black", {kind:"bot", sessionId, bot:{status:"waiting"}})
                               ▼
                              BotPlayer.run()  ── store.waitForTurn("black") ──┐ (bloqueia; fila por assento)
                                                                               │
 arrasta e4 ─── POST /api/move ─► store.applyMove("white","e4")                │
                                   ├─ emit("change") ──► WS {state} ──► UI     │
                                   └─ pushEvent("black","opponent_moved") ─────┘ acorda
                               ▼
                              playTurn(ev):
                               messages = [system(prompt.ts), …histórico curto…,
                                           user: formatTurnEvent(ev, state, "black")]
                               updateBot(status:"thinking") ──► WS {bot}
                               provider.chat({model, messages, tools:[make_move, comment, …]}) ──► POST /chat/completions
                                                                                                 ◄── tool_calls:[make_move{move:"e5",
                                                                                                        comment:"Disputo o centro…"}]
                               dispatch → toolMakeMove({store, session:{id}}, args)
                                   └─ store.applyMove("black","e5") ─► emit("change") ─► WS ─► UI anima e5 + comentário
                               tool result (texto do estado) → messages; (opcional 2ª rodada: comment/highlight)
                               budget += usage; updateBot(status:"waiting", usage) ──► WS {bot}
                               ▼
                              store.waitForTurn("black") …  (repete até game_over / stop / new_game)

 [mensagem do humano] POST /api/message ─► pushEvent("black","message") ─► rodada de resposta (só comment/highlight)
 [Parar] POST /api/bots/black/stop ─► BotPlayer.stop(): abort signal, cancelWaiters, status:"stopped"
```

### 9.2 `providers.json` (exemplo commitável — sem chaves)

```jsonc
{
  "version": 1,
  "providers": [
    {
      "id": "openrouter",
      "name": "OpenRouter",
      "kind": "openai",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "paid": true,
      "toolMode": "native",
      "modelsQuery": "supported_parameters=tools",
      "extraHeaders": { "HTTP-Referer": "http://localhost:3939", "X-Title": "LLM Xadrez" },
      "extraBody": { "usage": { "include": true }, "reasoning": { "effort": "low" } },
      "timeoutMs": 60000
    },
    {
      "id": "anthropic",
      "name": "Anthropic (API direta)",
      "kind": "anthropic",
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "paid": true,
      "toolMode": "native",
      "extraBody": { "thinking": { "type": "adaptive" }, "output_config": { "effort": "low" } }
    },
    {
      "id": "lmstudio",
      "name": "LM Studio (local)",
      "kind": "openai",
      "baseUrl": "http://localhost:1234/v1",
      "local": true,
      "toolMode": "auto",
      "timeoutMs": 180000
    },
    {
      "id": "ollama",
      "name": "Ollama (local)",
      "kind": "openai",
      "baseUrl": "http://localhost:11434/v1",
      "local": true,
      "toolMode": "auto",
      "toolChoice": false,
      "timeoutMs": 180000
    },
    {
      "id": "homelab-litellm",
      "name": "LiteLLM (homelab)",
      "kind": "openai",
      "baseUrl": "http://192.168.1.50:4000/v1",
      "apiKeyEnv": "LITELLM_API_KEY",
      "toolMode": "native"
    }
  ],
  "profiles": [
    {
      "id": "professora-sonnet",
      "name": "Professora (Claude Sonnet via OpenRouter)",
      "providerId": "openrouter",
      "model": "anthropic/claude-sonnet-4.6",
      "role": "teacher",
      "level": "beginner",
      "temperature": 0.7,
      "historyTurns": 4,
      "limits": { "maxUsdPerGame": 1.0, "maxTokensPerGame": 400000, "maxIterationsPerTurn": 6 }
    },
    {
      "id": "opus-direto",
      "name": "Professor (Claude Opus 5, API Anthropic)",
      "providerId": "anthropic",
      "model": "claude-opus-5",
      "role": "teacher",
      "level": "intermediate",
      "limits": { "maxUsdPerGame": 2.0 }
    },
    {
      "id": "local-qwen",
      "name": "Adversário local (Qwen3 8B)",
      "providerId": "lmstudio",
      "model": "qwen3-8b",
      "role": "opponent",
      "level": "beginner",
      "toolMode": "text",
      "temperature": 0.3,
      "historyTurns": 2,
      "limits": { "maxIterationsPerTurn": 4 }
    }
  ],
  "defaults": { "profileId": "professora-sonnet", "onMoveFailure": { "vsHuman": "pause", "vsBot": "random_legal" } }
}
```

`.env.example` ganha:
```
# Provedores de LLM para bots (opcional). Chaves NUNCA vão no providers.json.
OPENROUTER_API_KEY=
ANTHROPIC_API_KEY=
LITELLM_API_KEY=
PROVIDERS_FILE=./providers.json
BOT_AUTORESUME=true
```

## 10. Decisões a validar com o usuário

1. **Novo `SeatKind = "bot"`** (em vez de reaproveitar `"mcp"` com sessão sintética). Mais
   claro na UI e no PGN; custo: tocar ~10 pontos que testam `kind === "mcp"` (via
   `isAgentSeat`) e o `seatSchema` do MCP.
2. **Bot chama `tools.ts` diretamente** com `ToolContext` e sessão sintética, sem passar
   por um transporte MCP em memória; espera via `store.waitForTurn` (sem tool
   `wait_for_turn`, sem cap de 120 s).
3. **Bibliotecas**: `fetch` nativo para o adaptador OpenAI-compatível (cobre OpenRouter,
   LiteLLM, Ollama, LM Studio, llama.cpp, vLLM, Jan, custom) e **`@anthropic-ai/sdk`**
   (dependência nova, import dinâmico) para a Anthropic. Alternativa: tudo com `fetch`
   (zero deps) ou tudo com SDKs (`openai` + `@anthropic-ai/sdk`).
4. **Sem streaming na v1** e **histórico curto** (`historyTurns` = 4) por padrão, contando
   com o estado autossuficiente de cada mensagem para manter custo constante por lance.
5. **Política de falha**: humano vs bot → `pause` (assento em erro, botão "tentar de
   novo"); bot vs bot → `random_legal` com comentário de sistema; limites default
   `maxUsdPerGame` = 1.00 e `maxTokensPerGame` = 400k; `takeback` não exposto ao bot.

Também a confirmar: (a) o `providers.json` fica commitado com presets (sem chaves) e a UI
pode gravá-lo; (b) `BOT_AUTORESUME=true` recria bots ao reiniciar o servidor; (c) modelos
sugeridos nos presets (slugs do OpenRouter devem ser conferidos em `/models` na
implementação).

---

## 11. Status das decisões (aprovadas em 2026-09-22)

Todas as decisões da seção 10 foram **aprovadas como escritas**, sem alterações:

1. ✅ `SeatKind = "bot"` novo (não reaproveitar `"mcp"`).
2. ✅ Bot chama `tools.ts` diretamente com `ToolContext` + sessão sintética; espera via
   `store.waitForTurn`.
3. ✅ `fetch` nativo para o adaptador OpenAI-compatível + `@anthropic-ai/sdk` (import
   dinâmico) para a Anthropic.
4. ✅ Sem streaming na v1; `historyTurns` = 4 por padrão.
5. ✅ Falha: `pause` em humano vs bot, `random_legal` em bot vs bot; `maxUsdPerGame` = 1.00,
   `maxTokensPerGame` = 400k; `takeback` não exposto ao bot.

Itens (a), (b) e (c) também confirmados: `providers.json` commitado com presets sem chaves
e gravável pela UI; `BOT_AUTORESUME=true`; slugs dos presets a conferir em `/models` durante
a implementação.

Execução acompanhada em [`11-execucao.md`](11-execucao.md).
