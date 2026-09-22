/**
 * Formatação do estado para a LLM (texto compacto, pt-BR). Ver docs/02, "Formato do texto de estado".
 * O parâmetro `lang` existe para i18n futura; a v1 implementa apenas pt-BR.
 */
import type {
  Color,
  EndReason,
  GameState,
  HumanMessage,
  MoveRecord,
  PieceOnSquare,
  PieceType,
  TurnEvent,
} from "../../../shared/types.js";
import { PIECE_ORDER } from "./rules.js";

export type Lang = "pt-BR" | "en";

export interface FormatOptions {
  lang?: Lang;
  /** Versão curta: sem listas de peças e sem ASCII (respostas de comment/highlight). */
  short?: boolean;
  /** Texto do "próximo passo" (default: derivado do estado). */
  nextAction?: string;
  /** Mensagens a exibir (default: pendentes no estado para `perspective`). */
  messages?: HumanMessage[];
}

const COLOR_UPPER: Record<Color, string> = { white: "BRANCAS", black: "PRETAS" };
const COLOR_LOWER: Record<Color, string> = { white: "brancas", black: "pretas" };
const PIECE_NAME: Record<PieceType, string> = {
  p: "peão",
  n: "cavalo",
  b: "bispo",
  r: "torre",
  q: "dama",
  k: "rei",
};

export function otherColor(c: Color): Color {
  return c === "white" ? "black" : "white";
}

function seatKindLabel(state: GameState, color: Color): string {
  const seat = state.seats[color];
  if (seat.kind === "human") return "humano";
  if (seat.kind === "mcp") return "LLM";
  return "assento vazio";
}

function seatName(state: GameState, color: Color, perspective: Color | null): string {
  if (perspective === color) return "você";
  const seat = state.seats[color];
  if (seat.kind === "empty") return "vazio";
  return seat.name || (seat.kind === "human" ? "humano" : "LLM");
}

export function formatMoveRef(move: MoveRecord): string {
  return `${move.moveNumber}${move.color === "white" ? ". " : "..."}${move.san}`;
}

/** Descrição curta do lance: "bispo captura peão em f7, xeque!" */
export function describeMove(move: MoveRecord): string {
  const parts: string[] = [];
  if (move.san.startsWith("O-O-O")) parts.push("roque grande");
  else if (move.san.startsWith("O-O")) parts.push("roque pequeno");
  else {
    const piece = PIECE_NAME[move.piece];
    if (move.captured) parts.push(`${piece} captura ${PIECE_NAME[move.captured]} em ${move.to}`);
    else parts.push(`${piece} para ${move.to}`);
    if (move.promotion) parts.push(`promove a ${PIECE_NAME[move.promotion]}`);
  }
  if (move.isCheckmate) parts.push("xeque-mate!");
  else if (move.isCheck) parts.push("xeque!");
  return parts.join(", ");
}

const END_REASON_PT: Record<EndReason, string> = {
  checkmate: "xeque-mate",
  stalemate: "afogamento (rei sem lances)",
  insufficient_material: "material insuficiente",
  threefold_repetition: "tripla repetição",
  fifty_move_rule: "regra dos 50 lances",
  resignation: "desistência",
  draw_agreed: "empate acordado",
  aborted: "partida abortada",
};

export function resultText(state: GameState, perspective: Color | null): string {
  if (state.status !== "finished") return "em andamento";
  const reason = state.endReason ? END_REASON_PT[state.endReason] : "encerrada";
  if (state.winner) {
    const who =
      perspective === state.winner ? "você venceu" : perspective ? "você perdeu" : `${COLOR_LOWER[state.winner]} venceram`;
    return `${state.result} — ${reason}: ${who}`;
  }
  if (state.result === "1/2-1/2") return `${state.result} — ${state.endReason === "draw_agreed" ? reason : `empate por ${reason}`}`;
  return `sem resultado — ${reason}`;
}

function statusText(state: GameState, perspective: Color | null): string {
  if (state.status === "finished") return `encerrada (${resultText(state, perspective)})`;
  if (state.status === "waiting") {
    const empty = state.seats.white.kind === "empty" ? "white" : "black";
    return `aguardando alguém sentar nas ${COLOR_LOWER[empty as Color]}`;
  }
  return "em andamento";
}

export function nextActionText(state: GameState, perspective: Color | null): string {
  if (!perspective) return "Você não ocupa nenhum assento. Chame new_game ou join_game.";
  if (state.status === "finished") return "Partida encerrada. Comente o resultado com o aluno ou chame new_game para outra partida.";
  if (state.status === "waiting") return "Aguardando o oponente sentar. Chame wait_for_turn.";
  if (state.turn === perspective) return "É sua vez: chame make_move com um dos lances legais.";
  return "Não é sua vez. Chame wait_for_turn.";
}

