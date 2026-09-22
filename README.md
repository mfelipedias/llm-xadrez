# ♞ LLM Xadrez

Tabuleiro de xadrez web conectado a LLMs via **MCP**. A IA move as peças de verdade, dita
cada lance e comenta como uma professora. O servidor guarda o estado e devolve a posição
completa a cada chamada, então a IA nunca "se perde" na partida. Também dá para sentar
**duas LLMs** uma contra a outra e assistir.

## Rodando

```bash
npm install
npm run dev        # servidor em http://localhost:3939 + Vite em http://localhost:5173
# ou, em produção:
npm run build && npm start   # tudo em http://localhost:3939
```

Endpoint MCP: `http://localhost:3939/mcp`. Como conectar Claude Code / Claude Desktop /
outros: [docs/05-conectar-clientes.md](docs/05-conectar-clientes.md).

No chat: *"vamos jogar xadrez, eu de brancas, me ensine enquanto jogamos"*.

## Documentação
| Doc | Conteúdo |
|-----|----------|
| [00-visao](docs/00-visao.md) | o problema, a ideia, modos de jogo, princípios |
| [01-arquitetura](docs/01-arquitetura.md) | stack, pastas, fluxo de dados, sessões/assentos |
| [02-contrato-mcp](docs/02-contrato-mcp.md) | ferramentas, prompt, recursos, formato do estado |
| [03-servidor](docs/03-servidor.md) | GameStore, REST, WebSocket, persistência, testes |
| [04-frontend](docs/04-frontend.md) | layout e componentes da UI |
| [05-conectar-clientes](docs/05-conectar-clientes.md) | Claude Code, Claude Desktop, túnel, 2 LLMs |
| [06-roadmap](docs/06-roadmap.md) | fases e divisão de trabalho |
| [07-guia-agentes](docs/07-guia-agentes.md) | regras para quem implementa |

Contrato de tipos compartilhado: [`shared/types.ts`](shared/types.ts).

## Scripts
`npm run dev` · `npm run build` · `npm start` · `npm test` · `npm run smoke` · `npm run typecheck`
