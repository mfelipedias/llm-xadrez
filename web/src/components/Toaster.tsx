/**
 * Toasts acessíveis (docs/10 §4, §6 e diagnóstico §1.5/§1.7).
 *
 * O que muda em relação à Fase 1:
 * - `role="alert"` no erro e `role="status"` na informação, em vez de um
 *   container `aria-live="assertive"` que interrompia o leitor para "FEN copiado";
 * - botão fechar em todos;
 * - erro fica 10 s (mínimo do 2.2.1), informação 4 s;
 * - o relógio **pausa** enquanto o ponteiro está sobre a pilha ou há foco
 *   dentro dela, para dar tempo de ler e de clicar na ação.
 */
import { useEffect, useRef, useState } from "react";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: number;
  text: string;
  kind: "error" | "info";
  action?: ToastAction;
  /** ms; 0 = fica até ser fechado. */
  timeout?: number;
}

export const TOAST_TIMEOUT: Record<ToastItem["kind"], number> = { error: 10_000, info: 4000 };

interface ToasterProps {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}

export function Toaster({ toasts, onDismiss }: ToasterProps) {
  const [paused, setPaused] = useState(false);

  return (
    <div
      className="toasts"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} paused={paused} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function Toast({
  toast,
  paused,
  onDismiss,
}: {
  toast: ToastItem;
  paused: boolean;
  onDismiss: (id: number) => void;
}) {
  const total = toast.timeout ?? TOAST_TIMEOUT[toast.kind];
  const leftRef = useRef(total);

  useEffect(() => {
    if (total === 0 || paused) return;
    const startedAt = Date.now();
    const timer = window.setTimeout(() => onDismiss(toast.id), leftRef.current);
    return () => {
      window.clearTimeout(timer);
      leftRef.current = Math.max(500, leftRef.current - (Date.now() - startedAt));
    };
  }, [paused, total, toast.id, onDismiss]);

  return (
    <div className={`toast toast-${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"}>
      <span className="toast-text">{toast.text}</span>
      {toast.action && (
        <button
          type="button"
          className="btn btn-small"
          onClick={() => {
            toast.action?.onClick();
            onDismiss(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button type="button" className="btn btn-icon toast-close" onClick={() => onDismiss(toast.id)} aria-label="Fechar aviso">
        <span aria-hidden="true">✕</span>
      </button>
    </div>
  );
}
