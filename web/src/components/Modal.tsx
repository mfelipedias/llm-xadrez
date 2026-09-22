/**
 * Modal sobre `<dialog>` nativo (docs/10 §5.2, decisão 9.5).
 *
 * O `showModal()` dá de graça o que faltava na versão anterior: armadilha de
 * foco, Esc, `inert` no resto da página e devolução do foco ao elemento que
 * abriu o diálogo (2.4.3). Zero bytes de biblioteca.
 */
import { useEffect, useId, useRef, type MouseEvent, type ReactNode } from "react";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}

export function Modal({ title, onClose, children, wide }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  /**
   * O `close` disparado pela própria limpeza do efeito não é o usuário fechando.
   * Sem esta trava, o duplo ciclo de efeitos do StrictMode abriria e fecharia o
   * diálogo, e o `onClose` desmontaria o componente antes de ele aparecer.
   */
  const selfClose = useRef(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) {
        selfClose.current = true;
        dialog.close();
      }
    };
  }, []);

  const close = () => ref.current?.close();

  /** Clique fora do painel fecha. O `<dialog>` é o próprio painel: compara com a área. */
  const onClick = (ev: MouseEvent<HTMLDialogElement>) => {
    const dialog = ref.current;
    if (!dialog || ev.target !== dialog) return;
    // Teclado (Enter no botão) chega como clique em 0,0: não fecha.
    if (ev.clientX === 0 && ev.clientY === 0) return;
    const box = dialog.getBoundingClientRect();
    const inside =
      ev.clientX >= box.left && ev.clientX <= box.right && ev.clientY >= box.top && ev.clientY <= box.bottom;
    if (!inside) close();
  };

  return (
    <dialog
      ref={ref}
      className={`modal${wide ? " modal-wide" : ""}`}
      aria-labelledby={titleId}
      onClick={onClick}
      /*
       * Nada de `preventDefault` no cancel: é o fechamento nativo que devolve o
       * foco ao botão que abriu (2.4.3). O React só reage ao evento `close`.
       */
      onClose={() => {
        if (selfClose.current) {
          selfClose.current = false;
          return;
        }
        onClose();
      }}
    >
      <header className="modal-header">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="btn btn-icon" onClick={close} aria-label="Fechar">
          <span aria-hidden="true">✕</span>
        </button>
      </header>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
