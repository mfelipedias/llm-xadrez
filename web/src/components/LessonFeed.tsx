import { useEffect, useMemo, useRef, useState } from "react";
import type { Color, CommentCategory, Commentary, GameState, HumanMessage, MoveRecord } from "@shared/types";
import { Markdown } from "../markdown";

interface LessonFeedProps {
  state: GameState;
  selectedPly: number | null;
  onSelectPly: (ply: number) => void;
}

export const CATEGORY_META: Record<CommentCategory, { icon: string; label: string }> = {
  lesson: { icon: "💡", label: "Aula" },
  plan: { icon: "🎯", label: "Plano" },
  reaction: { icon: "💬", label: "Reação" },
  question: { icon: "❓", label: "Pergunta" },
  praise: { icon: "👏", label: "Elogio" },
  warning: { icon: "⚠️", label: "Atenção" },
  info: { icon: "ℹ️", label: "Info" },
};

type FeedItem =
  | { kind: "move"; key: string; timestamp: string; ply: number; order: 0; move: MoveRecord }
  | { kind: "comment"; key: string; timestamp: string; ply: number; order: 1; comment: Commentary }
  | { kind: "message"; key: string; timestamp: string; ply: number; order: 2; message: HumanMessage };

function moveLabel(move: MoveRecord): string {
  return move.color === "white" ? `${move.moveNumber}. ${move.san}` : `${move.moveNumber}… ${move.san}`;
}

const TARGET_LABEL: Record<HumanMessage["to"], string> = {
  all: "todos",
  white: "brancas",
  black: "pretas",
};

function authorIcon(author: Color | "system", state: GameState): string {
  if (author === "system") return "⚙️";
  const kind = state.seats[author].kind;
  return kind === "human" ? "👤" : kind === "mcp" ? "🤖" : "⬚";
}

function humanName(state: GameState): string {
  const human = (["white", "black"] as Color[]).find((c) => state.seats[c].kind === "human");
  return human ? state.seats[human].name : "Você";
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

export function LessonFeed({ state, selectedPly, onSelectPly }: LessonFeedProps) {
  const items = useMemo<FeedItem[]>(() => {
    const list: FeedItem[] = [];
    for (const move of state.history) {
      list.push({ kind: "move", key: `m-${move.ply}`, timestamp: move.timestamp, ply: move.ply, order: 0, move });
    }
    for (const comment of state.commentary) {
      list.push({ kind: "comment", key: `c-${comment.id}`, timestamp: comment.timestamp, ply: comment.ply, order: 1, comment });
    }
    for (const message of state.humanMessages) {
      list.push({ kind: "message", key: `h-${message.id}`, timestamp: message.timestamp, ply: message.ply, order: 2, message });
    }
    list.sort((a, b) => {
      const ta = Date.parse(a.timestamp);
      const tb = Date.parse(b.timestamp);
      if (ta !== tb && !Number.isNaN(ta) && !Number.isNaN(tb)) return ta - tb;
      if (a.ply !== b.ply) return a.ply - b.ply;
      return a.order - b.order;
    });
    return list;
  }, [state.history, state.commentary, state.humanMessages]);

  const listRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  const stickRef = useRef(true);
  stickRef.current = stickToBottom;

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setStickToBottom(distance < 48);
  };

  useEffect(() => {
    const el = listRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [items.length, state.id]);

  const jumpToEnd = () => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setStickToBottom(true);
  };

  const student = humanName(state);

  return (
    <section className="feed" aria-label="Aula">
      <header className="panel-title">
        <span>Aula</span>
        <span className="panel-subtitle">{items.length} itens</span>
      </header>
      <div className="feed-list" ref={listRef} onScroll={onScroll}>
        {items.length === 0 && (
          <p className="feed-empty">Os lances e os comentários da IA aparecerão aqui.</p>
        )}
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          const live = isLast ? { "aria-live": "polite" as const } : {};
          if (item.kind === "move") {
            const { move } = item;
            const author = state.seats[move.color].name;
            const active = selectedPly === move.ply;
            return (
              <article key={item.key} className={`feed-item feed-move${active ? " is-active" : ""}`} {...live}>
                <button type="button" className="feed-move-btn" onClick={() => onSelectPly(move.ply)}
                  title={`Ver posição após ${moveLabel(move)}`}>
                  <span className="feed-avatar" aria-hidden="true">{authorIcon(move.color, state)}</span>
                  <span className="feed-move-san">{moveLabel(move)}</span>
                  <span className="feed-author">{author}</span>
                  {move.captured && <span className="feed-tag">captura</span>}
                  {move.isCheckmate ? <span className="feed-tag tag-check">mate</span> : move.isCheck && <span className="feed-tag tag-check">xeque</span>}
                  <time className="feed-time">{formatTime(move.timestamp)}</time>
                </button>
                {move.comment && (
                  <div className="feed-comment feed-comment-inline">
                    <span className="feed-cat" title="Plano">{CATEGORY_META.plan.icon}</span>
                    <Markdown text={move.comment} />
                  </div>
                )}
              </article>
            );
          }
          if (item.kind === "comment") {
            const { comment } = item;
            const meta = CATEGORY_META[comment.category] ?? CATEGORY_META.info;
            return (
              <article key={item.key} className={`feed-item feed-commentary cat-${comment.category}`} {...live}>
                <div className="feed-head">
                  <span className="feed-avatar" aria-hidden="true">{authorIcon(comment.author, state)}</span>
                  <span className="feed-author">{comment.authorName}</span>
                  <span className="feed-cat-label">
                    <span aria-hidden="true">{meta.icon}</span> {meta.label}
                  </span>
                  {comment.highlight && (comment.highlight.arrows.length > 0 || comment.highlight.squares.length > 0) && (
                    <span className="feed-tag" title="Comentário com desenho no tabuleiro">✎ desenho</span>
                  )}
                  <time className="feed-time">{formatTime(comment.timestamp)}</time>
                </div>
                <div className="feed-comment">
                  <Markdown text={comment.text} />
                </div>
              </article>
            );
          }
          const { message } = item;
          const delivered = message.deliveredTo.length > 0;
          return (
            <article key={item.key} className="feed-item feed-human" {...live}>
              <div className="feed-head">
                <span className="feed-avatar" aria-hidden="true">👤</span>
                <span className="feed-author">{student}</span>
                <span className="feed-cat-label">→ {TARGET_LABEL[message.to]}</span>
                <span className={`feed-tag ${delivered ? "tag-ok" : "tag-pending"}`}>
                  {delivered ? "entregue" : "aguardando entrega"}
                </span>
                <time className="feed-time">{formatTime(message.timestamp)}</time>
              </div>
              <div className="feed-comment">
                <Markdown text={message.text} />
              </div>
            </article>
          );
        })}
      </div>
      {!stickToBottom && (
        <button type="button" className="btn btn-small feed-jump" onClick={jumpToEnd}>
          ↓ ir para o fim
        </button>
      )}
    </section>
  );
}
