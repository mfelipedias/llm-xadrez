/**
 * Tela "Provedores" (docs/09 §4.3): lista os provedores configurados, testa a
 * conexão, lista os modelos e grava `baseUrl`/`apiKeyEnv`/flags.
 *
 * Invariante (docs/09 §6, decisão aprovada): **a chave de API nunca passa por
 * aqui.** O campo de chave é somente leitura e mostra o que o servidor devolve
 * (`hasApiKey` + `apiKeyMasked`); o que se edita é o *nome da variável de
 * ambiente*. O servidor recusa qualquer corpo com `apiKey`.
 *
 * Perfis de bot são listados em leitura: o servidor ainda não expõe CRUD de
 * perfis (`/api/profiles`), então a edição continua em `providers.json`.
 */
import { useCallback, useEffect, useId, useState } from "react";
import type { BotProfile, ModelInfo, ProviderPublic } from "@shared/types";
import { api, ApiError, isMock } from "../api";
import { providerTone } from "../bots";
import { Modal } from "./Modal";

interface ProvidersDialogProps {
  onClose: () => void;
}

interface ModelsState {
  loading: boolean;
  list: ModelInfo[];
  error?: string;
  query: string;
}

const TOOL_MODES = [
  { value: "auto", label: "auto (detecta)" },
  { value: "native", label: "nativo (tool calling)" },
  { value: "text", label: "texto estruturado" },
];