function materialText(balance: number): string {
  if (balance === 0) return "igual (0)";
  return balance > 0 ? `brancas +${balance}` : `pretas +${-balance}`;
}

function pieceList(pieces: PieceOnSquare[], color: "w" | "b"): string {
  const groups: string[] = [];
  for (const type of PIECE_ORDER) {
    const squares = pieces
      .filter((p) => p.color === color && p.type === type)
      .map((p) => p.square)
      .sort();
    if (squares.length) groups.push(`${type.toUpperCase()} ${squares.join(" ")}`);
  }
  return groups.length ? groups.join(" · ") : "—";
}

function capturedList(list: PieceType[]): string {
  return list.length ? list.map((p) => p.toUpperCase()).join(" ") : "—";
}

export function formatHistory(history: MoveRecord[]): string {
  if (history.length === 0) return "(nenhum lance ainda)";
  const parts: string[] = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.color === "white") parts.push(`${m.moveNumber}. ${m.san}`);
    else if (i === 0) parts.push(`${m.moveNumber}... ${m.san}`);
    else parts.push(m.san);
  }
  return parts.join(" ");
}

function legalMovesText(state: GameState, perspective: Color | null): string {
  const n = state.legalMoves.length;
  const turnPt = COLOR_LOWER[state.turn];
  if (state.status === "finished") return "Lances legais: nenhum (partida encerrada).";
  if (perspective !== state.turn || state.status !== "active") {
    const why = state.status === "waiting" ? "partida ainda não começou" : "não é sua vez";
    return `Lances legais: ${n} para as ${turnPt} (${why}; não listados).`;
  }
  const sans = state.legalMoves.map((m) => m.san);
  const captures = state.legalMoves.filter((m) => m.isCapture).map((m) => m.san);
  const checks = state.legalMoves.filter((m) => m.isCheck).map((m) => m.san);
  const extras: string[] = [];
  if (captures.length) extras.push(`capturas: ${captures.join(", ")}`);
  if (checks.length) extras.push(`xeques: ${checks.join(", ")}`);
  const suffix = extras.length ? ` (${extras.join("; ")})` : "";
  return `Lances legais (é a sua vez; ${n}): ${sans.join(" ")}${suffix}`;
}

function plyToMoveNumber(ply: number, state: GameState): string {
  const startMove = Number(state.startFen.split(" ")[5]) || 1;
  const startsBlack = state.startFen.split(" ")[1] === "b";
  const offset = startsBlack ? ply + 1 : ply;
  return String(startMove + Math.floor(offset / 2));
}

function messagesText(state: GameState, perspective: Color | null, override?: HumanMessage[]): string[] {
  if (!perspective) return [];
  const pending =
    override ??
    state.humanMessages.filter((m) => (m.to === "all" || m.to === perspective) && !m.deliveredTo.includes(perspective));
  if (!pending.length) return [];
  const plural = pending.length === 1 ? "nova" : "novas";
  const lines = [`Mensagens do aluno (${pending.length} ${plural}):`];
  for (const m of pending) {
    const target = m.to === "all" ? " (para todos)" : "";
    lines.push(` - [lance ${plyToMoveNumber(m.ply, state)}]${target} "${m.text}"`);
  }
  return lines;
}

function opponentCommentsText(state: GameState, perspective: Color | null): string[] {
  if (!perspective) return [];
  const opp = otherColor(perspective);
  if (state.seats[opp].kind !== "mcp") return [];
  // Comentários avulsos (`comment`) e comentários anexados a lances (`make_move.comment`) do oponente.
  const entries: { ply: number; seq: number; text: string }[] = [];
  state.commentary.forEach((c, i) => {
    if (c.author === opp) entries.push({ ply: c.ply, seq: i, text: c.text });
  });
  for (const m of state.history) {
    if (m.color === opp && m.comment) entries.push({ ply: m.ply, seq: -1, text: `(${m.san}) ${m.comment}` });
  }
  entries.sort((a, b) => a.ply - b.ply || a.seq - b.seq);
  const recent = entries.slice(-3);
  if (!recent.length) return [];
  const lines = [`Últimos comentários de ${state.seats[opp].name || "oponente"}:`];
  for (const c of recent) lines.push(` - [lance ${plyToMoveNumber(c.ply, state)}] ${c.text}`);
  return lines;
}

/**
 * Texto completo do estado para a LLM.
 * `perspective` = cor da sessão chamadora, ou `null` para espectador.
 */
