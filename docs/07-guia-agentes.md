# 07 — Guia para os agentes de implementação

Leia, nesta ordem: `00-visao`, `01-arquitetura`, `02-contrato-mcp`, e o doc da sua área
(`03-servidor` ou `04-frontend`). Se o trabalho toca bots ou provedores, leia também o
plano [`09`](09-plano-provedores-gateway.md); se toca a interface, o [`10`](10-plano-redesign-ux.md)
e o [`12`](12-teclado.md). Os dois planos já foram implementados e as divergências entre o
texto e o código estão marcadas neles com "Corrigido na Fase G" — leia essas notas antes de
tomar o plano ao pé da letra. O contrato de tipos está em `shared/types.ts` — **não
altere os tipos** sem atualizar os docs e avisar no relatório final; se precisar de um campo
novo, adicione-o como opcional.

## Regras de código
- TypeScript estrito, ESM (`"type": "module"`), imports com extensão `.js` no servidor
  (`import { x } from "./store.js"`) por causa do `tsx`/Node ESM. No `web/` o Vite resolve
  sem extensão.
- Importar o contrato como `import type { GameState } from "../../shared/types.js"`
  (servidor) e `import type { GameState } from "@shared/types"` (web, alias no Vite/tsconfig).
- Sem `any` implícito. Sem dependências além das do `package.json` raiz, salvo necessidade
  real — se adicionar, registrar no relatório.
- Comentários e strings da UI/LLM em pt-BR; identificadores em inglês.
- Nada de `console.log` espalhado: servidor usa um `log.ts` mínimo com prefixo `[mcp]`,
  `[api]`, `[ws]`, `[store]`, `[bot]`, `[providers]`. Toda linha passa por `redact()`.
- Windows: caminhos com `path.join`, `fs` com `utf8`; nada de comandos shell no código.
- **Nunca** aceite, devolva, logue ou serialize uma chave de API. `providers.json` guarda
  só o nome da variável de ambiente (`apiKeyEnv`); o que sai para a UI é `ProviderPublic`
  (`hasApiKey` + `apiKeyMasked`). Ver [docs/01 → Segurança](01-arquitetura.md#segurança-escopo-local).

## Verificação obrigatória antes de reportar
- Servidor: `npm test` verde, `npx tsc -p server --noEmit` sem erros, `npm run smoke`
  (com o servidor no ar em outra janela ou spawnado pelo script) termina com `OK`.
- Web: `npm run build` sem erros; `npm run dev:web` com `?mock=1` renderiza tabuleiro,
  feed, lances e controles (tirar screenshot com Playwright se disponível).
- Relatório final: o que foi implementado, o que desviou do doc e por quê, comandos para
  validar, problemas conhecidos.

## Scripts npm (raiz)
| Script | Faz |
|--------|-----|
| `npm run dev` | servidor (tsx watch) + Vite dev em paralelo |
| `npm run dev:server` | só servidor em `:3939` (tsx watch) |
| `npm run dev:web` | só Vite em `:5173` com proxy para `:3939` |
| `npm run build` | typecheck web + `vite build` → `web/dist` |
| `npm start` | servidor em produção servindo `web/dist` |
| `npm test` | vitest (server) |
| `npm run smoke` | cliente MCP de teste ponta a ponta (2 cenários, termina com `OK`) |
| `npm run smoke:bot` | bots internos pela REST; sem flag usa o provedor `fake`. `--provider <id>` dá **SKIP** (exit 0) se o provedor não estiver disponível |
| `npm run play` | "IA de mentira": cliente MCP que joga/comenta na partida atual (ver docs/05) |
| `npm run typecheck` | `tsc --noEmit` em server e web |

## Referências rápidas
- SDK MCP instalado em `node_modules/@modelcontextprotocol/sdk` — exemplos em
  `dist/esm/examples/server/jsonResponseStreamableHttp.js` (transporte + sessões) e
  `docs/server.md` (registerTool/registerPrompt/registerResource). API do cliente:
  `dist/esm/client/streamableHttp.js` (`StreamableHTTPClientTransport`) e `client/index.js`.
- `zod`: `import * as z from "zod"` (v4). `inputSchema` é um *raw shape* (`{ move: z.string() }`),
  não `z.object(...)`.
- chess.js 1.x: `new Chess(fen?)`, `.move(san | {from,to,promotion})` lança em lance ilegal
  (usar try/catch), `.moves({ verbose: true })`, `.fen()`, `.pgn()`, `.history({verbose:true})`,
  `.undo()`, `.isCheckmate()`, `.isStalemate()`, `.isInsufficientMaterial()`,
  `.isThreefoldRepetition()`, `.isDrawByFiftyMoves()`, `.isDraw()`, `.inCheck()`, `.turn()`,
  `.board()`, `.ascii()`, `.setComment()`, `.header()`.
- react-chessboard 5.x: ler `node_modules/react-chessboard/README.md` (API mudou na v5:
  prop única `options`).
