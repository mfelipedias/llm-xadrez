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

## Permissões (`./data` e `providers.json`)
O bind mount expõe `./data` do host para `/app/data`; a permissão que importa é a do
arquivo **no host**. Num clone novo, o `docker-compose.yml` já garante que o container
roda como o usuário do host:

```yaml
user: "${UID:-1000}:${GID:-1000}"
```

- `UID`/`GID` vêm do ambiente do host (definidos em shells Linux/macOS). Sem eles,
  o fallback é `1000`, que é o uid do usuário `node` da imagem.
- Num Linux com UID diferente de 1000, o `./data` do host é criado/mantido com o dono
  correto e o container escreve sem `EACCES`.
- Docker Desktop (Windows/macOS) abstrai o dono — não costuma aparecer o problema.
- Se a pasta virar `root:root` (ex.: subiu com `sudo`), corrija:
  ```bash
  sudo chown -R $(id -u):$(id -g) data
  ```

O mesmo vale para `./providers.json` (a tela "Provedores" grava nele): se a UI reclamar
ao salvar, o dono do arquivo no host precisa ser o seu, ou o UID do usuário do host.

## Comandos úteis
```bash
docker compose logs -f xadrez     # ver o banner com as URLs e os comandos de conexão
docker compose restart xadrez
docker compose down               # para; mantém ./data
docker compose up -d --build      # rebuild após mudar o código
```

## Configuração
Variáveis vêm do `docker-compose.yml`; as que têm `${…}` podem ser definidas num `.env` na
raiz (o Compose lê automaticamente). Dentro do container o servidor escuta em `0.0.0.0`
(obrigatório para o port mapping), o que desliga a proteção DNS-rebinding do Express do
SDK; como a porta só é publicada em `localhost` por padrão, isso não muda o risco. Para
expor na rede/túnel, defina `MCP_TOKEN`.

Para mudar a porta no host: `"4000:3939"` em `ports` e `PUBLIC_URL=http://localhost:4000`
no `.env` (a URL do MCP passa a ser `http://localhost:4000/mcp`, e o servidor anuncia a
URL certa no banner, no `/api/health` e na UI).

## Bots do servidor no container

O compose já traz as variáveis dos [bots](09-plano-provedores-gateway.md). Nenhuma é
obrigatória: sem chave e sem modelo local, o container roda exatamente como antes, só com
MCP.

| Variável | Vem de | Para quê |
|----------|--------|----------|
| `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `LITELLM_API_KEY` | `.env` da raiz | as chaves. Ficam **só no ambiente** do container; o `providers.json` guarda apenas o nome da variável |
| `PROVIDERS_FILE` | fixo: `/app/providers.json` | provedores e perfis de bot |
| `BOT_AUTORESUME` | `.env`, default `true` | recria os bots do `current-game.json` quando o container reinicia |
| `BOT_DEFAULT_PROFILE` | `.env` | perfil sugerido na UI |

`BOT_FAKE_PROVIDER` não está no compose de propósito: ele serve ao `npm run smoke:bot`, no
host, e não tem uso numa imagem de produção.

**O `providers.json` é montado, não copiado.** O `Dockerfile` não leva o arquivo para
dentro da imagem, então o compose faz um bind mount de `./providers.json` para
`/app/providers.json`. Duas consequências:

- editar o arquivo no host e reiniciar (`docker compose restart xadrez`) é o caminho normal
  para mexer em perfis de bot;
- a tela "Provedores" tenta **gravar** nesse arquivo. Em Docker Desktop (Windows/macOS)
  isso funciona; num host Linux o container roda como `node` (uid 1000) e a gravação só
  passa se o arquivo do host pertencer a esse uid. Se a UI reclamar ao salvar, edite no
  host — o resultado é o mesmo.

Sem o mount, o servidor não acha o arquivo, cai nos **presets embutidos** em memória
(OpenRouter, Anthropic, LM Studio, Ollama, sem nenhum perfil) e diz isso no log.

**Modelo local não é `localhost` de dentro do container.** Um Ollama ou LM Studio rodando
na sua máquina está fora do container, então `http://localhost:11434/v1` aponta para o
próprio container e não responde. Use `host.docker.internal` no `baseUrl` do provedor:

```jsonc
{ "id": "ollama", "baseUrl": "http://host.docker.internal:11434/v1", "local": true, … }
```

No Linux, acrescente também ao serviço:

```yaml
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

## Desenvolvimento com Docker
O container é de produção (serve `web/dist`). Para desenvolver com hot reload, use
`npm run dev` no host. Se quiser desenvolver dentro do container:
```bash
docker compose run --rm --service-ports -v .:/app xadrez npm run dev:server
```

## Healthcheck
`GET /api/health` a cada 30 s. `docker compose ps` mostra `healthy` quando o servidor
respondeu.