export function formatStateForLLM(state: GameState, perspective: Color | null, opts: FormatOptions = {}): string {
  const lines: string[] = [];
  const short = state.id.slice(-4);
  const turnName = seatName(state, state.turn, perspective);
  const turnKind = seatKindLabel(state, state.turn);

  if (state.status === "finished") {
    lines.push(`# Partida ${short} — encerrada após ${state.ply} meio-lance${state.ply === 1 ? "" : "s"} (${state.result})`);
  } else {
    lines.push(`# Partida ${short} — lance ${state.moveNumber}, vez das ${COLOR_UPPER[state.turn]} (${turnName}, ${turnKind})`);
  }

  const you = perspective
    ? `Você joga de ${COLOR_UPPER[perspective]} como "${state.seats[perspective].name}".`
    : "Você não ocupa nenhum assento (espectador).";
  const check = state.inCheck ? `As ${COLOR_LOWER[state.turn]} estão em XEQUE.` : "Sem xeque.";
  lines.push(`${you} Status: ${statusText(state, perspective)}. ${check}`);

  const last = state.lastMove
    ? `Último lance: ${formatMoveRef(state.lastMove)} (${perspective === state.lastMove.color ? "você" : seatName(state, state.lastMove.color, perspective)}).`
    : "Nenhum lance ainda.";
  lines.push(`${last} Material: ${materialText(state.materialBalance)}.`);

  if (state.drawOffer && perspective && state.drawOffer.by !== perspective) {
    lines.push(`Oferta de empate pendente de ${seatName(state, state.drawOffer.by, perspective)}. Para aceitar: end_game(how: "draw").`);
  }

  lines.push(`➡ Próximo passo: ${opts.nextAction ?? nextActionText(state, perspective)}`);
  lines.push("");
  lines.push(`FEN: ${state.fen}`);

  if (!opts.short) {
    lines.push("");
    const wLabel = `Brancas (${seatName(state, "white", perspective)}):`;
    const bLabel = `Pretas (${seatName(state, "black", perspective)}):`;
    const width = Math.max(wLabel.length, bLabel.length) + 1;
    lines.push(`${wLabel.padEnd(width)}${pieceList(state.pieces, "w")}`);
    lines.push(`${bLabel.padEnd(width)}${pieceList(state.pieces, "b")}`);
    lines.push(
      `Capturadas: brancas tomaram ${capturedList(state.captured.byWhite)} · pretas tomaram ${capturedList(state.captured.byBlack)}`,
    );
    lines.push("");
    lines.push(state.ascii.replace(/\s+$/, ""));
  }

  lines.push("");
  lines.push(`Histórico: ${formatHistory(state.history)}`);
  lines.push("");
  lines.push(legalMovesText(state, perspective));

  const msgs = messagesText(state, perspective, opts.messages);
  if (msgs.length) {
    lines.push("");
    lines.push(...msgs);
  }
  const oppComments = opponentCommentsText(state, perspective);
  if (oppComments.length) {
    lines.push("");
    lines.push(...oppComments);
  }
  return lines.join("\n");
}

/** Prefixa o evento de wait_for_turn e anexa o estado. */
export function formatTurnEvent(event: TurnEvent, state: GameState, perspective: Color | null, opts: FormatOptions = {}): string {
  const head: string[] = [];
  const oppName = perspective ? seatName(state, otherColor(perspective), perspective) : "oponente";
  switch (event.event) {
    case "opponent_moved":
      if (event.opponentMove) {
        head.push(`O oponente (${oppName}) jogou ${formatMoveRef(event.opponentMove)} (${describeMove(event.opponentMove)}).`);
      } else head.push(`O oponente (${oppName}) jogou.`);
      break;
    case "your_turn":
      head.push("É sua vez.");
      if (event.opponentMove) head.push(`Último lance do oponente: ${formatMoveRef(event.opponentMove)} (${describeMove(event.opponentMove)}).`);
      break;
    case "message": {
      const n = event.messages.length;
      head.push(`O aluno enviou ${n} mensage${n === 1 ? "m" : "ns"} (veja "Mensagens do aluno" abaixo).`);
      break;
    }
    case "takeback":
      head.push("Lances foram desfeitos (takeback). Releia a posição abaixo antes de continuar.");
      break;
    case "opponent_joined":
      head.push(`O oponente sentou: ${oppName}.`);
      break;
    case "new_game":
      head.push("Uma nova partida foi criada. Releia o estado abaixo.");
      break;
    case "game_over":
      head.push(`Partida encerrada: ${resultText(state, perspective)}.`);
      if (event.opponentMove) head.push(`Último lance: ${formatMoveRef(event.opponentMove)} (${describeMove(event.opponentMove)}).`);
      break;
    case "timeout":
      head.push(`Nada aconteceu em ${Math.round(event.waitedSeconds)} s. Chame wait_for_turn de novo (ou converse com o aluno).`);
      break;
    case "not_seated":
      head.push("Você não ocupa nenhum assento. Chame new_game ou join_game.");
      break;
  }
  if (event.event !== "timeout" && event.waitedSeconds > 0) head.push(`(aguardou ${event.waitedSeconds} s)`);
  const messages = event.messages.length ? event.messages : undefined;
  return `${head.join(" ")}\n\n${formatStateForLLM(state, perspective, { ...opts, nextAction: event.nextAction, messages })}`;
}
