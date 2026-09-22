/**
 * Caderno (docs/10 §3.1, §3.2, §5.1): a coluna da aula. Substitui o
 * `LessonFeed` e reúne, numa conversa só, o feed de anotações, o campo de
 * mensagem colado ao pé e — no celular — a aba "Ações".
 *
 * A tabela de lances (`MoveList`) vira a aba "Lances" (decisão 9.2); no
 * desktop a navegação principal continua sendo a régua sob o tabuleiro.
 *
 * O `aria-live` do feed saiu daqui: ele migrava de nó a cada item novo e por
 * isso não era anunciado (falha 4.1.3 do diagnóstico §1.7). Os anúncios agora
 * vivem em regiões fixas (`LiveRegions`, §6).
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Color, GameState, MessageRequest } from "@shared/types";
import { buildFeed, humanName, inkFor, type FeedItem } from "../feed";
import { Annotation, type AnnotationTag } from "./Annotation";
import { MessageBox } from "./MessageBox";
import { MoveList } from "./MoveList";

export type NotebookTab = "lesson" | "moves" | "actions";

const TARGET_LABEL: Record<"all" | Color, string> = {
  all: "todos",
  white: "brancas",
  black: "pretas",
};

export interface NotebookProps {
  state: GameState;
  selectedPly: number | null;
  onSelectPly: (ply: number | null) => void;
  onSend: (req: MessageRequest) => Promise<void>;
  /** Conteúdo da aba "Ações" (só existe no celular, §3.4). */
  actions?: ReactNode;
  showActionsTab: boolean;
  /** true enquanto o aluno revisa o histórico: destaca o comentário do ply. */
  reviewing: boolean;
}

/** Nome do autor de um comentário, já tolerante a assentos vazios. */
function commentAuthor(state: GameState, author: Color | "system", fallback: string): string {
  if (author === "system") return fallback || "Sistema";
  return fallback || state.seats[author].name || TARGET_LABEL[author];
}

