# 08 — Rodando com Docker

Arquivos: `Dockerfile` (multi-stage: builda o frontend, roda o servidor com `tsx`),
`docker-compose.yml`, `.dockerignore`.

## Subir
```bash
docker compose up -d --build
```
- UI: http://localhost:3939
- MCP: http://localhost:3939/mcp (mesma configuração de clientes de docs/05 — para o
  Claude Desktop/Claude Code no host, `localhost:3939` funciona normalmente).
- Estado e partidas ficam em `./data` (volume). Sobrevivem a `docker compose down`.

## Comandos úteis
```bash
docker compose logs -f xadrez     # ver o banner com as URLs e os comandos de conexão
docker compose restart xadrez
docker compose down               # para; mantém ./data
docker compose up -d --build      # rebuild após mudar o código
```

## Configuração
Variáveis vêm do `docker-compose.yml`; `HUMAN_NAME` e `MCP_TOKEN` podem ser definidos num
`.env` na raiz (o Compose lê automaticamente). Dentro do container o servidor escuta em
`0.0.0.0` (obrigatório para o port mapping), o que desliga a proteção DNS-rebinding do
Express do SDK; como a porta só é publicada em `localhost` por padrão, isso não muda o
risco. Para expor na rede/túnel, defina `MCP_TOKEN`.

Para mudar a porta no host: `"4000:3939"` em `ports` e `PUBLIC_URL=http://localhost:4000`
no `.env` (a URL do MCP passa a ser `http://localhost:4000/mcp`, e o servidor anuncia a
URL certa no banner, no `/api/health` e na UI).

## Desenvolvimento com Docker
O container é de produção (serve `web/dist`). Para desenvolver com hot reload, use
`npm run dev` no host. Se quiser desenvolver dentro do container:
```bash
docker compose run --rm --service-ports -v .:/app xadrez npm run dev:server
```

## Healthcheck
`GET /api/health` a cada 30 s. `docker compose ps` mostra `healthy` quando o servidor
respondeu.
