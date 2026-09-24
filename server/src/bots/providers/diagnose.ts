/**
 * Diagnóstico de falhas de conexão com um provedor: erro de `fetch`/SDK/HTTP → mensagem
 * curta em pt-BR + uma dica acionável (`hint`). Ciente do Docker: dentro do container,
 * `localhost` é o próprio container, não o computador onde o Ollama/LM Studio roda.
 *
 * Usado pelo teste de conexão (`POST /api/providers/:id/test`) e pela listagem de
 * modelos (`GET /api/providers/:id/models`). Nunca inclui chave nem corpo bruto.
 */
import { isLoopbackHost, isPrivateHost, urlHost } from "./net.js";
import { ProviderError, type ProviderConfig } from "./types.js";

export interface Diagnosis {
  error: string;
  hint?: string;
}

export interface DiagnoseOptions {
  /** O servidor roda dentro de um container (config.inDocker). */
  inDocker?: boolean;
  /** Timeout usado na chamada, para a mensagem de timeout. */
  timeoutMs?: number;
}

const CERT_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_UNTRUSTED",
]);

const TIMEOUT_CODES = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
const RESET_CODES = new Set(["ECONNRESET", "UND_ERR_SOCKET", "EPIPE", "ERR_SSL_WRONG_VERSION_NUMBER", "EPROTO"]);
const UNREACHABLE_CODES = new Set(["EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL"]);

