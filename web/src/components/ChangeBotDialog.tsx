/**
 * "Trocar de modelo" de um assento `bot` (docs/09 §4.3, rota
 * `POST /api/bots/:color/resume` com `{ profileId | providerId + model }`).
 *
 * Também é o caminho para retomar um bot parado por erro ou por orçamento: o
 * servidor zera o contador de gasto quando o assento estava `budget_exceeded`.
 */
import { useState, type FormEvent } from "react";
import type { Color, ServerInfo } from "@shared/types";
import { COLOR_TITLE } from "../status";
import { Modal } from "./Modal";
import { BotPicker, costWarning, type BotChoice } from "./BotPicker";

export interface ChangeBotDialogProps {
  color: Color;
  server: ServerInfo | null;
  /** Escolha inicial: o perfil/modelo que o assento já usa. */
  initial: BotChoice;
  onClose: () => void;
  onSubmit: (color: Color, choice: BotChoice) => Promise<void>;
}

export function ChangeBotDialog({ color, server, initial, onClose, onSubmit }: ChangeBotDialogProps) {
  const providers = server?.providers ?? [];
  const profiles = server?.profiles ?? [];
  const [choice, setChoice] = useState<BotChoice>(initial);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const warning = costWarning(providers, profiles, choice);
  const side = COLOR_TITLE[color].toLowerCase();

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (submitting) return;
    if (!choice.profileId && (!choice.providerId || !choice.model?.trim())) {
      setError("Escolha um perfil ou um provedor + modelo.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(color, choice);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao trocar o modelo");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title={`Bot das ${side}`} onClose={onClose}>
      <form className="form" onSubmit={(ev) => void submit(ev)}>
        <p className="help-intro">
          O bot retoma a partida de onde parou, com o modelo escolhido. Se ele tinha estourado o orçamento, o limite
          volta a zero.
        </p>
        <BotPicker
          idPrefix={`change-${color}`}
          legend={`Bot das ${side}`}
          providers={providers}
          profiles={profiles}
          value={choice}
          onChange={setChoice}
        />
        {warning && (
          <p className="cost-warning">
            <span aria-hidden="true">⚠️</span> {warning}
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose} disabled={submitting}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? "Aplicando…" : "Retomar com este modelo"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
