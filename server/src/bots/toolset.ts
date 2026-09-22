/**
 * Tools que um bot expõe à LLM (docs/09, seção 1.2) e o dispatcher para `mcp/tools.ts`.
 *
 * Princípio: **as mesmas funções** que uma sessão MCP externa chama. O bot só restringe o
 * conjunto (nada de `wait_for_turn`, `new_game`, `join_game`, `leave_game`, `takeback`) e
 * filtra `end_game(abort)`. Os JSON Schemas saem dos mesmos shapes zod de `inputShapes`,
 * via `z.toJSONSchema`, para não haver duas descrições de argumento no projeto.
 */
import * as z from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  inputShapes,
  toolComment,
  toolEndGame,
  toolGetState,
  toolHighlight,
  toolMakeMove,
  type ToolContext,
} from "../mcp/tools.js";
import type { ToolSpec } from "./providers/types.js";

export type BotToolName = "make_move" | "comment" | "highlight" | "get_state" | "end_game";

/** `end_game` do bot: sem `abort` (só o humano/UI aborta uma partida). */
const endGameBotShape = {
  how: z
    .enum(["resign", "draw"])
    .describe('"resign": your color loses. "draw": accept/agree a draw (use it when the student offers a draw).'),
};

const SHAPES: Record<BotToolName, z.ZodRawShape> = {
  make_move: inputShapes.make_move,
  comment: inputShapes.comment,
  highlight: inputShapes.highlight,
  get_state: {},
  end_game: endGameBotShape,
};

const DESCRIPTIONS: Record<BotToolName, string> = {
  make_move:
    "Play a move for your color (SAN like Nf3, exd5, O-O, e8=Q or UCI like g1f3, e7e8q). Always pick a move from the " +
    '"Lances legais" list of the last message. Attach a short teacher comment explaining the idea. On an illegal move the ' +
    "result is an error listing the legal moves: pick one of them.",
  comment:
    "Publish a teacher comment on the board without moving (lesson, plan, reaction, question, praise, warning). " +
    "Use it to answer the student. Optionally attach squares/arrows.",
  highlight:
    "Draw on the board: highlighted squares and arrows (replaces the previous drawing; cleared automatically on the next move). " +
    'Colors: any CSS color, e.g. "green", "red". clear=true erases everything.',
  get_state:
    "Look at the board again: full state (FEN, pieces, ASCII board, history, legal moves). Rarely needed — every message " +
    "already carries the state — but cheap.",
  end_game: 'End the game: "resign" (your color loses) or "draw" (agreed draw; also accepts a pending draw offer).',
};

/** Ordem em que as tools são anunciadas ao provedor (a 1ª é a mais importante). */
export const MOVE_TOOLS: BotToolName[] = ["make_move", "comment", "highlight", "get_state", "end_game"];
/** Rodada de resposta a uma mensagem do aluno / comentário do resultado: não se joga. */
export const TALK_TOOLS: BotToolName[] = ["comment", "highlight", "get_state"];

function jsonSchema(name: BotToolName): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(SHAPES[name]), { io: "input" }) as Record<string, unknown>;
  // `$schema` é ruído para os gateways (e alguns servidores locais recusam campos extras).
  delete schema.$schema;
  if (!schema.properties) schema.properties = {};
  return schema;
}

const SPEC_CACHE = new Map<BotToolName, ToolSpec>();

export function toolSpec(name: BotToolName): ToolSpec {
  const cached = SPEC_CACHE.get(name);
  if (cached) return cached;
  const spec: ToolSpec = { name, description: DESCRIPTIONS[name], parameters: jsonSchema(name) };
  SPEC_CACHE.set(name, spec);
  return spec;
}

export function toolSpecs(names: BotToolName[]): ToolSpec[] {
  return names.map(toolSpec);
}

export interface BotToolOutcome {
  name: string;
  /** Texto que volta para a LLM como `tool` result (o mesmo `content[0].text` do MCP). */
  text: string;
  isError: boolean;
  /** `make_move` aplicado com sucesso. */
  moved: boolean;
  /** Algum comentário foi publicado (comment, ou make_move com `comment`). */
  commented: boolean;
  /** `end_game` aplicado com sucesso. */
  ended: boolean;
}

function textOf(result: CallToolResult): string {
  const first = result.content?.[0];
  if (first && first.type === "text" && typeof first.text === "string") return first.text;
  return "";
}

function issuesText(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.length ? i.path.join(".") : "(raiz)"}: ${i.message}`)
    .slice(0, 5)
    .join("; ");
}

/**
 * Valida os argumentos com o mesmo schema zod da tool MCP e executa.
 * Nunca lança por culpa do modelo: erro de argumento vira `tool` result com `isError`.
 */
export function dispatchBotTool(
  ctx: ToolContext,
  name: string,
  rawArgs: Record<string, unknown>,
  allowed: BotToolName[] = MOVE_TOOLS,
): BotToolOutcome {
  const base: BotToolOutcome = { name, text: "", isError: false, moved: false, commented: false, ended: false };
  if (!allowed.includes(name as BotToolName)) {
    return {
      ...base,
      isError: true,
      text: `A ferramenta "${name}" não está disponível para você agora. Use: ${allowed.join(", ")}.`,
    };
  }
  const tool = name as BotToolName;
  const parsed = z.object(SHAPES[tool]).safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return {
      ...base,
      isError: true,
      text: `Argumentos inválidos para ${tool} (${issuesText(parsed.error)}). Chame a ferramenta de novo com os campos corretos.`,
    };
  }
  const args = parsed.data as Record<string, unknown>;

  let result: CallToolResult;
  switch (tool) {
    case "make_move":
      result = toolMakeMove(ctx, args as Parameters<typeof toolMakeMove>[1]);
      break;
    case "comment":
      result = toolComment(ctx, args as Parameters<typeof toolComment>[1]);
      break;
    case "highlight":
      result = toolHighlight(ctx, args as Parameters<typeof toolHighlight>[1]);
      break;
    case "get_state":
      result = toolGetState(ctx);
      break;
    case "end_game":
      result = toolEndGame(ctx, args as Parameters<typeof toolEndGame>[1]);
      break;
  }

  const isError = result.isError === true;
  return {
    name: tool,
    text: textOf(result),
    isError,
    moved: tool === "make_move" && !isError,
    commented: (tool === "comment" && !isError) || (tool === "make_move" && !isError && typeof args.comment === "string" && !!args.comment.trim()),
    ended: tool === "end_game" && !isError,
  };
}
