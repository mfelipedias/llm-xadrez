# 08 — Rodando com Docker

Arquivos: `Dockerfile` (multi-stage: builda o frontend, roda o servidor com `tsx`),
`docker-compose.yml`, `.dockerignore`.

## Subir
```bash
cp .env.example .env            # opcional, mas o compose lê dele (env_file)
touch providers.json            # só se o arquivo não existir — ver "Armadilha" abaixo
docker compose up -d --build
```
- UI: http://localhost:3939
- MCP: http://localhost:3939/mcp (mesma configuração de clientes de docs/05 — para o
  Claude Desktop/Claude Code no host, `localhost:3939` funciona normalmente).
- Estado e partidas ficam em `./data` (volume). Sobrevivem a `docker compose down`.

## Rede: quem alcança o container

**A porta só é publicada em `127.0.0.1` por padrão.** O mapeamento do compose é
`"${BIND_ADDR:-127.0.0.1}:3939:3939"`: só o próprio computador alcança a UI e o `/mcp`.
Para abrir para a rede local, `BIND_ADDR=0.0.0.0` no `.env` — e aí, junto:
`ALLOWED_HOSTS=<IP ou nome da máquina>` (senão o celular recebe `403 Host não
permitido`), `MCP_TOKEN` (senão qualquer um na rede conecta uma IA) e `ADMIN_TOKEN`
(ver abaixo).

Dentro do container o servidor escuta em `0.0.0.0` (obrigatório para o port mapping). A
proteção contra DNS rebinding **não** depende disso: o servidor valida o header `Host` em
todas as rotas (UI, `/api`, `/ws`, `/mcp`) e aceita só `localhost`, `127.0.0.1`, `[::1]`,
o host de `PUBLIC_URL` e os de `ALLOWED_HOSTS` (lista separada por vírgula; `.dominio` ou
`*.dominio` valem para qualquer subdomínio; `*` desliga a verificação). Acessou por outro
nome e recebeu `403 Host não permitido: "…"`? Ponha o host em `ALLOWED_HOSTS`.

**Administração** (gravar/testar provedores): o servidor aceita sempre o loopback e os
IPs/CIDRs de `ADMIN_ALLOW_FROM`, mesmo com token definido; de qualquer outro endereço,
só com `Authorization: Bearer <ADMIN_TOKEN>` (ou `MCP_TOKEN`). Com a porta presa em
`127.0.0.1`, o navegador do host chega ao container pelo gateway da ponte do Docker, que
não é loopback para o servidor — por isso o compose define
`ADMIN_ALLOW_FROM=172.16.0.0/12` por padrão. **Cuidado com `BIND_ADDR=0.0.0.0`**: quem vem
da LAN também pode chegar pela ponte e cair nessa faixa. Nesse caso defina `ADMIN_TOKEN` e
estreite `ADMIN_ALLOW_FROM` (o IP exato do gateway sai de
`docker network inspect llm-xadrez_default`). Detalhes em docs/05, "Administração".

Para mudar a porta no host: `"4000:3939"` em `ports` e `PUBLIC_URL=http://localhost:4000`
no `.env` (a URL do MCP passa a ser `http://localhost:4000/mcp`, e o servidor anuncia a
URL certa no banner, no `/api/health` e na UI).

## Permissões (`./data` e `providers.json`)
O bind mount expõe `./data` do host para `/app/data`; a permissão que importa é a do
arquivo **no host**. O `docker-compose.yml` já faz o container rodar como o usuário do
host:

```yaml
user: "${UID:-1000}:${GID:-1000}"
```

- `UID`/`GID` vêm do ambiente do host. Atenção: no bash, `UID` é variável do shell mas
  **não é exportada**, e `GID` nem existe — o Compose então cai no fallback `1000`. Se o
  seu usuário não é o 1000 (`id -u`), ponha `UID=` e `GID=` no `.env`.
- Com isso, `./data` e `./providers.json` são gravados com o dono certo, sem `EACCES`, e
  a tela "Provedores" consegue salvar.
- Docker Desktop (Windows/macOS) abstrai o dono — não costuma aparecer o problema.
- Se a pasta virar `root:root` (ex.: subiu com `sudo`), corrija:
  ```bash
  sudo chown -R $(id -u):$(id -g) data providers.json
  ```

## Configuração
O compose carrega o `.env` da raiz de dois jeitos: `${…}` no próprio arquivo (porta,
`BIND_ADDR`, `UID`, tokens) e **`env_file: .env`** (`required: false` — o arquivo é
opcional; exige Compose v2.24+), que injeta todas as variáveis no container. É isso que faz
uma chave com nome próprio (`MEU_SERVIDOR_API_KEY`, `GROQ_API_KEY`…) chegar ao servidor sem
editar o compose. Por isso as chaves **não** aparecem mais em `environment:` — uma entrada
ali com o mesmo nome sobrescreveria o valor do `.env`. Mudou o `.env`? `docker compose up -d`
recria o container (um `restart` **não** relê o `env_file`).

