/**
 * Modo "texto estruturado" (docs/09, seção 2.4): para modelos que ignoram `tools`, chamam
 * a tool com nome errado ou devolvem JSON quebrado. O bot manda o estado + um formato de
 * resposta em linhas e extrai o lance de volta com um parser tolerante.
 *
 * O mesmo parser é a **rede de segurança do modo nativo**: se um modelo com tools responder
 * só texto contendo um lance legal, o bot aproveita em vez de gastar outra rodada.
 */
import type { BotRole, HighlightArrow, HighlightSquare, LegalMove } from "../../../shared/types.js";
import { normalizeMoveInput } from "../game/rules.js";
import type { RoundMode } from "./prompt.js";

const MAX_COMMENT_CHARS = 600;

const MOVE_KEYS = "MOVE|LANCE|JOGADA|MOVIMENTO|PLAY";
const COMMENT_KEYS = "COMMENT|COMENT[ÁA]RIO|EXPLICA[ÇC][ÃA]O";
const ARROW_KEYS = "ARROWS|SETAS";
const SQUARE_KEYS = "SQUARES|CASAS";
const ANY_KEY = `${MOVE_KEYS}|${COMMENT_KEYS}|${ARROW_KEYS}|${SQUARE_KEYS}`;

/* ------------------------------------------------------------------ */
/* Limpeza                                                             */
/* ------------------------------------------------------------------ */

/** Remove raciocínio (`<think>`), cercas de código e ênfase markdown. */
export function stripMarkup(text: string): string {
  return text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, " ")
    .replace(/<think(?:ing)?>[\s\S]*$/i, " ")
    .replace(/^[\s\S]*?<\/think(?:ing)?>/i, " ")
    .replace(/```[a-z]*\n?/gi, "\n")
    .replace(/```/g, "\n")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

/* ------------------------------------------------------------------ */
/* Casamento com a lista de lances legais                              */
/* ------------------------------------------------------------------ */

