# 05 — Conectando clientes MCP

Servidor no ar: `npm start` (ou `npm run dev`). Endpoint MCP: `http://localhost:3939/mcp`.

> **Ou pule tudo isto e use um bot do servidor.** Este documento é sobre plugar um *cliente
> de chat* (Claude Code, Claude Desktop, Jan, Codex…) no tabuleiro. Se o que você quer é só
> jogar contra uma IA, o servidor sabe falar direto com um provedor de LLM e sentar sozinho
> no assento — sem cliente nenhum. Veja [**"Ou use um bot do servidor"**](#ou-use-um-bot-do-servidor),
> no fim desta página.

## Claude Code (CLI)
Neste repositório já existe `.mcp.json`, então basta abrir o `claude` dentro da pasta.
Para usar em qualquer pasta:
```bash
claude mcp add --transport http xadrez http://localhost:3939/mcp
```
Depois, no chat: `/mcp` para conferir a conexão, e "vamos jogar xadrez, eu de brancas".
Dica: usar o prompt do servidor — `/mcp` → `xadrez` → prompt `chess_teacher`.

## Claude Desktop
Opção A — conector customizado (Settings → Connectors → Add custom connector):
URL `http://localhost:3939/mcp`. Se o app recusar URL local, usar a opção B.

Opção B — ponte stdio com `mcp-remote` em `claude_desktop_config.json`
(`%APPDATA%\Claude\claude_desktop_config.json` no Windows):
```json
{
  "mcpServers": {
    "xadrez": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:3939/mcp", "--allow-http"]
    }
  }
}
```
Reiniciar o Claude Desktop. As tools aparecem no ícone de ferramentas do chat.

## Jan (jan.ai)
Jan aceita servidores MCP HTTP direto. Em `%APPDATA%\Jan\data\mcp_config.json`, dentro
de `mcpServers`:
```json
"xadrez": {
  "active": true,
  "type": "http",
  "url": "http://localhost:3939/mcp",
  "command": "", "args": [], "env": {}, "headers": {}
}
```
Ou pela UI: Settings → MCP Servers → Add → tipo HTTP, URL acima. Reinicie o Jan (ou
desligue/ligue o servidor na lista). Dica: `toolCallTimeoutSeconds` em `mcpSettings` deve
ser ≥ 120 para o `wait_for_turn` não ser abortado. Modelos locais pequenos podem ter tool
calling fraco; prefira um modelo com suporte a tools (ex.: Qwen, Llama 3.x instruct).

## OpenAI Codex (app desktop / CLI)
Em `~/.codex/config.toml`:
```toml
[mcp_servers.xadrez]
url = "http://localhost:3939/mcp"
startup_timeout_sec = 30
tool_timeout_sec = 180
```
Conferir com `codex mcp list` (deve listar `xadrez` como `enabled`). Reinicie o app Codex.

## ChatGPT (web)
O ChatGPT só aceita conectores MCP por **URL pública** e sem header customizado, então:
1. Deixe `MCP_TOKEN` vazio no `.env` enquanto joga (o servidor rejeitaria sem o header).
2. Abra um túnel: `npx cloudflared tunnel --url http://localhost:3939` e copie a URL `https://...`.
3. No ChatGPT: Settings → Apps & Connectors → Advanced settings → Developer mode → Create,
   URL `https://<túnel>/mcp`, autenticação "None".
4. Feche o túnel ao terminar (a UI e o MCP ficam expostos enquanto ele estiver aberto).

## Docker
Com `docker compose up -d --build` (ver docs/08), o endpoint é o mesmo
`http://localhost:3939/mcp` e todas as configurações acima valem sem mudança. Se mapear
outra porta no host, defina `PUBLIC_URL=http://localhost:<porta>` para o servidor anunciar
a URL certa no banner, no `/api/health` e na UI.

## Outros clientes (Cursor, Windsurf, Cline, Continue, etc.)
Qualquer cliente com suporte a "remote/HTTP MCP": URL `http://localhost:3939/mcp`.
Clientes só-stdio: mesma ponte `npx -y mcp-remote http://localhost:3939/mcp --allow-http`.

## ChatGPT / clientes que exigem URL pública
Expor com túnel e proteger com token:
```bash
# .env
MCP_TOKEN=uma-senha-longa
# terminal
npx cloudflared tunnel --url http://localhost:3939
```
Configurar o cliente com a URL pública `/mcp` e header `Authorization: Bearer <token>`.
A UI (`/`) continua sem senha — não deixe o túnel aberto além do necessário.

## Testar sem um cliente LLM: `npm run play`
`scripts/mcp-play.ts` é uma "IA de mentira": um cliente MCP real
(`StreamableHTTPClientTransport`) que senta num assento e fica no ciclo
`wait_for_turn` ↔ `make_move`, jogando lances de abertura simples (depois capturas/aleatório),
publicando um `comment` com setas e casas após cada lance e respondendo às mensagens do
humano. Serve para validar servidor + UI de ponta a ponta sem gastar tokens.

```bash
npm start                       # servidor no ar (ou npm run dev)
npm run play                    # join_game(color: "black", my_name: "Claude Teste")
# no navegador: Nova partida → "Eu de brancas vs IA" → jogue; a IA responde em ~1 s
```

Variáveis de ambiente (todas opcionais):

| Variável | Default | Descrição |
|----------|---------|-----------|
| `PLAY_URL` | `http://localhost:3939` | base do servidor |
| `PLAY_NAME` | `Claude Teste` | nome exibido na UI |
| `PLAY_COLOR` | `black` | `white` \| `black` \| `random` |
| `PLAY_MODE` | `join` | `join` = `join_game` na partida atual; `new` = `new_game` (cria outra) |
| `PLAY_OPPONENT` | `human` | só com `PLAY_MODE=new`: `human` ou `llm` |
| `PLAY_FORCE` | `0` | `1` = `join_game(force: true)` |
| `PLAY_MAX_MOVES` | ∞ | sai (`leave_game`) depois de N lances próprios |
| `PLAY_DELAY_MS` | `800` | pausa antes de cada lance (para ver a animação) |
| `PLAY_WAIT_SECONDS` | `60` | `timeout_seconds` do `wait_for_turn` (1–120) |

LLM vs LLM sem nenhum cliente: na UI, "Nova partida → IA vs IA (assistir)" e, em dois
terminais, `PLAY_COLOR=white PLAY_NAME="LLM Alpha" npm run play` e
`PLAY_COLOR=black PLAY_NAME="LLM Beta" npm run play`. O script termina sozinho em
`game_over` (ou em `PLAY_MAX_MOVES`); Ctrl+C também libera o assento.
Já `npm run smoke` (`scripts/mcp-smoke.ts`) é o teste automatizado: roda dois cenários
completos (humano vs LLM até o mate, LLM vs LLM) contra o servidor no ar ou um spawnado
em `:3940`, e termina com `OK`.

## Duas LLMs na mesma partida
1. Chat A (ex.: Claude Desktop): "crie uma partida de xadrez de brancas contra outra IA e
   comente cada lance". → `new_game({ my_color: "white", opponent: "llm", my_name: "Claude Desktop" })`.
2. Chat B (ex.: Claude Code): "entre na partida de xadrez que está esperando, você é as
   pretas". → `join_game({ color: "black", my_name: "Claude Code" })`.
3. Ambos ficam em `wait_for_turn` ↔ `make_move`. Você assiste em `http://localhost:3939` e
   pode mandar perguntas para cada uma pelo campo de mensagem.

Observação: cada `wait_for_turn` dura até 60 s por padrão. Se uma LLM demorar mais para
responder, a outra recebe `timeout` e chama de novo — sem perder o lance.

## Timeouts dos clientes
Alguns clientes MCP abortam chamadas de tool longas (Claude Desktop ≈ 60 s em algumas
versões). Por isso o default de `wait_for_turn` é 60 s e o máximo 120 s. Se um cliente
abortar sistematicamente, reduza `timeout_seconds` para 30.

## Ou use um bot do servidor

Um **bot** é o próprio servidor ocupando um assento e conversando com um provedor de LLM —
OpenRouter, a API da Anthropic, ou um modelo local no seu computador (Ollama, LM Studio,
llama.cpp, vLLM, Jan) — pela API compatível com OpenAI. Nenhum cliente de chat envolvido:
você abre o navegador, escolhe o modelo e joga. O plano completo está em
[docs/09](09-plano-provedores-gateway.md); o mapa das peças, em
[docs/03 → "Bots do servidor"](03-servidor.md#bots-do-servidor-serversrcbots).

### 1. Aponte o provedor

`providers.json`, na raiz do repositório, já vem com presets para OpenRouter, Anthropic,
LM Studio e Ollama, e com três perfis de exemplo. Cada provedor aponta para o **nome** de
uma variável de ambiente (`apiKeyEnv`) — a chave em si **nunca** entra nesse arquivo.

```bash
# .env (gitignored)
OPENROUTER_API_KEY=sk-or-v1-…
# ou, para a API da Anthropic direto:
ANTHROPIC_API_KEY=sk-ant-…
```

Modelo local não precisa de chave nenhuma: basta o servidor do modelo estar no ar
(`ollama serve` em `:11434`, LM Studio em `:1234`, llama.cpp em `:8080`, vLLM em `:8000`,
Jan em `:1337`). Modelos pequenos costumam ter tool calling fraco — para eles, use
`"toolMode": "text"` no perfil: o bot pede o lance em texto (`MOVE: Nf3`) e entende a
resposta com um parser tolerante.

### 2. Confira na tela "Provedores"

Botão **Provedores** no header (ele só aparece quando o servidor tem a camada ligada).
Lá dá para **testar a conexão** (latência e nº de modelos), **listar os modelos** e ajustar
`baseUrl`/`apiKeyEnv`. A chave aparece só mascarada (`sk-or-…a1b2`) e é somente leitura: o
que você edita é o nome da variável. As rotas que gravam só aceitam requisição de
`localhost` — ou, se `MCP_TOKEN` estiver definido, o Bearer correspondente.

### 3. Jogue

**Nova partida** → escolha, para cada assento, `Humano`, `Aguardar MCP` ou `Bot do
servidor`; com bot, escolha um perfil pronto ou "provedor + modelo". Se o provedor for
pago, o diálogo diz o limite que a partida vai respeitar (por padrão **US$ 1,00 ou 400 mil
tokens**, ajustáveis por perfil): estourou, o bot para sozinho e você decide se continua.

Na placa do assento, o menu **"⋯"** traz **Parar / Retomar**, **Trocar de modelo** e
**Liberar assento**. Se o bot travar — chave inválida, crédito acabado, modelo devolvendo
lance ilegal atrás de lance ilegal — um aviso fica na tela até você fechar, com o botão
**Retomar**. Contra um humano, um bot que não consegue jogar **pausa**; contra outro bot,
ele joga um lance legal ao acaso e explica no feed, para a partida não travar.

Bot e sessão MCP convivem na mesma partida: dá para sentar o Claude Code de brancas e um
`qwen3:8b` local de pretas, e assistir. Um bot aparece para o outro lado como "LLM (bot do
servidor)".

### Testar sem gastar nada: `npm run smoke:bot`

```bash
npm run smoke:bot                              # provedor "fake": determinístico, sem rede
npm run smoke:bot -- --provider lmstudio       # local, só roda se :1234 responder
npm run smoke:bot -- --provider ollama --model qwen3:8b
npm run smoke:bot -- --provider openrouter     # só roda com OPENROUTER_API_KEY
npm run smoke:bot -- --provider anthropic      # só roda com ANTHROPIC_API_KEY
```

Sem `--provider`, o script sobe um servidor próprio com `BOT_FAKE_PROVIDER=1` — um provedor
determinístico em memória que joga de um livro de aberturas — e roda quatro cenários pela
API REST: humano vs bot (4 lances, conferindo `usage`), mensagem do aluno virando
comentário, parar/retomar, e bot vs bot.

Com um provedor **real** há um teste de ambiente antes de tudo: local precisa responder em
`GET <baseUrl>/models`; pago precisa da chave no ambiente e do modelo na lista. Faltou
alguma coisa, o script imprime **SKIP** e sai com 0 — ele nunca falha por causa de
ambiente. E aí ele sobe o servidor com um `providers.json` temporário cujo perfil limita a
partida a **US$ 0,05, 120 mil tokens e 4 lances**, e roda só os dois primeiros cenários.
Termina com `OK`, `SKIP` (exit 0) ou `FALHOU` (exit 1).

> **Nota de honestidade:** nesta máquina o smoke com provedor real **sempre deu SKIP** —
> não há `.env` com chave nem nenhum servidor de modelo local no ar. Os adaptadores foram
> validados contra `fetch` mockado, SDK mockado e um mock local da Messages API. Um teste
> contra `api.anthropic.com`, OpenRouter ou um modelo local de verdade continua pendente.

## Solução de problemas
| Sintoma | Causa provável | Ação |
|---------|----------------|------|
| Cliente lista 0 tools | servidor não está no ar / porta diferente | `npm start`; conferir `PORT` |
| `Bad Request: No valid session ID` | cliente reusa sessão antiga após restart do servidor | reconectar o cliente (`/mcp` → reconnect) |
| Assento mostra "sem conexão" | sessão MCP caiu | a LLM chama `join_game` na mesma cor (retoma automaticamente) |
| `Host header not allowed` | acesso por IP/host diferente de localhost | `HOST=0.0.0.0` no `.env` (desliga a proteção DNS rebinding) |
| Não existe o botão "Provedores" | o servidor subiu sem a camada de provedores | conferir `PROVIDERS_FILE` e o log de inicialização |
| `Provedor X sem OPENROUTER_API_KEY no .env` | a variável apontada por `apiKeyEnv` está vazia | definir no `.env` e **reiniciar** o servidor (as chaves são lidas do ambiente) |
| Bot parado com "limite de gasto atingido" | orçamento da partida estourou | "Retomar" no menu "⋯" zera o contador; para mudar o teto, edite `limits` do perfil no `providers.json` |
| Bot local devolve lance ilegal sem parar | modelo pequeno com tool calling fraco | `"toolMode": "text"` no perfil, ou um modelo maior |
| Bots sumiram depois de reiniciar o servidor | `BOT_AUTORESUME=false`, ou o provedor ficou sem chave | religar a variável; conferir o aviso no log |
