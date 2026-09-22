import { useState, type FormEvent } from "react";
import type { HumanSeating, NewGameRequest } from "@shared/types";
import { Modal } from "./Modal";

interface NewGameDialogProps {
  onClose: () => void;
  onSubmit: (req: NewGameRequest) => Promise<void>;
}

const NAME_KEY = "llm-xadrez.humanName";

const OPTIONS: { value: HumanSeating; label: string; hint: string }[] = [
  { value: "white", label: "Eu de brancas vs IA", hint: "a IA entra nas pretas via MCP" },
  { value: "black", label: "Eu de pretas vs IA", hint: "a IA entra nas brancas via MCP" },
  { value: "none", label: "IA vs IA (assistir)", hint: "duas sessões MCP; você só observa e pergunta" },
  { value: "both", label: "Dois humanos", hint: "os dois lados no navegador (bom para testar)" },
];

function readName(): string {
  try {
    return window.localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function NewGameDialog({ onClose, onSubmit }: NewGameDialogProps) {
  const [seating, setSeating] = useState<HumanSeating>("white");
  const [name, setName] = useState(readName);
  const [advanced, setAdvanced] = useState(false);
  const [fen, setFen] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const req: NewGameRequest = { humanSeats: seating };
    const trimmedName = name.trim();
    if (trimmedName) req.humanName = trimmedName;
    const trimmedFen = fen.trim();
    if (trimmedFen) req.startFen = trimmedFen;
    try {
      window.localStorage.setItem(NAME_KEY, trimmedName);
    } catch {
      /* sem localStorage */
    }
    try {
      await onSubmit(req);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao criar a partida");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="Nova partida" onClose={onClose}>
      <form onSubmit={(ev) => void submit(ev)} className="form">
        <fieldset className="form-group">
          <legend>Modo</legend>
          {OPTIONS.map((opt) => (
            <label key={opt.value} className={`radio${seating === opt.value ? " is-checked" : ""}`}>
              <input
                type="radio"
                name="seating"
                value={opt.value}
                checked={seating === opt.value}
                onChange={() => setSeating(opt.value)}
              />
              <span className="radio-label">{opt.label}</span>
              <span className="radio-hint">{opt.hint}</span>
            </label>
          ))}
        </fieldset>

        {seating !== "none" && (
          <label className="form-field">
            <span>Seu nome</span>
            <input
              type="text"
              value={name}
              onChange={(ev) => setName(ev.target.value)}
              placeholder="Você"
              maxLength={40}
              autoComplete="nickname"
            />
          </label>
        )}

        <button type="button" className="link" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced}>
          {advanced ? "▾" : "▸"} Avançado: posição inicial (FEN)
        </button>
        {advanced && (
          <label className="form-field">
            <span>FEN inicial (opcional)</span>
            <input
              type="text"
              value={fen}
              onChange={(ev) => setFen(ev.target.value)}
              placeholder="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
              spellCheck={false}
              className="mono"
            />
          </label>
        )}

        {error && <p className="form-error" role="alert">{error}</p>}

        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose} disabled={submitting}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? "Criando…" : "Começar"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
