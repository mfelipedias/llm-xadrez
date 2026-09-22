import { useEffect, useState, type FormEvent } from "react";
import type { Color, GameState, MessageRequest, MessageTarget } from "@shared/types";

interface MessageBoxProps {
  state: GameState;
  onSend: (req: MessageRequest) => Promise<void>;
}

const COLOR_LABEL: Record<Color, string> = { white: "brancas", black: "pretas" };

export function MessageBox({ state, onSend }: MessageBoxProps) {
  const aiColors = (["white", "black"] as Color[]).filter((c) => state.seats[c].kind === "mcp");
  const [target, setTarget] = useState<MessageTarget>("all");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (target !== "all" && !aiColors.includes(target)) setTarget("all");
  }, [aiColors, target]);

  const disabled = aiColors.length === 0;

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || sending || disabled) return;
    setSending(true);
    setError(null);
    try {
      await onSend({ text: trimmed, to: target });
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao enviar");
    } finally {
      setSending(false);
    }
  };

  return (
    <form className="messagebox" onSubmit={(ev) => void submit(ev)} aria-label="Mensagem para a IA">
      <div className="messagebox-row">
        <select
          value={target}
          onChange={(ev) => setTarget(ev.target.value as MessageTarget)}
          disabled={disabled || aiColors.length === 1}
          aria-label="Destinatário"
        >
          <option value="all">todos</option>
          {aiColors.map((c) => (
            <option key={c} value={c}>
              {COLOR_LABEL[c]} ({state.seats[c].name})
            </option>
          ))}
        </select>
        <input
          type="text"
          value={text}
          onChange={(ev) => setText(ev.target.value)}
          placeholder={disabled ? "Nenhuma IA conectada" : "Pergunte algo à IA… (Enter envia)"}
          disabled={disabled || sending}
          maxLength={2000}
          aria-label="Mensagem"
        />
        <button type="submit" className="btn btn-primary" disabled={disabled || sending || !text.trim()}>
          {sending ? "…" : "Enviar"}
        </button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {!disabled && (
        <p className="messagebox-hint">A mensagem chega à IA na próxima chamada de ferramenta.</p>
      )}
    </form>
  );
}
