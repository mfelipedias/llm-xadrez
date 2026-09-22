/**
 * Um item do Caderno (docs/10 §5.1): lance, comentário da professora ou
 * mensagem do aluno. Antes era o corpo do `LessonFeed`; virou componente para
 * que o feed, o balão do celular e o modo revisão usem a mesma anotação.
 *
 * Regras de acessibilidade aplicadas aqui (§6):
 * - cada item é `article` com `aria-labelledby` (autor + categoria);
 * - lances são `button` com nome "Ver posição após 11…d6";
 * - o desenho anexado ao comentário ganha descrição em texto oculto;
 * - estado da mensagem ("entregue"/"aguardando") é texto, não só cor.
 */
import type { CommentCategory, HighlightSpec, MoveRecord } from "@shared/types";
import { Markdown } from "../markdown";
import { CATEGORY_LABEL, describeHighlight, formatTime, hasDrawing, moveLabel, movePrefix, type Ink } from "../feed";
import { CategoryIcon } from "./CategoryIcon";
import { San } from "./San";

export interface AnnotationTag {
  label: string;
  tone?: "check" | "ok" | "pending";
}

export interface AnnotationProps {
  id: string;
  kind: "move" | "comment" | "message";
  author: string;
  /** Tinta da voz: brancas, pretas, aluno ou sistema (§3.5). */
  ink: Ink;
  category?: CommentCategory;
  timestamp: string;
  /** Corpo em markdown (comentário ou mensagem). */
  text?: string;
  /** Só para `kind: "move"`. */
  move?: MoveRecord;
  /** Comentário enviado junto com o lance (`make_move.comment`). */
  moveComment?: string;
  highlight?: HighlightSpec;
  tags?: AnnotationTag[];
  /** Ply em revisão: o lance fica marcado na linha do tempo. */
  active?: boolean;
  /** Comentário do ply em revisão (§3.6): ganha o traço da categoria em destaque. */
  focused?: boolean;
  /** Lance desfeito por `takeback`: fica no feed, apagado (§4). */
  undone?: boolean;
  onSelect?: () => void;
}

export function Annotation(props: AnnotationProps) {
  const { id, kind, author, ink, category, timestamp, text, move, moveComment, highlight, tags = [] } = props;
  const time = formatTime(timestamp);
  const classes = [
    "feed-item",
    // `an-*` e não `feed-*`: o corpo do comentário já usa `.feed-comment`.
    `an-${kind}`,
    `ink-${ink}`,
    category ? `cat-${category}` : "",
    props.active ? "is-active" : "",
    props.focused ? "is-focused" : "",
    props.undone ? "is-undone" : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (kind === "move" && move) {
    return (
      <article className={classes} aria-labelledby={`${id}-label`}>
        <button
          type="button"
          className="feed-move-btn"
          onClick={props.onSelect}
          aria-current={props.active ? "true" : undefined}
          aria-label={`Ver posição após ${moveLabel(move)}`}
        >
          <span className="feed-move-san" id={`${id}-label`}>
            <span aria-hidden="true">{movePrefix(move)}</span> <San san={move.san} />
          </span>
          <span className="feed-author">{author}</span>
          {tags.map((tag) => (
            <span key={tag.label} className={`feed-tag${tag.tone ? ` tag-${tag.tone}` : ""}`}>
              {tag.label}
            </span>
          ))}
          {props.undone && <span className="feed-tag">desfeito</span>}
          <time className="feed-time" dateTime={timestamp}>
            {time}
          </time>
        </button>
        {moveComment && (
          <div className="feed-comment feed-comment-inline">
            <Markdown text={moveComment} />
          </div>
        )}
      </article>
    );
  }

  const drawing = hasDrawing(highlight);

  return (
    <article className={classes} aria-labelledby={`${id}-label`}>
      <div className="feed-head" id={`${id}-label`}>
        <span className="feed-author">{author}</span>
        {category && (
          <span className="feed-cat-label">
            <CategoryIcon category={category} /> {CATEGORY_LABEL[category] ?? "Comentário"}
          </span>
        )}
        {tags.map((tag) => (
          <span key={tag.label} className={`feed-tag${tag.tone ? ` tag-${tag.tone}` : ""}`}>
            {tag.label}
          </span>
        ))}
        {drawing && (
          <span className="feed-tag" title="Comentário com desenho no tabuleiro">
            desenho
          </span>
        )}
        {props.undone && <span className="feed-tag">lance desfeito</span>}
        <time className="feed-time" dateTime={timestamp}>
          {time}
        </time>
      </div>
      <div className="feed-comment">
        {text && <Markdown text={text} />}
        {drawing && <p className="sr-only">{describeHighlight(highlight)}</p>}
      </div>
    </article>
  );
}
