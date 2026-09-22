# 05 — Conectando clientes MCP

Servidor no ar: `npm start` (ou `npm run dev`). Endpoint MCP: `http://localhost:3939/mcp`.

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

## Solução de problemas
| Sintoma | Causa provável | Ação |
|---------|----------------|------|
| Cliente lista 0 tools | servidor não está no ar / porta diferente | `npm start`; conferir `PORT` |
| `Bad Request: No valid session ID` | cliente reusa sessão antiga após restart do servidor | reconectar o cliente (`/mcp` → reconnect) |
| Assento mostra "sem conexão" | sessão MCP caiu | a LLM chama `join_game` na mesma cor (retoma automaticamente) |
| `Host header not allowed` | acesso por IP/host diferente de localhost | `HOST=0.0.0.0` no `.env` (desliga a proteção DNS rebinding) |