export function ProvidersDialog({ onClose }: ProvidersDialogProps) {
  const [providers, setProviders] = useState<ProviderPublic[]>([]);
  const [profiles, setProfiles] = useState<BotProfile[]>([]);
  const [presets, setPresets] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [models, setModels] = useState<Record<string, ModelsState>>({});
  const [preset, setPreset] = useState("");
  const headingId = useId();

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.providers.list();
      setProviders(data.providers);
      setProfiles(data.profiles);
      setPresets(data.presets);
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

  const fail = (err: unknown, fallback: string) =>
    setError(err instanceof ApiError || err instanceof Error ? err.message : fallback);

  const test = async (id: string) => {
    setBusyId(id);
    setNotice(null);
    setError(null);
    try {
      const result = await api.providers.test(id);
      if (result.ok) {
        const parts = [`${id}: conexão ok`];
        if (result.latencyMs !== undefined) parts.push(`${result.latencyMs} ms`);
        if (result.models !== undefined) parts.push(`${result.models} modelo${result.models === 1 ? "" : "s"}`);
        setNotice(parts.join(" · "));
      } else {
        setError(`${id}: ${result.error ?? "falhou"}`);
      }
      await reload();
    } catch (err) {
      fail(err, "Falha ao testar o provedor.");
    } finally {
      setBusyId(null);
    }
  };

  const listModels = async (id: string, refresh = false) => {
    setModels((current) => ({ ...current, [id]: { loading: true, list: current[id]?.list ?? [], query: current[id]?.query ?? "" } }));
    try {
      const list = await api.providers.models(id, refresh);
      setModels((current) => ({ ...current, [id]: { loading: false, list, query: current[id]?.query ?? "" } }));
    } catch (err) {
      setModels((current) => ({
        ...current,
        [id]: {
          loading: false,
          list: [],
          query: current[id]?.query ?? "",
          error: err instanceof Error ? err.message : "Falha ao listar modelos.",
        },
      }));
    }
  };

  const save = async (id: string, patch: Record<string, unknown>) => {
    setBusyId(id);
    setError(null);
    try {
      await api.providers.save(id, patch);
      setNotice(`${id}: configuração salva.`);
      setEditing(null);
      await reload();
    } catch (err) {
      fail(err, "Falha ao salvar o provedor.");
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await api.providers.remove(id);
      setNotice(`${id}: removido.`);
      await reload();
    } catch (err) {
      fail(err, "Falha ao remover o provedor.");
    } finally {
      setBusyId(null);
    }
  };

  const addPreset = async () => {
    if (!preset) return;
    setBusyId(preset);
    setError(null);
    try {
      await api.providers.addPreset(preset);
      setNotice(`Preset "${preset}" adicionado.`);
      await reload();
    } catch (err) {
      fail(err, "Falha ao adicionar o preset.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Modal title="Provedores de LLM" onClose={onClose} wide>
      <p className="help-intro">
        Bots do servidor jogam através destes provedores. As <strong>chaves de API ficam só no servidor</strong>, no
        arquivo <code>.env</code>: esta tela mostra apenas se a variável existe, nunca o valor.
      </p>

      {isMock && (
        <p className="form-hint">
          Modo demonstração (<code>?mock=</code>): os dados abaixo são fixtures e nada é gravado.
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
            const filtered = state
              ? state.list.filter((m) =>
                  state.query
                    ? `${m.id} ${m.name ?? ""}`.toLowerCase().includes(state.query.toLowerCase())
                    : true,
                )
              : [];
            return (
              <li key={provider.id} className="prov">
                <div className="prov-head">
                  <span className={`dot tone-${tone.tone}`} aria-hidden="true" />
                  <h3 className="prov-name">{provider.name}</h3>
                  <code className="prov-id">{provider.id}</code>
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
                  <>
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
                  </>
                </p>

                <div className="prov-actions">
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => void test(provider.id)}
                    disabled={busyId === provider.id}
                  >
                    Testar conexão
                  </button>
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => void listModels(provider.id, !!state)}
                    disabled={state?.loading}
                    aria-expanded={!!state}
                  >
                    {state ? "Recarregar modelos" : "Listar modelos"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => setEditing(editing === provider.id ? null : provider.id)}
                    aria-expanded={editing === provider.id}
                  >
                    Editar
                  </button>
                  <button
                    type="button"
                    className="btn btn-small btn-quiet"
                    onClick={() => void remove(provider.id)}
                    disabled={busyId === provider.id}
                  >
                    Remover
                  </button>
                </div>

                {editing === provider.id && (
                  <ProviderEditor
                    provider={provider}
                    busy={busyId === provider.id}
                    onCancel={() => setEditing(null)}
                    onSave={(patch) => void save(provider.id, patch)}
                  />
                )}

                {state && (
                  <div className="prov-models">
                    {state.loading && <p className="muted">Listando modelos…</p>}
                    {state.error && (
                      <p className="form-error" role="alert">
                        {state.error}
                      </p>
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

      <div className="prov-add">
        <label className="form-field" htmlFor={`${headingId}-preset`}>
          <span>Adicionar preset</span>
          <select id={`${headingId}-preset`} value={preset} onChange={(ev) => setPreset(ev.target.value)}>
            <option value="">escolha um preset…</option>
            {presets.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn-small" onClick={() => void addPreset()} disabled={!preset}>
          Adicionar
        </button>
      </div>

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

/** Edição de um provedor. Só campos sem segredo: a chave mora no `.env`. */
function ProviderEditor({
  provider,
  busy,
  onCancel,
  onSave,
}: {
  provider: ProviderPublic;
  busy: boolean;
  onCancel: () => void;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const id = useId();
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? "");
  const [apiKeyEnv, setApiKeyEnv] = useState(provider.apiKeyEnv ?? "");
  const [toolMode, setToolMode] = useState(provider.toolMode);
  const [local, setLocal] = useState(provider.local);
  const [paid, setPaid] = useState(provider.paid);

  return (
    <div className="prov-editor">
      <label className="form-field" htmlFor={`${id}-name`}>
        <span>Nome</span>
        <input id={`${id}-name`} type="text" value={name} onChange={(ev) => setName(ev.target.value)} />
      </label>
      <label className="form-field" htmlFor={`${id}-url`}>
        <span>URL base</span>
        <input
          id={`${id}-url`}
          type="url"
          className="mono"
          value={baseUrl}
          onChange={(ev) => setBaseUrl(ev.target.value)}
          placeholder="http://localhost:1234/v1"
          spellCheck={false}
        />
      </label>
      <label className="form-field" htmlFor={`${id}-env`}>
        <span>Variável de ambiente com a chave</span>
        <input
          id={`${id}-env`}
          type="text"
          className="mono"
          value={apiKeyEnv}
          onChange={(ev) => setApiKeyEnv(ev.target.value)}
          placeholder="OPENROUTER_API_KEY"
          spellCheck={false}
        />
      </label>
      <label className="form-field" htmlFor={`${id}-key`}>
        <span>Chave (somente leitura — definida no servidor)</span>
        <input
          id={`${id}-key`}
          type="text"
          className="mono"
          readOnly
          value={provider.hasApiKey ? (provider.apiKeyMasked ?? "definida no .env") : "não definida"}
        />
      </label>
      <label className="form-field" htmlFor={`${id}-tool`}>
        <span>Modo de ferramenta</span>
        <select id={`${id}-tool`} value={toolMode} onChange={(ev) => setToolMode(ev.target.value as typeof toolMode)}>
          {TOOL_MODES.map((mode) => (
            <option key={mode.value} value={mode.value}>
              {mode.label}
            </option>
          ))}
        </select>
      </label>
      <div className="prov-flags">
        <label className="prov-check">
          <input type="checkbox" checked={local} onChange={(ev) => setLocal(ev.target.checked)} /> roda localmente
        </label>
        <label className="prov-check">
          <input type="checkbox" checked={paid} onChange={(ev) => setPaid(ev.target.checked)} /> cobra por uso
        </label>
      </div>
      <div className="form-actions">
        <button type="button" className="btn btn-small" onClick={onCancel} disabled={busy}>
          Cancelar
        </button>
        <button
          type="button"
          className="btn btn-small btn-primary"
          disabled={busy}
          onClick={() =>
            onSave({
              name: name.trim() || provider.name,
              baseUrl: baseUrl.trim() || undefined,
              apiKeyEnv: apiKeyEnv.trim() || undefined,
              toolMode,
              local,
              paid,
            })
          }
        >
          Salvar
        </button>
      </div>
    </div>
  );
}