export function Notebook({
  state,
  selectedPly,
  onSelectPly,
  onSend,
  actions,
  showActionsTab,
  reviewing,
}: NotebookProps) {
  const items = useMemo(() => buildFeed(state), [state]);
  const [tab, setTab] = useState<NotebookTab>("lesson");
  const listRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);
  const [unread, setUnread] = useState(0);
  const seenRef = useRef(items.length);
  const stuckRef = useRef(true);
  stuckRef.current = stuck;

  // Se a aba "Ações" some (voltou ao desktop), não deixa o Caderno vazio.
  useEffect(() => {
    if (!showActionsTab && tab === "actions") setTab("lesson");
  }, [showActionsTab, tab]);

  const scrollToEnd = (behavior: ScrollBehavior = "auto") => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  };

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atEnd = distance < 48;
    setStuck(atEnd);
    if (atEnd) {
      seenRef.current = items.length;
      setUnread(0);
    }
  };

  useEffect(() => {
    if (tab !== "lesson") return;
    if (stuckRef.current) {
      scrollToEnd();
      seenRef.current = items.length;
      setUnread(0);
    } else {
      setUnread(Math.max(0, items.length - seenRef.current));
    }
  }, [items.length, state.id, tab]);

  /* Revisão (§3.6): o feed rola até o comentário daquele ply e o destaca. */
  const focusKey = useMemo(() => {
    if (!reviewing || selectedPly === null) return null;
    const match = [...items].reverse().find((item) => item.kind === "comment" && item.ply === selectedPly);
    return match?.key ?? null;
  }, [reviewing, selectedPly, items]);

  useEffect(() => {
    if (!focusKey || tab !== "lesson") return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [focusKey, tab]);

  const student = humanName(state);

  const renderItem = (item: FeedItem) => {
    if (item.kind === "move") {
      const { move } = item;
      const tags: AnnotationTag[] = [];
      if (move.captured) tags.push({ label: "captura" });
      if (move.isCheckmate) tags.push({ label: "mate", tone: "check" });
      else if (move.isCheck) tags.push({ label: "xeque", tone: "check" });
      return (
        <div key={item.key} data-key={item.key}>
          <Annotation
            id={item.key}
            kind="move"
            author={state.seats[move.color].name || TARGET_LABEL[move.color]}
            ink={inkFor(move.color)}
            timestamp={move.timestamp}
            move={move}
            moveComment={move.comment}
            tags={tags}
            active={selectedPly === move.ply}
            onSelect={() => onSelectPly(move.ply)}
          />
        </div>
      );
    }
    if (item.kind === "comment") {
      const { comment } = item;
      return (
        <div key={item.key} data-key={item.key}>
          <Annotation
            id={item.key}
            kind="comment"
            author={commentAuthor(state, comment.author, comment.authorName)}
            ink={inkFor(comment.author)}
            category={comment.category}
            timestamp={comment.timestamp}
            text={comment.text}
            highlight={comment.highlight}
            focused={focusKey === item.key}
            /* Lance desfeito por takeback: o comentário fica, apagado (§4). */
            undone={item.ply > state.ply}
          />
        </div>
      );
    }
    const { message } = item;
    const delivered = message.deliveredTo.length > 0;
    return (
      <div key={item.key} data-key={item.key}>
        <Annotation
          id={item.key}
          kind="message"
          author={`${student} → ${TARGET_LABEL[message.to]}`}
          ink="student"
          timestamp={message.timestamp}
          text={message.text}
          undone={item.ply > state.ply}
          tags={[
            delivered
              ? { label: "entregue", tone: "ok" }
              : { label: "aguardando entrega", tone: "pending" },
          ]}
        />
      </div>
    );
  };

  const tabs: { id: NotebookTab; label: string; badge?: string }[] = [
    { id: "lesson", label: "Aula", badge: items.length > 0 ? String(items.length) : undefined },
    { id: "moves", label: "Lances", badge: state.history.length > 0 ? String(state.history.length) : undefined },
  ];
  if (showActionsTab) tabs.push({ id: "actions", label: "Ações" });

  const onTabKey = (ev: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((t) => t.id === tab);
    if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
      ev.preventDefault();
      ev.stopPropagation();
      const next = tabs[(index + (ev.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      setTab(next.id);
      (ev.currentTarget.querySelector<HTMLElement>(`#tab-${next.id}`))?.focus();
    }
  };

  return (
    <section className="notebook" aria-label="Caderno">
      <h2 className="sr-only">Caderno</h2>
      <div className="notebook-tabs" role="tablist" aria-label="Seções do caderno" onKeyDown={onTabKey}>
        {tabs.map((item) => (
          <button
            key={item.id}
            id={`tab-${item.id}`}
            type="button"
            role="tab"
            className={`nb-tab${tab === item.id ? " is-active" : ""}`}
            aria-selected={tab === item.id}
            aria-controls={`panel-${item.id}`}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => setTab(item.id)}
          >
            {item.label}
            {item.badge && <span className="nb-badge">{item.badge}</span>}
          </button>
        ))}
      </div>

      <div
        id="panel-lesson"
        role="tabpanel"
        aria-labelledby="tab-lesson"
        className={`notebook-panel${tab === "lesson" ? "" : " is-hidden"}`}
      >
        <div className="feed-list" ref={listRef} onScroll={onScroll}>
          {items.length === 0 ? (
            <p className="feed-empty">
              Aqui aparecem os lances e o que a professora explica sobre eles. Faça o primeiro lance ou pergunte
              alguma coisa no campo abaixo.
            </p>
          ) : (
            items.map(renderItem)
          )}
        </div>
        {/* Região viva fixa: o botão aparece dentro dela, ela nunca sai do DOM. */}
        <div className="feed-jump-slot" aria-live="polite">
          {unread > 0 && (
            <button type="button" className="btn btn-small feed-jump" onClick={() => scrollToEnd("smooth")}>
              {unread === 1 ? "1 item novo" : `${unread} itens novos`} ↓
            </button>
          )}
        </div>
      </div>

      <div
        id="panel-moves"
        role="tabpanel"
        aria-labelledby="tab-moves"
        className={`notebook-panel${tab === "moves" ? "" : " is-hidden"}`}
      >
        <MoveList history={state.history} selectedPly={selectedPly} onSelect={onSelectPly} />
      </div>

      {showActionsTab && (
        <div
          id="panel-actions"
          role="tabpanel"
          aria-labelledby="tab-actions"
          className={`notebook-panel notebook-actions${tab === "actions" ? "" : " is-hidden"}`}
        >
          {actions}
        </div>
      )}

      {tab !== "actions" && <MessageBox state={state} onSend={onSend} />}
    </section>
  );
}
