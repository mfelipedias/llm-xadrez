/**
 * Campo de mensagem do Caderno (docs/10 §3.2, §5.1): fica colado ao pé do feed
 * porque é a mesma conversa. O destino vira chips quando há duas IAs (§3.5);
 * com uma só, não há escolha a fazer e o seletor some.
 *
 * Acessibilidade (§6): rótulo visível ("Para:"), `textarea` que cresce com o
 * texto, Enter envia e Shift+Enter quebra linha.
 */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Color, GameState, MessageRequest, MessageTarget } from "@shared/types";
import { isAiSeat } from "../status";

interface MessageBoxProps {
  state: GameState;
  onSend: (req: MessageRequest) => Promise<void>;
}

const COLOR_LABEL: Record<Color, string> = { white: "brancas", black: "pretas" };

export function MessageBox({ state, onSend }: MessageBoxProps) {
  const aiColors = (["white", "black"] as Color[]).filter((c) => isAiSeat(state.seats[c]));
  const [target, setTarget] = useState<MessageTarget>("all");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (target !== "all" && !aiColors.includes(target)) setTarget("all");
  }, [aiColors, target]);

  // Altura automática: cresce até 5 linhas e depois rola.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [text]);

  const disabled = aiColors.length === 0;
  const manyAis = aiColors.length > 1;

  const submit = async (ev?: FormEvent) => {
    ev?.preventDefault();
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

  const onKeyDown = (ev: KeyboardEvent<HTMLTextAreaElement>) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      void submit();
    }
  };

  const targets: { value: MessageTarget; label: string }[] = [
    { value: "all", label: "todos" },
    ...aiColors.map((c) => ({ value: c as MessageTarget, label: state.seats[c].name || COLOR_LABEL[c] })),
  ];

  return (
    <form className="messagebox" onSubmit={(ev) => void submit(ev)} aria-label="Mensagem para a IA">
      {manyAis && (
        <div className="target-chips" role="radiogroup" aria-label="Para quem">
          <span className="target-label" aria-hidden="true">
            Para:
          </span>
          {targets.map((item) => (
            <button
              key={item.value}
              type="button"
              role="radio"
              aria-checked={target === item.value}
              className={`chip${target === item.value ? " is-active" : ""}`}
              onClick={() => setTarget(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
      <div className="messagebox-row">
        <label className="sr-only" htmlFor="message-text">
          {manyAis ? `Mensagem para ${targets.find((t) => t.value === target)?.label ?? "todos"}` : "Mensagem"}
        </label>
        <textarea
          id="message-text"
          ref={areaRef}
          rows={1}
          value={text}
          onChange={(ev) => setText(ev.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            disabled ? "Nenhuma IA conectada — conecte uma para conversar" : "Pergunte à professora…"
          }
          disabled={disabled || sending}
          maxLength={2000}
        />
        <button type="submit" className="btn btn-primary" disabled={disabled || sending || !text.trim()}>
          {sending ? "…" : "Enviar"}
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!disabled && (
        <p className="messagebox-hint">
          Enter envia, Shift+Enter quebra linha. A mensagem chega à IA na próxima chamada de ferramenta.
        </p>
      )}
    </form>
  );
}
