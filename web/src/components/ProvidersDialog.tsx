/**
 * Tela "Provedores" (docs/09 §4.3): lista os provedores configurados, testa a
 * conexão, lista os modelos, cria provedores novos e edita os existentes.
 *
 * Invariante (docs/09 §6, decisão aprovada): **a chave de API nunca passa por
 * aqui.** O campo de chave é somente leitura e mostra o que o servidor devolve
 * (`hasApiKey` + `apiKeyMasked`); o que se edita é o *nome da variável de
 * ambiente*. O servidor recusa qualquer corpo com `apiKey`.
 *
 * Administração: as rotas que gravam, testam e listam modelos só aceitam o
 * próprio computador do servidor (ou redes confiáveis, como a ponte do Docker)
 * — ou um `Authorization: Bearer <ADMIN_TOKEN|MCP_TOKEN>`. Quando o servidor
 * recusa (403 `admin_forbidden`), a tela pede o token e repete a ação; sem token
 * aceito, explica o que configurar no `.env`.
 *
 * Perfis de bot são listados em leitura: o servidor ainda não expõe CRUD de
 * perfis (`/api/profiles`), então a edição continua em `providers.json`.
 */
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import type {
  BotProfile,
  ModelInfo,
  ProviderKind,
  ProviderPublic,
  ProviderTestResponse,
  ProviderUpsert,
  ServerInfo,
  ToolMode,
} from "@shared/types";
import { api, ApiError, getAdminToken, isMock, setAdminToken } from "../api";
import { providerTone } from "../bots";
import { Modal } from "./Modal";

interface ProvidersDialogProps {
  onClose: () => void;
  /** Usado para `runtime` (endereços de modelo local dentro do Docker). */
  server?: ServerInfo | null;
}

interface ModelsState {
  loading: boolean;
  list: ModelInfo[];
  error?: string;
  /** Dica do servidor quando a listagem falha (502). */
  hint?: string;
  query: string;
}

/** Pedido de token pendente: a ação recusada fica guardada para repetir. */
interface AdminPrompt {
  accepted: boolean;
  retry: (() => Promise<void>) | null;
  /** O token digitado foi recusado. */
  rejected?: boolean;
}

const TOOL_MODES: { value: ToolMode; label: string }[] = [
  { value: "auto", label: "auto (detecta)" },
  { value: "native", label: "nativo (tool calling)" },
  { value: "text", label: "texto estruturado (modelos pequenos)" },
];

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
/** Mesma regra do servidor: nome de variável com cara de chave, nunca um segredo do próprio servidor. */
const ENV_RE = /^[A-Z_][A-Z0-9_]*$/;
const ENV_SUFFIX_RE = /(_API_KEY|_KEY|_TOKEN)$/;
const RESERVED_ENV = new Set(["MCP_TOKEN", "ADMIN_TOKEN"]);

function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|-+$/g, "")
    .slice(0, 40);
}