const stripSuffix = (san: string): string => san.replace(/[+#]/g, "");
const loose = (san: string): string => stripSuffix(san).toLowerCase().replace(/[=x]/g, "");

/**
 * Casa um token com um lance legal e devolve o SAN canônico (ou `null`).
 * Aceita SAN, UCI (`g1f3`, `e2-e4`, `e7e8q`), `0-0`, caixa trocada e `+`/`#`/`!`/`?` extras.
 * Mesmas regras de `rules.parseMove`, mas sobre a lista `LegalMove[]` (sem instanciar Chess).
 */
export function matchLegalMove(token: string, legal: LegalMove[]): string | null {
  const raw = normalizeMoveInput(token ?? "");
  if (raw.length < 2) return null;

  const uci = /^([a-h][1-8])-?([a-h][1-8])=?([qrbn])?$/i.exec(raw);
  if (uci) {
    const from = uci[1].toLowerCase();
    const to = uci[2].toLowerCase();
    const promo = uci[3]?.toLowerCase();
    const found = legal.find(
      (m) => m.from === from && m.to === to && (promo ? m.promotion === promo : !m.promotion || m.promotion === "q"),
    );
    if (found) return found.san;
  }

  const exact = legal.find((m) => stripSuffix(m.san) === raw);
  if (exact) return exact.san;

  const target = loose(raw);
  const candidates = legal.filter((m) => loose(m.san) === target);
  if (candidates.length === 1) return candidates[0].san;
  if (candidates.length > 1) {
    const pawn = candidates.filter((m) => m.piece === "p");
    if (pawn.length === 1) return pawn[0].san;
  }
  return null;
}

/** Tokens plausíveis de lance encontrados no texto, na ordem em que aparecem. */
function moveTokens(text: string): string[] {
  const matches = text.match(/[A-Za-z0-9](?:[A-Za-z0-9]|[-=](?=[A-Za-z0-9]))*[+#!?]*/g);
  return matches ?? [];
}

/** Primeiro token do trecho (SAN não tem espaços), sem pontuação em volta. */
function firstToken(text: string): string {
  const cleaned = text.trim().replace(/^[("'*\s]+/, "");
  const token = cleaned.split(/[\s,;|]+/)[0] ?? "";
  return token.replace(/[.,;:)"'*]+$/, "");
}

/* ------------------------------------------------------------------ */
/* Parser                                                              */
/* ------------------------------------------------------------------ */

export interface ParsedBotText {
  /** SAN canônico, já validado contra os lances legais. */
  move?: string;
  comment?: string;
  arrows?: HighlightArrow[];
  squares?: HighlightSquare[];
  /** Como o lance foi encontrado (diagnóstico/logs e testes). */
  source?: "key" | "json" | "scan";
  /** Preenchido quando havia um lance declarado mas ele não é legal. */
  rejected?: string;
}

function parseSquareList(raw: string): { arrows: HighlightArrow[]; squares: HighlightSquare[] } {
  const arrows: HighlightArrow[] = [];
  const squares: HighlightSquare[] = [];
  for (const part of raw.split(/[,;]+/)) {
    const item = part.trim();
    const arrow = /^([a-h][1-8])\s*(?:->|-|→|:)\s*([a-h][1-8])$/i.exec(item);
    if (arrow) {
      arrows.push({ from: arrow[1].toLowerCase(), to: arrow[2].toLowerCase() });
      continue;
    }
    const square = /^([a-h][1-8])$/i.exec(item);
    if (square) squares.push({ square: square[1].toLowerCase() });
  }
  return { arrows, squares };
}

/** Valor de uma chave (`COMMENT:`) até a próxima chave conhecida ou o fim do texto. */
function keyValue(text: string, keys: string): string | null {
  // Sem a flag `m`: o `$` do lookahead precisa ser o fim do texto, não o fim da linha.
  const re = new RegExp(
    `(?:^|\\n)[ \\t>*-]*(?:${keys})[ \\t]*[:=][ \\t]*([\\s\\S]*?)(?=\\n[ \\t>*-]*(?:${ANY_KEY})[ \\t]*[:=]|$)`,
    "i",
  );
  const m = re.exec(text);
  return m ? m[1].trim() : null;
}

function jsonCandidate(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, i + 1));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
        } catch {
          return null;
        }
        return null;
      }
    }
  }
  return null;
}

function cleanComment(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const text = raw
    .replace(/^["'`\s]+|["'`\s]+$/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return undefined;
  return text.length > MAX_COMMENT_CHARS ? `${text.slice(0, MAX_COMMENT_CHARS).trimEnd()}…` : text;
}

/**
 * Extrai lance/comentário/desenhos de uma resposta em texto livre.
 * Ordem: linha `MOVE:` → JSON `{"move": …}` → varredura por tokens que batem com a lista legal.
 */
export function parseBotText(text: string, legal: LegalMove[]): ParsedBotText {
  const out: ParsedBotText = {};
  const original = text ?? "";
  const clean = stripMarkup(original);
  if (!clean) return out;

  const declared = keyValue(clean, MOVE_KEYS);
  const commentRaw = keyValue(clean, COMMENT_KEYS);
  const arrowsRaw = keyValue(clean, ARROW_KEYS);
  const squaresRaw = keyValue(clean, SQUARE_KEYS);

  if (declared) {
    const token = firstToken(declared);
    const san = matchLegalMove(token, legal);
    if (san) {
      out.move = san;
      out.source = "key";
    } else {
      // Declarou um lance que não existe na posição: registra e continua tentando.
      for (const candidate of moveTokens(declared)) {
        const alt = matchLegalMove(candidate, legal);
        if (alt) {
          out.move = alt;
          out.source = "key";
          break;
        }
      }
      if (!out.move && token) out.rejected = token;
    }
  }

  if (!out.move) {
    const json = jsonCandidate(clean);
    if (json) {
      const raw = json.move ?? json.lance ?? json.jogada;
      if (typeof raw === "string") {
        const san = matchLegalMove(firstToken(raw), legal);
        if (san) {
          out.move = san;
          out.source = "json";
        } else if (!out.rejected) out.rejected = firstToken(raw);
      }
      const jsonComment = json.comment ?? json.comentario ?? json["comentário"];
      if (typeof jsonComment === "string") out.comment = cleanComment(jsonComment);
    }
  }

  if (!out.move) {
    // Varredura: se houver mais de um candidato, prefere o que está em negrito, senão o 1º.
    const seen: string[] = [];
    for (const token of moveTokens(clean)) {
      const san = matchLegalMove(token, legal);
      if (san && !seen.includes(san)) seen.push(san);
    }
    if (seen.length === 1) {
      out.move = seen[0];
      out.source = "scan";
    } else if (seen.length > 1) {
      const bold = seen.find((san) => boldContains(original, san));
      out.move = bold ?? seen[0];
      out.source = "scan";
    }
  }

  if (!out.comment) {
    if (commentRaw) out.comment = cleanComment(commentRaw);
    else {
      // Sem COMMENT:, o resto do texto (fora as linhas de chave) vira o comentário.
      const rest = clean
        .split("\n")
        .filter((line) => !new RegExp(`^[\\s>*-]*(?:${ANY_KEY})\\s*[:=]`, "i").test(line))
        .join("\n")
        .trim();
      out.comment = cleanComment(rest);
    }
  }

  if (arrowsRaw || squaresRaw) {
    const fromArrows = arrowsRaw ? parseSquareList(arrowsRaw) : { arrows: [], squares: [] };
    const fromSquares = squaresRaw ? parseSquareList(squaresRaw) : { arrows: [], squares: [] };
    const arrows = [...fromArrows.arrows, ...fromSquares.arrows];
    const squares = [...fromArrows.squares, ...fromSquares.squares];
    if (arrows.length) out.arrows = arrows;
    if (squares.length) out.squares = squares;
  }
  return out;
}

/** O SAN aparece dentro de um trecho em negrito do texto original? */
function boldContains(original: string, san: string): boolean {
  const bolds = original.match(/\*\*[^*]+\*\*/g);
  if (!bolds) return false;
  const target = loose(san);
  return bolds.some((chunk) => moveTokens(chunk).some((t) => loose(normalizeMoveInput(t)) === target));
}

/* ------------------------------------------------------------------ */
/* Prompt do modo texto                                                */
/* ------------------------------------------------------------------ */

/** Bloco anexado ao system prompt quando `toolMode: "text"`. */
export function textModeInstructions(role: BotRole): string {
  const lines = [
    "FORMATO DA RESPOSTA (obrigatório): responda SOMENTE nestas linhas, uma informação por linha,",
    "sem markdown, sem blocos de código, sem texto antes ou depois:",
    "",
    'MOVE: <lance em SAN exatamente como aparece na lista "Lances legais">',
  ];
  if (role !== "silent") {
    lines.push("COMMENT: <1 a 3 frases explicando a ideia, como professor>");
    lines.push("ARROWS: <opcional, ex.: e2-e4, g1-f3>");
  }
  lines.push(
    "",
    "Você não tem ferramentas: é esse texto que o servidor lê para mover a peça. Um lance fora da",
    'lista "Lances legais" é recusado e você perde a vez.',
  );
  return lines.join("\n");
}

/** Instrução por rodada no modo texto (substitui a das ferramentas). */
export function textModeTurnInstruction(mode: RoundMode): string {
  switch (mode) {
    case "reply":
      return "O aluno falou com você. Não é sua vez de jogar: responda apenas com a linha COMMENT: <sua resposta>.";
    case "result":
      return "A partida terminou. Responda apenas com a linha COMMENT: <fechamento curto da partida>.";
    case "move":
    default:
      return 'É a sua vez. Responda com "MOVE: <lance>" na primeira linha, escolhendo um lance da lista de lances legais.';
  }
}
