/**
 * Notação com figurinhas (docs/10 §2.3, decisão 9.4): "♞f3" em vez de "Nf3".
 *
 * Fase 1 usou os glifos Unicode de xadrez; a Fase 3 trocou o miolo por SVG
 * inline (`Figurine`) sem mudar a API deste componente — só o desenho. A
 * leitura em português vai sempre junto, escondida, para leitores de tela.
 */
import { Figurine, PIECE_WORD, figurineKey } from "./Figurine";

/** "11.♖xe4" lido como "torre toma e4". */
export function spokenSan(san: string): string {
  if (san.startsWith("O-O-O")) return `roque grande${suffixWord(san)}`;
  if (san.startsWith("O-O")) return `roque pequeno${suffixWord(san)}`;
  let text = san;
  const key = figurineKey(text[0] ?? "");
  const piece = key && key !== "P" && text[0] === text[0].toUpperCase() ? PIECE_WORD[key] : null;
  if (piece) text = `${piece} ${text.slice(1)}`;
  else if (/^[a-h]x/.test(text)) text = `peão da coluna ${text[0]} toma ${text.slice(2)}`;
  else text = `peão ${text}`;
  text = text.replace("x", " toma ");
  text = text.replace(/=([KQRBN])/, (_m, p: string) => ` promove a ${PIECE_WORD[figurineKey(p) ?? "P"]}`);
  text = text.replace("#", "").replace("+", "").replace(/\s+/g, " ").trim();
  return `${text}${suffixWord(san)}`;
}

function suffixWord(san: string): string {
  if (san.endsWith("#")) return ", mate";
  if (san.endsWith("+")) return ", xeque";
  return "";
}

interface SanProps {
  san: string;
  /** false mantém as letras (K, Q, R…) — útil em contextos de texto puro. */
  figurine?: boolean;
  className?: string;
}

export function San({ san, figurine = true, className = "" }: SanProps) {
  const spoken = spokenSan(san);
  const cls = `san${className ? ` ${className}` : ""}`;

  if (!figurine || san.startsWith("O-O")) {
    return (
      <span className={cls}>
        <span aria-hidden="true">{san}</span>
        <span className="sr-only">{spoken}</span>
      </span>
    );
  }

  const first = san[0] ?? "";
  const head = first === first.toUpperCase() ? figurineKey(first) : null;
  const rest = head ? san.slice(1) : san;
  const promoIndex = rest.indexOf("=");
  const promoPiece = promoIndex >= 0 ? figurineKey(rest[promoIndex + 1] ?? "") : null;

  return (
    <span className={cls}>
      <span aria-hidden="true">
        {head && head !== "P" && <Figurine piece={head} className="san-fig" />}
        {promoPiece ? (
          <>
            {rest.slice(0, promoIndex + 1)}
            <Figurine piece={promoPiece} className="san-fig" />
            {rest.slice(promoIndex + 2)}
          </>
        ) : (
          rest
        )}
      </span>
      <span className="sr-only">{spoken}</span>
    </span>
  );
}
