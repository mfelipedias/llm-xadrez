/**
 * Nova partida (docs/09 §4.3): em vez dos 4 modos fixos, **um seletor por
 * assento** — humano, IA via MCP ou bot do servidor — e os modos antigos viram
 * atalhos que só preenchem os seletores.
 *
 * O aviso de custo aparece antes de começar, com o limite que o servidor aplica
 * (US$ 1,00 / 400k tokens por partida, decisão aprovada em docs/09 §11).
 */
import { useMemo, useState, type FormEvent } from "react";
import type { Color, NewGameRequest, SeatRequest, ServerInfo } from "@shared/types";
import { Modal } from "./Modal";
import { BotPicker, costWarning, type BotChoice } from "./BotPicker";
import { COLOR_TITLE } from "../status";

interface NewGameDialogProps {
  server: ServerInfo | null;
  onClose: () => void;
  onSubmit: (req: NewGameRequest) => Promise<void>;
  /** Abre a tela de provedores (quando não há nenhum configurado). */
  onOpenProviders: () => void;
}

const NAME_KEY = "llm-xadrez.humanName";

type SeatKindChoice = "human" | "mcp" | "bot";

const KIND_LABEL: Record<SeatKindChoice, string> = {
  human: "Humano (neste navegador)",
  mcp: "IA via MCP (entra pelo chat)",
  bot: "Bot do servidor (provedor de LLM)",
};

interface SeatDraft {
  kind: SeatKindChoice;
  bot: BotChoice;
}

interface Shortcut {
  id: string;
  label: string;
  white: SeatKindChoice;
  black: SeatKindChoice;
}

const SHORTCUTS: Shortcut[] = [
  { id: "vs-bot", label: "Eu de brancas vs bot", white: "human", black: "bot" },
  { id: "bot-vs-bot", label: "Bot vs bot", white: "bot", black: "bot" },
  { id: "vs-mcp", label: "Eu vs IA via MCP", white: "human", black: "mcp" },
  { id: "humans", label: "Dois humanos", white: "human", black: "human" },
];

function readName(): string {
  try {
    return window.localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function NewGameDialog({ server, onClose, onSubmit, onOpenProviders }: NewGameDialogProps) {
  const providers = useMemo(() => server?.providers ?? [], [server]);
  const profiles = useMemo(() => server?.profiles ?? [], [server]);
  const defaultBot: BotChoice = useMemo(
    () => (profiles[0] ? { profileId: profiles[0].id } : { providerId: providers[0]?.id ?? "", model: "" }),
    [profiles, providers],
  );

  const [seats, setSeats] = useState<Record<Color, SeatDraft>>(() => ({
    white: { kind: "human", bot: defaultBot },
    black: { kind: "mcp", bot: defaultBot },
  }));
  const [name, setName] = useState(readName);
  const [advanced, setAdvanced] = useState(false);
  const [fen, setFen] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setSeat = (color: Color, patch: Partial<SeatDraft>) =>
    setSeats((current) => ({ ...current, [color]: { ...current[color], ...patch } }));

  const applyShortcut = (shortcut: Shortcut) =>
    setSeats((current) => ({
      white: { ...current.white, kind: shortcut.white },
      black: { ...current.black, kind: shortcut.black },
    }));

  const activeShortcut = SHORTCUTS.find((s) => s.white === seats.white.kind && s.black === seats.black.kind);
  const hasHuman = seats.white.kind === "human" || seats.black.kind === "human";
  const botColors = (["white", "black"] as Color[]).filter((c) => seats[c].kind === "bot");

  /* Um aviso por provedor pago, não um por assento. */
  const costWarnings = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const color of botColors) {
      const text = costWarning(providers, profiles, seats[color].bot);
      if (text && !seen.has(text)) {
        seen.add(text);
        list.push(text);
      }
    }
    return list;
  }, [botColors, providers, profiles, seats]);

  const toSeatRequest = (color: Color): SeatRequest => {
    const draft = seats[color];
    if (draft.kind === "human") return name.trim() ? { kind: "human", name: name.trim() } : { kind: "human" };
    if (draft.kind === "mcp") return { kind: "mcp" };
    const { profileId, providerId, model } = draft.bot;
    if (profileId) return { kind: "bot", profileId };
    return { kind: "bot", providerId: providerId ?? "", model: model ?? "" };
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (submitting) return;
    for (const color of botColors) {
      const { profileId, providerId, model } = seats[color].bot;
      if (!profileId && (!providerId || !model?.trim())) {
        setError(`Escolha um perfil ou um provedor + modelo para o bot das ${COLOR_TITLE[color].toLowerCase()}.`);
        return;
      }
    }
    setSubmitting(true);
    setError(null);
    const trimmedName = name.trim();
    const req: NewGameRequest = { seats: { white: toSeatRequest("white"), black: toSeatRequest("black") } };
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

  const seatFieldset = (color: Color) => {
    const draft = seats[color];
    return (
      <fieldset className="form-group seat-group" key={color}>
        <legend>{COLOR_TITLE[color]}</legend>
        <label className="form-field" htmlFor={`seat-${color}`}>
          <span className="sr-only">Quem ocupa as {COLOR_TITLE[color].toLowerCase()}</span>
          <select
            id={`seat-${color}`}
            value={draft.kind}
            onChange={(ev) => setSeat(color, { kind: ev.target.value as SeatKindChoice })}
          >
            {(["human", "mcp", "bot"] as SeatKindChoice[]).map((kind) => (
              <option key={kind} value={kind} disabled={kind === "bot" && providers.length === 0}>
                {KIND_LABEL[kind]}
              </option>
            ))}
          </select>
        </label>

        {draft.kind === "bot" && providers.length > 0 && (
          <BotPicker
            idPrefix={`bot-${color}`}
            legend={`Bot das ${COLOR_TITLE[color].toLowerCase()}`}
            providers={providers}
            profiles={profiles}
            value={draft.bot}
            onChange={(bot) => setSeat(color, { bot })}
          />
        )}
      </fieldset>
    );
  };

  return (
    <Modal title="Nova partida" onClose={onClose} wide>
      <form onSubmit={(ev) => void submit(ev)} className="form">
        <div className="form-group" role="group" aria-label="Atalhos de configuração">
          <p className="form-legend">Atalhos</p>
          <div className="shortcut-row">
            {SHORTCUTS.map((shortcut) => (
              <button
                key={shortcut.id}
                type="button"
                className={`chip${activeShortcut?.id === shortcut.id ? " is-active" : ""}`}
                aria-pressed={activeShortcut?.id === shortcut.id}
                onClick={() => applyShortcut(shortcut)}
              >
                {shortcut.label}
              </button>
            ))}
          </div>
        </div>

        <div className="seat-grid">{(["white", "black"] as Color[]).map(seatFieldset)}</div>

        {providers.length === 0 && (
          <p className="form-hint">
            Nenhum provedor de LLM configurado neste servidor — por isso "bot" está desativado.{" "}
            <button type="button" className="link" onClick={onOpenProviders}>
              Abrir provedores
            </button>
          </p>
        )}

        {hasHuman && (
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

        {costWarnings.map((text) => (
          <p key={text} className="cost-warning">
            <span aria-hidden="true">⚠️</span> {text}
          </p>
        ))}

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

        <p className="form-hint">Se a IA criar a partida pelo chat, ela substitui esta.</p>

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
            {submitting ? "Criando…" : "Começar"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
