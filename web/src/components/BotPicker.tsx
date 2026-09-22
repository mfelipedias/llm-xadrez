/**
 * Escolha de um bot: perfil pronto ou "provedor + modelo" (docs/09 §4.2, §4.3).
 *
 * Usado em dois lugares — no `NewGameDialog` (um por assento) e no diálogo de
 * "trocar de modelo" da placa — então o estado vive fora, em `BotChoice`.
 *
 * Nenhuma chave de API aparece aqui: quando o provedor precisa de uma e ela não
 * está no `.env`, a UI mostra o nome da variável que falta e nada mais (§6).
 */
import { useEffect, useId, useState } from "react";
import type { BotProfile, ModelInfo, ProviderPublic } from "@shared/types";
import { api } from "../api";
import { limitsOf } from "../bots";

/** Um dos dois: `profileId` (perfil pronto) ou `providerId` + `model`. */
export interface BotChoice {
  profileId?: string;
  providerId?: string;
  model?: string;
}

export interface BotPickerProps {
  idPrefix: string;
  providers: ProviderPublic[];
  profiles: BotProfile[];
  value: BotChoice;
  onChange: (value: BotChoice) => void;
  /** Rótulo do grupo, para leitores de tela ("Bot das brancas"). */
  legend: string;
}

/** Perfil escolhido, se houver. */
export function chosenProfile(profiles: BotProfile[], value: BotChoice): BotProfile | null {
  return value.profileId ? (profiles.find((p) => p.id === value.profileId) ?? null) : null;
}

/** Provedor que este `BotChoice` vai usar de fato. */
export function chosenProvider(
  providers: ProviderPublic[],
  profiles: BotProfile[],
  value: BotChoice,
): ProviderPublic | null {
  const profile = chosenProfile(profiles, value);
  const id = profile?.providerId ?? value.providerId;
  return id ? (providers.find((p) => p.id === id) ?? null) : null;
}

/** Texto do aviso de custo, ou `null` quando o provedor é local/grátis (§4.3). */
export function costWarning(
  providers: ProviderPublic[],
  profiles: BotProfile[],
  value: BotChoice,
): string | null {
  const provider = chosenProvider(providers, profiles, value);
  if (!provider?.paid) return null;
  const limits = limitsOf(chosenProfile(profiles, value));
  const usd = limits.usd.toFixed(2).replace(".", ",");
  const tokens = `${Math.round(limits.tokens / 1000)}k`;
  return `Este provedor cobra por uso (${provider.name}). A partida para sozinha em US$ ${usd} ou ${tokens} tokens.`;
}

export function BotPicker({ idPrefix, providers, profiles, value, onChange, legend }: BotPickerProps) {
  const reactId = useId();
  const base = `${idPrefix}-${reactId.replace(/:/g, "")}`;
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  const custom = !value.profileId;
  const providerId = value.providerId ?? providers[0]?.id ?? "";
  const provider = providers.find((p) => p.id === providerId) ?? null;

  /* Sugestões de modelo do provedor escolhido (datalist). Falha em silêncio:
     listar modelos é conveniência, digitar o id à mão sempre funciona. */
  useEffect(() => {
    if (!custom || !providerId) {
      setModels([]);
      return;
    }
    let alive = true;
    setLoadingModels(true);
    api.providers
      .models(providerId)
      .then((list) => {
        if (alive) setModels(list);
      })
      .catch(() => {
        if (alive) setModels([]);
      })
      .finally(() => {
        if (alive) setLoadingModels(false);
      });
    return () => {
      alive = false;
    };
  }, [custom, providerId]);

  const missingKey = provider?.apiKeyEnv && !provider.hasApiKey ? provider.apiKeyEnv : null;

  return (
    <div className="botpicker">
      <div className="botpicker-profiles" role="group" aria-label={`${legend}: perfis prontos`}>
        {profiles.map((profile) => (
          <button
            key={profile.id}
            type="button"
            className={`chip${value.profileId === profile.id ? " is-active" : ""}`}
            aria-pressed={value.profileId === profile.id}
            onClick={() => onChange({ profileId: profile.id })}
          >
            {profile.name}
          </button>
        ))}
        <button
          type="button"
          className={`chip${custom ? " is-active" : ""}`}
          aria-pressed={custom}
          onClick={() => onChange({ providerId, model: value.model ?? "" })}
        >
          Outro modelo…
        </button>
      </div>

      {custom && (
        <div className="botpicker-custom">
          <label className="form-field" htmlFor={`${base}-provider`}>
            <span>Provedor</span>
            <select
              id={`${base}-provider`}
              value={providerId}
              onChange={(ev) => onChange({ providerId: ev.target.value, model: "" })}
            >
              {providers.length === 0 && <option value="">nenhum provedor configurado</option>}
              {providers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.local ? " · local" : item.paid ? " · pago" : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="form-field" htmlFor={`${base}-model`}>
            <span>Modelo{loadingModels ? " (carregando sugestões…)" : ""}</span>
            <input
              id={`${base}-model`}
              type="text"
              className="mono"
              list={models.length > 0 ? `${base}-models` : undefined}
              value={value.model ?? ""}
              placeholder={models[0]?.id ?? "id do modelo no provedor"}
              spellCheck={false}
              autoComplete="off"
              onChange={(ev) => onChange({ providerId, model: ev.target.value })}
            />
          </label>
          {models.length > 0 && (
            <datalist id={`${base}-models`}>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name ?? model.id}
                </option>
              ))}
            </datalist>
          )}
        </div>
      )}

      {missingKey && (
        <p className="botpicker-note is-bad">
          {provider?.name} precisa de <code>{missingKey}</code> no <code>.env</code> do servidor. A chave nunca passa
          por esta tela.
        </p>
      )}
    </div>
  );
}