/** Percorre a cadeia de `cause` procurando um `code` de sistema (ECONNREFUSED...). */
export function errorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
    // AggregateError (várias tentativas IPv4/IPv6): olha o primeiro.
    const errors = (current as { errors?: unknown }).errors;
    if (Array.isArray(errors) && errors.length) {
      const inner = errorCode(errors[0]);
      if (inner) return inner;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Algum erro da cadeia é abort/timeout? */
function isAbort(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
    const name = (current as { name?: unknown }).name;
    if (name === "AbortError" || name === "TimeoutError" || name === "APIConnectionTimeoutError") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function httpStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

function baseMessage(err: unknown): string {
  if (err instanceof ProviderError) return err.shortText;
  return err instanceof Error ? err.message : String(err);
}

function dockerLocalhostHint(cfg: Pick<ProviderConfig, "baseUrl">): string {
  let suggestion = "http://host.docker.internal:11434/v1";
  try {
    const url = new URL(cfg.baseUrl ?? "");
    url.hostname = "host.docker.internal";
    suggestion = url.toString().replace(/\/+$/, "");
  } catch {
    /* usa o exemplo do Ollama */
  }
  return `Dentro do Docker, localhost é o próprio container: use ${suggestion} (e deixe o servidor do modelo escutando em 0.0.0.0).`;
}

const LISTEN_ALL_HINT =
  "O servidor do modelo precisa escutar em 0.0.0.0, não só em 127.0.0.1 (Ollama: OLLAMA_HOST=0.0.0.0; LM Studio: ative \"Serve on Local Network\"; llama.cpp: --host 0.0.0.0). Confira também o firewall.";

/**
 * Traduz o erro de uma chamada ao provedor (teste de conexão ou listagem de modelos).
 * `cfg` é a config do provedor (para saber host, kind e apiKeyEnv).
 */
export function diagnoseProviderError(
  err: unknown,
  cfg: Pick<ProviderConfig, "id" | "kind" | "baseUrl" | "apiKeyEnv">,
  opts: DiagnoseOptions = {},
): Diagnosis {
  const inDocker = !!opts.inDocker;
  const host = urlHost(cfg.baseUrl) ?? (cfg.kind === "anthropic" ? "api.anthropic.com" : "");
  const where = host ? ` em ${host}` : "";
  const loopback = !!host && isLoopbackHost(host);
  const dockerHost = host === "host.docker.internal";
  const lan = !!host && !loopback && isPrivateHost(host);
  const status = httpStatus(err);

  if (cfg.kind === "openai" && !cfg.baseUrl) {
    return { error: `Provedor "${cfg.id}" sem baseUrl configurada.`, hint: "Informe a URL do servidor, ex.: http://host.docker.internal:11434/v1 (Docker) ou http://localhost:11434/v1." };
  }

  if (status !== undefined) {
    const error = baseMessage(err);
    if (status === 401 || status === 403) {
      return {
        error,
        hint: cfg.apiKeyEnv
          ? `Confira o valor de ${cfg.apiKeyEnv} no .env e reinicie o servidor${inDocker ? " (docker compose up -d recria o container com o novo .env)" : ""}.`
          : "O servidor exige chave: defina uma variável no .env (ex.: MEU_SERVIDOR_API_KEY=...) e informe o nome dela em apiKeyEnv.",
      };
    }
    if (status === 404) {
      return {
        error,
        hint: "Confira a baseUrl: servidores OpenAI-compatíveis costumam terminar em /v1 (ex.: http://host:11434/v1), sem /chat/completions no fim.",
      };
    }
    if (status === 402) return { error, hint: "Adicione créditos na conta do provedor." };
    if (status === 429) return { error, hint: "Limite de requisições: espere um pouco e tente de novo." };
    if (status >= 500) return { error, hint: "O servidor do modelo respondeu com erro interno: veja o log dele (modelo carregado? memória suficiente?)." };
    return { error };
  }

  const code = errorCode(err);

  // Dentro do Docker, qualquer falha de rede com localhost tem a mesma causa.
  if (inDocker && loopback && (code || isAbort(err))) {
    return { error: `Nada respondeu${where} (${code ?? "timeout"}).`, hint: dockerLocalhostHint(cfg) };
  }

  if (code === "ECONNREFUSED") {
    const error = `Conexão recusada${where}: nada escutando nessa porta.`;
    if (dockerHost || lan) return { error, hint: LISTEN_ALL_HINT };
    if (loopback) {
      return { error, hint: "Confira se o servidor do modelo está rodando e a porta da baseUrl (Ollama: 11434; LM Studio: 1234 com \"Start Server\"; llama.cpp: 8080)." };
    }
    return { error, hint: "Confira o endereço e a porta da baseUrl." };
  }

  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    const error = code === "EAI_AGAIN" ? `Falha temporária de DNS ao resolver ${host || "o host"}.` : `Host não encontrado: ${host || "(vazio)"}.`;
    if (dockerHost && inDocker) {
      return { error, hint: "No Linux, adicione extra_hosts: [\"host.docker.internal:host-gateway\"] ao serviço no docker-compose.yml e recrie o container." };
    }
    if (dockerHost) return { error, hint: "host.docker.internal só existe dentro do Docker: fora dele, use localhost." };
    if (code === "EAI_AGAIN") return { error, hint: "Verifique a conexão com a internet/DNS do servidor e tente de novo." };
    return { error, hint: "Confira o nome do host na baseUrl (erro de digitação? máquina desligada?)." };
  }

  if ((code && TIMEOUT_CODES.has(code)) || isAbort(err)) {
    const secs = opts.timeoutMs ? ` em ${Math.round(opts.timeoutMs / 1000)} s` : "";
    const error = `Sem resposta${where}${secs} (timeout).`;
    if (dockerHost || lan) return { error, hint: `Firewall bloqueando a porta ou servidor escutando só em 127.0.0.1. ${LISTEN_ALL_HINT}` };
    return { error, hint: "O servidor pode estar ocupado carregando o modelo; tente de novo em alguns segundos." };
  }

  if (code && UNREACHABLE_CODES.has(code)) {
    return { error: `Host inacessível${where} (${code}).`, hint: "Confira se a máquina está ligada e na mesma rede (VPN/Tailscale ativos?)." };
  }

  if (code && CERT_CODES.has(code)) {
    return {
      error: `Certificado TLS não confiável${where} (${code}).`,
      hint: "Certificado autoassinado ou expirado: na rede local use http://, ou confie na CA com NODE_EXTRA_CA_CERTS=/caminho/ca.pem no ambiente do servidor.",
    };
  }

  if (code && RESET_CODES.has(code)) {
    return {
      error: `A conexão foi encerrada pelo servidor${where} (${code}).`,
      hint: "Confira se a baseUrl usa o protocolo certo (http:// vs https://) e a porta do servidor do modelo.",
    };
  }

  const error = baseMessage(err);
  return code ? { error: error.includes(code) ? error : `${error} (${code})` } : { error };
}