function describeTest(id: string, result: ProviderTestResponse): string {
  if (!result.ok) return `${id}: o teste falhou — ${result.error}`;
  const parts = [`${id}: conexão ok`, `${result.latencyMs} ms`];
  if (result.models !== undefined) parts.push(`${result.models} modelo${result.models === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

export function ProvidersDialog({ onClose, server }: ProvidersDialogProps) {
  const docker = server?.runtime === "docker";
  const [providers, setProviders] = useState<ProviderPublic[]>([]);
  const [profiles, setProfiles] = useState<BotProfile[]>([]);
  const [presets, setPresets] = useState<string[]>([]);
  const [envKeys, setEnvKeys] = useState<string[]>([]);
  const [canAdmin, setCanAdmin] = useState<boolean>(true);
  const [adminTokenAccepted, setAdminTokenAccepted] = useState<boolean>(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [models, setModels] = useState<Record<string, ModelsState>>({});
  const [tests, setTests] = useState<Record<string, ProviderTestResponse>>({});
  const [preset, setPreset] = useState("");
  const [admin, setAdmin] = useState<AdminPrompt | null>(null);
  const [hasToken, setHasToken] = useState<boolean>(() => getAdminToken() !== null);
  const headingId = useId();
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const focusAfterReload = useRef<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.providers.list();
      setProviders(data.providers);
      setProfiles(data.profiles);
      setPresets(data.presets);
      setEnvKeys(data.envKeys ?? []);
      setCanAdmin(data.canAdmin !== false);
      setAdminTokenAccepted(data.adminTokenAccepted === true);
      if (data.canAdmin === false) {
        /* Com um token guardado e ainda sem permissão, o token foi recusado. */
        const rejected = getAdminToken() !== null;
        if (rejected) {
          setAdminToken(null);
          setHasToken(false);
        }
        setAdmin(
          (current) => current ?? { accepted: data.adminTokenAccepted === true, retry: null, rejected },
        );
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível ler os provedores.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /* Depois de criar um provedor, o foco vai para o título do cartão novo. */
  useEffect(() => {
    const id = focusAfterReload.current;
    if (!id || loading) return;
    const el = document.getElementById(`${headingId}-prov-${id}`);
    if (el) {
      focusAfterReload.current = null;
      el.focus();
    }
  }, [providers, loading, headingId]);

  /**
   * Roda uma ação de administração. Recusa 403 `admin_forbidden` abre o painel do
   * token (ou a explicação), guardando a ação para repetir depois do token.
   */
  const runAdmin = async (key: string, action: () => Promise<void>, fallback: string): Promise<boolean> => {
    setBusyId(key);
    setError(null);
    try {
      await action();
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.adminForbidden) {
        const hadToken = getAdminToken() !== null;
        if (hadToken) {
          setAdminToken(null);
          setHasToken(false);
        }
        setCanAdmin(false);
        if (err.adminTokenAccepted !== undefined) setAdminTokenAccepted(err.adminTokenAccepted);
        setAdmin({ accepted: err.adminTokenAccepted === true, retry: action, rejected: hadToken });
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : fallback);
      }
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const test = async (id: string) => {
    setNotice(null);
    await runAdmin(
      id,
      async () => {
        const result = await api.providers.test(id);
        setTests((current) => ({ ...current, [id]: result }));
        if (result.ok) setNotice(describeTest(id, result));
        else setError(describeTest(id, result));
        await reload();
      },
      "Falha ao testar o provedor.",
    );
  };

  const listModels = async (id: string, refresh = false) => {
    setModels((current) => ({
      ...current,
      [id]: { loading: true, list: current[id]?.list ?? [], query: current[id]?.query ?? "" },
    }));
    try {
      const list = await api.providers.models(id, refresh);
      setModels((current) => ({ ...current, [id]: { loading: false, list, query: current[id]?.query ?? "" } }));
    } catch (err) {
      if (err instanceof ApiError && err.adminForbidden) {
        setModels((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
        setCanAdmin(false);
        setAdmin({ accepted: err.adminTokenAccepted === true, retry: () => listModels(id, refresh) });
        setError(err.message);
        return;
      }
      setModels((current) => ({
        ...current,
        [id]: {
          loading: false,
          list: [],
          query: current[id]?.query ?? "",
          error: err instanceof Error ? err.message : "Falha ao listar modelos.",
          ...(err instanceof ApiError && err.hint ? { hint: err.hint } : {}),
        },
      }));
    }
  };

  /** Grava e testa em seguida: é o teste que diz se a URL/chave servem. */
  const save = async (id: string, patch: ProviderUpsert, created: boolean): Promise<boolean> => {
    setNotice(null);
    const ok = await runAdmin(
      id,
      async () => {
        await api.providers.save(id, patch);
        setEditing(null);
        setCreating(false);
        focusAfterReload.current = id;
        setNotice(`${id}: ${created ? "provedor criado" : "configuração salva"}. Testando a conexão…`);
        const result = await api.providers.test(id);
        setTests((current) => ({ ...current, [id]: result }));
        if (result.ok) setNotice(`${created ? "Criado" : "Salvo"} e testado — ${describeTest(id, result)}`);
        else {
          setNotice(`${id}: ${created ? "provedor criado" : "configuração salva"}.`);
          setError(describeTest(id, result));
        }
        await reload();
      },
      "Falha ao salvar o provedor.",
    );
    return ok;
  };

  const remove = async (id: string) => {
    setNotice(null);
    await runAdmin(
      id,
      async () => {
        await api.providers.remove(id);
        setNotice(`${id}: removido.`);
        setTests((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
        await reload();
      },
      "Falha ao remover o provedor.",
    );
  };

  const addPreset = async () => {
    if (!preset) return;
    setNotice(null);
    await runAdmin(
      `preset:${preset}`,
      async () => {
        const id = await api.providers.addPreset(preset);
        setNotice(id ? `Preset "${preset}" adicionado como ${id}.` : `Preset "${preset}" adicionado.`);
        if (id) focusAfterReload.current = id;
        await reload();
      },
      "Falha ao adicionar o preset.",
    );
  };

  const submitToken = async (token: string) => {
    setAdminToken(token);
    setHasToken(true);
    const retry = admin?.retry ?? null;
    setAdmin(null);
    setError(null);
    await reload();
    if (retry) await runAdmin("admin", retry, "Falha ao repetir a ação.");
  };

  const forgetToken = async () => {
    setAdminToken(null);
    setHasToken(false);
    setNotice("Token de administração esquecido nesta aba.");
    await reload();
  };

  /* Sem token aceito e sem permissão, nada que grave ou consulte o provedor funciona. */
  const locked = !canAdmin && !adminTokenAccepted;

  return (
    <Modal title="Provedores de LLM" onClose={onClose} wide>
      <p className="help-intro">
        Bots do servidor jogam através destes provedores. As <strong>chaves de API ficam só no servidor</strong>, no
        arquivo <code>.env</code>: esta tela mostra apenas se a variável existe, nunca o valor.
      </p>

      {isMock && (
        <p className="form-hint">
          Modo demonstração (<code>?mock=</code>): os dados abaixo são fixtures e o que você grava fica só na memória
          desta aba.
        </p>
      )}

      {admin && (
        <AdminPanel
          accepted={admin.accepted}
          rejected={admin.rejected === true}
          docker={docker}
          onSubmit={(token) => void submitToken(token)}
        />
      )}
      {!admin && hasToken && (
        <p className="form-hint">
          Usando um token de administração guardado nesta aba.{" "}
          <button type="button" className="link" onClick={() => void forgetToken()}>
            Esquecer token
          </button>
        </p>
      )}

      <div className="prov-status" aria-live="polite">
        {notice && <p className="prov-notice">{notice}</p>}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>

      {loading && providers.length === 0 ? (
        <p className="muted">Carregando provedores…</p>
      ) : (
        <ul className="prov-list">
          {providers.map((provider) => {
            const tone = providerTone(provider);
            const state = models[provider.id];
            const lastTest = tests[provider.id];
            const filtered = state
              ? state.list.filter((m) =>
                  state.query
                    ? `${m.id} ${m.name ?? ""}`.toLowerCase().includes(state.query.toLowerCase())
                    : true,
                )
              : [];
            const busy = busyId === provider.id;
            return (
              <li key={provider.id} className="prov">
                <div className="prov-head">
                  <span className={`dot tone-${tone.tone}`} aria-hidden="true" />
                  <h3 className="prov-name" id={`${headingId}-prov-${provider.id}`} tabIndex={-1}>
                    {provider.name}
                  </h3>
                  <code className="prov-id">{provider.id}</code>
                  {provider.kind === "anthropic" && <span className="feed-tag">Anthropic</span>}
                  {provider.paid && <span className="feed-tag">pago</span>}
                  {provider.local && <span className="feed-tag">local</span>}
                </div>
                <p className="prov-meta">
                  <span className={`tone-text-${tone.tone}`}>{tone.text}</span>
                  {provider.baseUrl && (
                    <>
                      <span aria-hidden="true"> · </span>
                      <code>{provider.baseUrl}</code>
                    </>
                  )}
                  <span aria-hidden="true"> · </span>
                  {provider.apiKeyEnv ? (
                    provider.hasApiKey ? (
                      <span>
                        chave {provider.apiKeyMasked ?? "definida"} via <code>{provider.apiKeyEnv}</code>
                      </span>
                    ) : (
                      <span>
                        sem <code>{provider.apiKeyEnv}</code> no <code>.env</code>
                      </span>
                    )
                  ) : (
                    <span>sem chave (não precisa)</span>
                  )}
                  {provider.timeoutMs !== undefined && (
                    <>
                      <span aria-hidden="true"> · </span>
                      <span>timeout {Math.round(provider.timeoutMs / 1000)} s</span>
                    </>
                  )}
                </p>

                {lastTest && <TestResult result={lastTest} />}

                <div className="prov-actions">
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => void test(provider.id)}
                    disabled={busy || locked}
                  >
                    {busy ? "Testando…" : "Testar conexão"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => void listModels(provider.id, !!state)}
                    disabled={state?.loading || locked}
                    aria-expanded={!!state}
                  >
                    {state ? "Recarregar modelos" : "Listar modelos"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => setEditing(editing === provider.id ? null : provider.id)}
                    aria-expanded={editing === provider.id}
                    disabled={locked}
                  >
                    Editar
                  </button>
                  <button
                    type="button"
                    className="btn btn-small btn-quiet"
                    onClick={() => void remove(provider.id)}
                    disabled={busy || locked}
                  >
                    Remover
                  </button>
                </div>

                {editing === provider.id && (
                  <ProviderForm
                    mode="edit"
                    provider={provider}
                    existingIds={providers.map((p) => p.id)}
                    envKeys={envKeys}
                    docker={docker}
                    busy={busy}
                    onCancel={() => setEditing(null)}
                    onSave={(id, patch) => save(id, patch, false)}
                  />
                )}

                {state && (
                  <div className="prov-models">
                    {state.loading && <p className="muted">Listando modelos…</p>}
                    {state.error && (
                      <div className="prov-test is-bad" role="alert">
                        <p className="prov-test-error">{state.error}</p>
                        {state.hint && (
                          <p className="prov-test-hint">
                            <strong>O que fazer:</strong> {state.hint}
                          </p>
                        )}
                      </div>
                    )}
                    {!state.loading && !state.error && (
                      <>
                        <label className="form-field">
                          <span>
                            Buscar entre {state.list.length} modelo{state.list.length === 1 ? "" : "s"}
                          </span>
                          <input
                            type="search"
                            value={state.query}
                            onChange={(ev) =>
                              setModels((current) => ({
                                ...current,
                                [provider.id]: { ...current[provider.id], query: ev.target.value },
                              }))
                            }
                            placeholder="claude, gpt, qwen…"
                          />
                        </label>
                        <ul className="prov-model-list">
                          {filtered.slice(0, 40).map((model) => (
                            <li key={model.id}>
                              <code>{model.id}</code>
                              {model.name && model.name !== model.id && <span className="muted"> {model.name}</span>}
                              {model.supportsTools === false && <span className="feed-tag">sem tools</span>}
                            </li>
                          ))}
                          {filtered.length === 0 && <li className="muted">nenhum modelo com esse texto</li>}
                        </ul>
                        {filtered.length > 40 && (
                          <p className="muted">…e mais {filtered.length - 40}. Refine a busca.</p>
                        )}
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {creating ? (
        <section className="prov prov-new" aria-labelledby={`${headingId}-new`}>
          <h3 id={`${headingId}-new`} className="prov-name">
            Novo provedor
          </h3>
          <ProviderForm
            mode="create"
            existingIds={providers.map((p) => p.id)}
            envKeys={envKeys}
            docker={docker}
            busy={busyId !== null}
            onCancel={() => {
              setCreating(false);
              window.setTimeout(() => newButtonRef.current?.focus(), 0);
            }}
            onSave={(id, patch) => save(id, patch, true)}
          />
        </section>
      ) : (
        <div className="prov-add">
          <button
            ref={newButtonRef}
            type="button"
            className="btn btn-small btn-primary"
            onClick={() => setCreating(true)}
            disabled={locked}
          >
            Novo provedor
          </button>
          <label className="form-field" htmlFor={`${headingId}-preset`}>
            <span>ou a partir de um preset</span>
            <select id={`${headingId}-preset`} value={preset} onChange={(ev) => setPreset(ev.target.value)}>
              <option value="">escolha um preset…</option>
              {presets.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => void addPreset()}
            disabled={!preset || locked || busyId !== null}
          >
            Adicionar
          </button>
        </div>
      )}

      <h3 id={headingId} className="prov-section-title">
        Perfis de bot
      </h3>
      <p className="form-hint">
        Perfis combinam provedor, modelo, papel e limites. Edite-os em <code>providers.json</code> — o servidor ainda
        não expõe uma rota para gravá-los.
      </p>
      <ul className="prov-profiles" aria-labelledby={headingId}>
        {profiles.map((profile) => (
          <li key={profile.id}>
            <strong>{profile.name}</strong> <code>{profile.providerId}</code> · <code>{profile.model}</code> ·{" "}
            {profile.role === "teacher" ? "professora" : profile.role === "opponent" ? "adversário" : "silencioso"}
            {profile.limits?.maxUsdPerGame !== undefined && (
              <> · limite US$ {profile.limits.maxUsdPerGame.toFixed(2).replace(".", ",")}</>
            )}
          </li>
        ))}
        {profiles.length === 0 && <li className="muted">nenhum perfil configurado</li>}
      </ul>

      <div className="form-actions">
        <button type="button" className="btn" onClick={onClose}>
          Fechar
        </button>
      </div>
    </Modal>
  );
}

/** Resultado do último teste, com a dica do servidor em destaque. */
function TestResult({ result }: { result: ProviderTestResponse }) {
  if (result.ok) {
    return (
      <p className="prov-test is-ok">
        <span aria-hidden="true">✓ </span>
        Conexão ok em {result.latencyMs} ms
        {result.models !== undefined && ` · ${result.models} modelo${result.models === 1 ? "" : "s"}`}
      </p>
    );
  }
  return (
    <div className="prov-test is-bad">
      <p className="prov-test-error">
        <span aria-hidden="true">✗ </span>
        {result.error}
      </p>
      {result.hint && (
        <p className="prov-test-hint">
          <strong>O que fazer:</strong> {result.hint}
        </p>
      )}
    </div>
  );
}

/** Pede o token de administração, ou explica por que esta tela está só em leitura. */
function AdminPanel({
  accepted,
  rejected,
  docker,
  onSubmit,
}: {
  accepted: boolean;
  rejected: boolean;
  docker: boolean;
  onSubmit: (token: string) => void;
}) {
  const id = useId();
  const [token, setToken] = useState("");
  const [empty, setEmpty] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  if (!accepted) {
    return (
      <div className="prov-admin" role="note" aria-labelledby={`${id}-title`}>
        <p id={`${id}-title`} className="prov-admin-title">
          Somente leitura neste aparelho
        </p>
        <p>
          O servidor só aceita alterações de provedores feitas <strong>no mesmo computador</strong> em que ele roda
          {docker ? " (ou pela rede interna do Docker)" : ""}. Para mexer daqui, abra esta página no próprio computador
          do servidor, ou, no <code>.env</code> do servidor:
        </p>
        <ul>
          <li>
            defina <code>ADMIN_TOKEN=uma-senha-longa</code> — esta tela passa a pedir o token; ou
          </li>
          <li>
            inclua o IP deste aparelho (ou a rede, como <code>192.168.0.0/24</code>) em <code>ADMIN_ALLOW_FROM</code>.
          </li>
        </ul>
        <p>
          Depois, {docker ? <>recrie o container (<code>docker compose up -d</code>)</> : "reinicie o servidor"}.
        </p>
      </div>
    );
  }

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    const value = token.trim();
    if (!value) {
      setEmpty(true);
      inputRef.current?.focus();
      return;
    }
    setEmpty(false);
    onSubmit(value);
  };

  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  return (
    <form className="prov-admin" onSubmit={submit} aria-labelledby={`${id}-title`}>
      <p id={`${id}-title`} className="prov-admin-title">
        {rejected ? "Token recusado" : "Alterações exigem o token de administração"}
      </p>
      <p id={hintId}>
        Este navegador não está no computador do servidor. Digite o valor de <code>ADMIN_TOKEN</code> (ou de{" "}
        <code>MCP_TOKEN</code>, se só ele estiver definido) do <code>.env</code> do servidor. Ele fica guardado só nesta
        aba e é mandado como <code>Authorization: Bearer</code>.
      </p>
      <div className="prov-admin-row">
        <label className="form-field" htmlFor={`${id}-token`}>
          <span>Token de administração</span>
          <input
            ref={inputRef}
            id={`${id}-token`}
            type="password"
            className="mono"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(ev) => setToken(ev.target.value)}
            aria-invalid={empty || rejected}
            aria-describedby={empty || rejected ? `${errorId} ${hintId}` : hintId}
          />
        </label>
        <button type="submit" className="btn btn-small btn-primary">
          Usar token
        </button>
      </div>
      {(empty || rejected) && (
        <p id={errorId} className="form-error">
          {empty ? "Digite o token." : "O servidor recusou o token anterior. Confira o valor no .env."}
        </p>
      )}
    </form>
  );
}

type Field = "name" | "id" | "baseUrl" | "apiKeyEnv" | "timeout";

/**
 * Formulário de provedor: criação (com id) ou edição. Só campos sem segredo: a
 * chave mora no `.env`. Na edição, campo opcional vazio vai como `null` e limpa.
 */
function ProviderForm({
  mode,
  provider,
  existingIds,
  envKeys,
  docker,
  busy,
  onCancel,
  onSave,
}: {
  mode: "create" | "edit";
  provider?: ProviderPublic;
  existingIds: string[];
  envKeys: string[];
  docker: boolean;
  busy: boolean;
  onCancel: () => void;
  onSave: (id: string, patch: ProviderUpsert) => Promise<boolean>;
}) {
  const uid = useId();
  const creating = mode === "create";
  const [name, setName] = useState(provider?.name ?? "");
  const [id, setId] = useState(provider?.id ?? "");
  const [idTouched, setIdTouched] = useState(false);
  const [kind, setKind] = useState<ProviderKind>(provider?.kind ?? "openai");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [apiKeyEnv, setApiKeyEnv] = useState(provider?.apiKeyEnv ?? "");
  const [toolMode, setToolMode] = useState<ToolMode>(provider?.toolMode ?? "auto");
  const [local, setLocal] = useState(provider?.local ?? false);
  const [localTouched, setLocalTouched] = useState(!creating);
  const [paid, setPaid] = useState(provider?.paid ?? false);
  const [timeout, setTimeoutSec] = useState(
    provider?.timeoutMs !== undefined ? String(Math.round(provider.timeoutMs / 1000)) : "",
  );
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const refs = {
    name: useRef<HTMLInputElement>(null),
    id: useRef<HTMLInputElement>(null),
    baseUrl: useRef<HTMLInputElement>(null),
    apiKeyEnv: useRef<HTMLInputElement>(null),
    timeout: useRef<HTMLInputElement>(null),
  };

  useEffect(() => {
    (creating ? refs.name : refs.baseUrl).current?.focus();
    // só ao abrir o formulário
  }, []);

  const host = docker ? "host.docker.internal" : "localhost";
  const templates: { label: string; url: string; local: boolean; select?: [number, number] }[] = [
    { label: "Ollama nesta máquina", url: `http://${host}:11434/v1`, local: true },
    { label: "LM Studio nesta máquina", url: `http://${host}:1234/v1`, local: true },
    { label: "Outra máquina da rede", url: "http://192.168.x.x:11434/v1", local: true, select: [15, 18] },
    { label: "URL remota (https)", url: "https://", local: false, select: [8, 8] },
  ];

  const applyTemplate = (template: (typeof templates)[number]) => {
    setBaseUrl(template.url);
    if (!localTouched) setLocal(template.local);
    if (kind === "anthropic" && template.local) setKind("openai");
    setErrors((current) => ({ ...current, baseUrl: undefined }));
    window.setTimeout(() => {
      const input = refs.baseUrl.current;
      if (!input) return;
      input.focus();
      const [start, end] = template.select ?? [template.url.length, template.url.length];
      try {
        input.setSelectionRange(start, end);
      } catch {
        /* sem seleção: o foco basta */
      }
    }, 0);
  };

  const validate = (): Partial<Record<Field, string>> => {
    const found: Partial<Record<Field, string>> = {};
    if (creating && !name.trim()) found.name = "Dê um nome ao provedor.";
    if (creating) {
      const value = id.trim();
      if (!ID_RE.test(value)) {
        found.id = "Use de 1 a 40 caracteres: letras minúsculas, números, - e _, começando por letra ou número.";
      } else if (existingIds.includes(value)) {
        found.id = `Já existe um provedor com o id "${value}".`;
      }
    }
    const url = baseUrl.trim();
    if (url) {
      if (!/^https?:\/\/[^\s/]+/i.test(url)) found.baseUrl = "Informe uma URL começando com http:// ou https://.";
      else if (/x\.x/.test(url)) found.baseUrl = "Troque 192.168.x.x pelo IP da outra máquina.";
      else if (/^https?:\/\/[^/]*@/i.test(url)) {
        found.baseUrl = "Sem usuário:senha na URL: credenciais ficam no .env, apontadas pela variável da chave.";
      }
    } else if (kind === "openai" && (creating || provider?.baseUrl)) {
      found.baseUrl = "Provedores OpenAI-compatíveis precisam da URL base (termina em /v1, em geral).";
    }
    const env = apiKeyEnv.trim();
    if (env) {
      if (!ENV_RE.test(env)) {
        found.apiKeyEnv = "Só o NOME da variável, em maiúsculas: letras, números e _ (ex.: MEU_SERVIDOR_API_KEY).";
      } else if (RESERVED_ENV.has(env)) {
        found.apiKeyEnv = `${env} é um segredo do próprio servidor e não pode ser a chave de um provedor.`;
      } else if (!ENV_SUFFIX_RE.test(env)) {
        found.apiKeyEnv = "O nome precisa terminar em _API_KEY, _KEY ou _TOKEN (ex.: MEU_SERVIDOR_API_KEY).";
      }
    }
    const secs = timeout.trim();
    if (secs) {
      const n = Number(secs);
      if (!Number.isFinite(n) || n < 1 || n > 600) found.timeout = "Entre 1 e 600 segundos (vazio = padrão).";
    }
    return found;
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const found = validate();
    setErrors(found);
    const first = (["name", "id", "baseUrl", "apiKeyEnv", "timeout"] as Field[]).find((f) => found[f]);
    if (first) {
      refs[first].current?.focus();
      return;
    }
    const secs = timeout.trim();
    const patch: ProviderUpsert = {
      name: name.trim() || provider?.name || id.trim(),
      kind,
      baseUrl: baseUrl.trim() || null,
      apiKeyEnv: apiKeyEnv.trim() || null,
      toolMode,
      local,
      paid,
      timeoutMs: secs ? Math.round(Number(secs) * 1000) : null,
    };
    await onSave(creating ? id.trim() : (provider?.id ?? id), patch);
  };

  /* Editar um campo tira o erro dele; os outros esperam o próximo envio. */
  const clearError = (field: Field) =>
    setErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));

  const fieldProps = (field: Field, hintId?: string) => {
    const errorId = `${uid}-${field}-error`;
    const describedBy = [errors[field] ? errorId : null, hintId ?? null].filter(Boolean).join(" ");
    return {
      id: `${uid}-${field}`,
      ref: refs[field],
      "aria-invalid": errors[field] ? true : undefined,
      "aria-describedby": describedBy || undefined,
      onInput: () => clearError(field),
    };
  };
  const errorFor = (field: Field) =>
    errors[field] ? (
      <p id={`${uid}-${field}-error`} className="form-error">
        {errors[field]}
      </p>
    ) : null;

  const env = apiKeyEnv.trim();
  const envStatus = !env
    ? null
    : envKeys.includes(env)
      ? { ok: true, text: `${env} está definida no servidor.` }
      : { ok: false, text: `${env} não aparece no ambiente do servidor (ainda).` };

  return (
    <form className="prov-editor" onSubmit={(ev) => void submit(ev)} noValidate>
      <div className="prov-grid">
        <div className="form-field">
          <label htmlFor={`${uid}-name`}>Nome{creating && " (obrigatório)"}</label>
          <input
            {...fieldProps("name")}
            type="text"
            value={name}
            required={creating}
            onChange={(ev) => {
              setName(ev.target.value);
              if (creating && !idTouched) {
                setId(slugify(ev.target.value));
                clearError("id");
              }
            }}
            placeholder="Ollama do escritório"
          />
          {errorFor("name")}
        </div>
        {creating && (
          <div className="form-field">
            <label htmlFor={`${uid}-id`}>Id</label>
            <input
              {...fieldProps("id", `${uid}-id-hint`)}
              type="text"
              className="mono"
              value={id}
              spellCheck={false}
              autoCapitalize="off"
              onChange={(ev) => {
                setId(ev.target.value);
                setIdTouched(true);
              }}
              placeholder="ollama-escritorio"
            />
            <p id={`${uid}-id-hint`} className="form-hint">
              Gerado a partir do nome; é o que aparece nos perfis e no <code>providers.json</code>.
            </p>
            {errorFor("id")}
          </div>
        )}
      </div>

      <div className="form-field">
        <label htmlFor={`${uid}-kind`}>Tipo de API</label>
        <select id={`${uid}-kind`} value={kind} onChange={(ev) => setKind(ev.target.value as ProviderKind)}>
          <option value="openai">OpenAI-compatível (/chat/completions — Ollama, LM Studio, OpenRouter…)</option>
          <option value="anthropic">Anthropic (Messages API)</option>
        </select>
      </div>

      <fieldset className="prov-fieldset">
        <legend className="form-legend">Endereço</legend>
        <div className="prov-templates" role="group" aria-label="Modelos de endereço">
          {templates.map((template) => (
            <button key={template.label} type="button" className="chip" onClick={() => applyTemplate(template)}>
              {template.label}
            </button>
          ))}
        </div>
        <div className="form-field">
          <label htmlFor={`${uid}-baseUrl`}>URL base</label>
          <input
            {...fieldProps("baseUrl", `${uid}-url-hint`)}
            type="text"
            inputMode="url"
            autoCapitalize="off"
            className="mono"
            value={baseUrl}
            onChange={(ev) => setBaseUrl(ev.target.value)}
            placeholder={kind === "anthropic" ? "vazio = https://api.anthropic.com" : `http://${host}:11434/v1`}
            spellCheck={false}
          />
          <p id={`${uid}-url-hint`} className="form-hint">
            {docker ? (
              <>
                O servidor roda em Docker: <code>localhost</code> ali dentro é o próprio container. Para um modelo nesta
                máquina use <code>host.docker.internal</code>.{" "}
              </>
            ) : null}
            Em outra máquina da rede, o servidor do modelo precisa escutar na rede (Ollama:{" "}
            <code>OLLAMA_HOST=0.0.0.0</code>; LM Studio: “Serve on Local Network”).
            {!creating && " Vazio limpa o campo."}
          </p>
          {errorFor("baseUrl")}
        </div>
      </fieldset>

      <div className="form-field">
        <label htmlFor={`${uid}-apiKeyEnv`}>Variável de ambiente com a chave</label>
        <input
          {...fieldProps("apiKeyEnv", `${uid}-env-hint`)}
          type="text"
          className="mono"
          list={`${uid}-envkeys`}
          value={apiKeyEnv}
          onChange={(ev) => setApiKeyEnv(ev.target.value)}
          placeholder={local ? "vazio = sem chave" : "MEU_SERVIDOR_API_KEY"}
          spellCheck={false}
          autoCapitalize="characters"
          autoComplete="off"
        />
        <datalist id={`${uid}-envkeys`}>
          {envKeys.map((key) => (
            <option key={key} value={key} />
          ))}
        </datalist>
        <p id={`${uid}-env-hint`} className="form-hint">
          A chave fica no <code>.env</code> do servidor; aqui vai só o <strong>nome</strong> da variável, terminado em{" "}
          <code>_API_KEY</code>, <code>_KEY</code> ou <code>_TOKEN</code>.
          {docker && " Reinicie o container depois de editar o .env (docker compose up -d)."}
          {local && " Modelo nesta máquina ou na rede local não precisa de chave."}
          {!creating && " Vazio limpa o campo."}
        </p>
        {envStatus && (
          <p className={`prov-env ${envStatus.ok ? "is-ok" : "is-bad"}`}>
            <span aria-hidden="true">{envStatus.ok ? "✓ " : "! "}</span>
            {envStatus.text}
          </p>
        )}
        {errorFor("apiKeyEnv")}
      </div>

      {!creating && provider && (
        <div className="form-field">
          <label htmlFor={`${uid}-key`}>Chave (somente leitura — definida no servidor)</label>
          <input
            id={`${uid}-key`}
            type="text"
            className="mono"
            readOnly
            value={provider.hasApiKey ? (provider.apiKeyMasked ?? "definida no .env") : "não definida"}
          />
        </div>
      )}

      <div className="prov-grid">
        <div className="form-field">
          <label htmlFor={`${uid}-tool`}>Modo de ferramenta</label>
          <select id={`${uid}-tool`} value={toolMode} onChange={(ev) => setToolMode(ev.target.value as ToolMode)}>
            {TOOL_MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label htmlFor={`${uid}-timeout`}>Timeout por chamada (segundos)</label>
          <input
            {...fieldProps("timeout", `${uid}-timeout-hint`)}
            type="number"
            inputMode="numeric"
            min={1}
            max={600}
            value={timeout}
            onChange={(ev) => setTimeoutSec(ev.target.value)}
            placeholder="padrão"
          />
          <p id={`${uid}-timeout-hint`} className="form-hint">
            Vazio = padrão do servidor. Modelos locais grandes podem precisar de mais.
          </p>
          {errorFor("timeout")}
        </div>
      </div>

      <div className="prov-flags">
        <label className="prov-check">
          <input
            type="checkbox"
            checked={local}
            onChange={(ev) => {
              setLocal(ev.target.checked);
              setLocalTouched(true);
            }}
          />{" "}
          roda localmente / na rede
        </label>
        <label className="prov-check">
          <input type="checkbox" checked={paid} onChange={(ev) => setPaid(ev.target.checked)} /> cobra por uso
        </label>
      </div>

      <div className="form-actions">
        <button type="button" className="btn btn-small" onClick={onCancel} disabled={busy}>
          Cancelar
        </button>
        <button type="submit" className="btn btn-small btn-primary" disabled={busy}>
          {busy ? "Salvando…" : creating ? "Criar e testar" : "Salvar e testar"}
        </button>
      </div>
    </form>
  );
}