| Variável | Para quê |
|----------|----------|
| `BIND_ADDR` | endereço do host onde a porta é publicada. Default `127.0.0.1` |
| `PUBLIC_URL` | URL anunciada aos clientes (banner, `/api/health`, UI); o host dela também entra na lista de hosts aceitos |
| `ALLOWED_HOSTS` | hosts extras aceitos no header `Host` (túnel, nome na rede). `.dominio` = qualquer subdomínio |
| `MCP_TOKEN` | exige token em `/mcp` (header `Authorization: Bearer` ou `?token=`) |
| `ADMIN_TOKEN` | token para as rotas de administração de provedores (sem ele, `MCP_TOKEN` também serve) |
| `ADMIN_ALLOW_FROM` | IPs/CIDRs que administram sem token, além do loopback. Default no compose: `172.16.0.0/12` (a ponte do Docker) |
| `RUNTIME` | `docker` (no `ENV` do Dockerfile e no compose): a UI mostra `docker compose up -d` e `host.docker.internal`, e o teste de provedor dá dicas de rede do container |

## Bots do servidor no container

Nenhuma variável de bot é obrigatória: sem chave e sem modelo local, o container roda só
com MCP.

| Variável | Vem de | Para quê |
|----------|--------|----------|
| `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `LITELLM_API_KEY`, qualquer `*_API_KEY` | `.env` da raiz (`env_file`) | as chaves. Ficam **só no ambiente** do container; o `providers.json` guarda apenas o nome da variável |
| `PROVIDERS_FILE` | fixo: `/app/providers.json` | provedores e perfis de bot |
| `BOT_AUTORESUME` | `.env`, default `true` | recria os bots do `current-game.json` quando o container reinicia |
| `BOT_DEFAULT_PROFILE` | `.env` | perfil sugerido na UI |

`BOT_FAKE_PROVIDER` não está no compose de propósito: ele serve ao `npm run smoke:bot`, no
host, e não tem uso numa imagem de produção.

**O `providers.json` vai na imagem *e* é montado por cima.** O `Dockerfile` copia o
arquivo do repositório para `/app/providers.json` (é o default da imagem, usado se você
rodar sem o compose), e o compose faz um bind mount de `./providers.json` sobre ele. Com o
compose, vale sempre o arquivo do host:

- editar o arquivo no host e reiniciar (`docker compose restart xadrez`) é o caminho normal
  para mexer em perfis de bot;
- a tela "Provedores" grava nesse mesmo arquivo do host (com o `user:` acima, sem
  problema de permissão).

**Armadilha: `./providers.json` ausente vira uma pasta.** Se o arquivo não existir no host
quando o compose sobe, o Docker cria um **diretório** vazio com esse nome para servir de
origem do bind mount. O servidor então não consegue ler o arquivo (é uma pasta), cai nos
presets embutidos e a gravação pela tela falha. Para corrigir:
```bash
docker compose down
rmdir providers.json            # a pasta vazia criada pelo Docker
git checkout providers.json     # ou: echo '{}' > providers.json
docker compose up -d
```

**Modelo local não é `localhost` de dentro do container.** Um Ollama ou LM Studio rodando
na sua máquina está fora do container, então `http://localhost:11434/v1` aponta para o
próprio container e não responde. Use `host.docker.internal` no `baseUrl` do provedor (a
tela "Provedores" já sugere esse endereço quando o servidor roda em Docker):

```jsonc
{ "id": "ollama", "baseUrl": "http://host.docker.internal:11434/v1", "local": true, … }
```

O compose já traz `extra_hosts: ["host.docker.internal:host-gateway"]`, que é o que faz
esse nome existir no Linux (no Docker Desktop ele existe sempre). Falta só o lado do
modelo: por padrão o **Ollama escuta só em `127.0.0.1`**, que o container não alcança —
rode-o com `OLLAMA_HOST=0.0.0.0`. No LM Studio, ligue **"Serve on Local Network"**. O teste
de conexão da tela devolve essas mesmas dicas quando falha.

## Comandos úteis
```bash
docker compose logs -f xadrez     # ver o banner com as URLs e os comandos de conexão
docker compose restart xadrez     # reinicia (não relê o .env)
docker compose up -d              # recria se o .env ou o compose mudou
docker compose down               # para; mantém ./data
docker compose up -d --build      # rebuild após mudar o código
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
