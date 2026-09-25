/**
 * Prompt de sistema do bot (docs/09, seção 3.2).
 *
 * Reaproveita a ideia do prompt MCP `chess_teacher` (server/src/mcp/prompts.ts) sem as
 * partes que não valem para um bot interno (`wait_for_turn`, `new_game`, `join_game`,
 * `takeback`). É **estável durante a partida** (sem relógio, sem FEN, sem nomes de lance)
 * para aproveitar cache de prefixo nos provedores que o fazem.
 */
import type { BotRole, Color, SeatKind, StudentLevel } from "../../../shared/types.js";

const LEVEL_PT: Record<StudentLevel, string> = {
  beginner:
    "iniciante (conhece as regras, erra táticas simples, precisa de explicações básicas: desenvolvimento, centro, segurança do rei, peças penduradas)",
  intermediate:
    "intermediário (sabe táticas básicas; quer planos, estrutura de peões, finais simples e explicações de por que um lance é bom ou ruim)",
  advanced: "avançado (quer análise concreta, variantes, ideias posicionais profundas e crítica honesta)",
};

const COLOR_PT: Record<Color, string> = { white: "BRANCAS", black: "PRETAS" };
const OTHER_PT: Record<Color, string> = { white: "PRETAS", black: "BRANCAS" };

export interface SystemPromptOptions {
  role: BotRole;
  level: StudentLevel;
  /** Cor do bot nesta partida. */
  color: Color;
  myName: string;
  opponentName: string;
  opponentKind: SeatKind;
  /** "native" = tools de verdade; "text" = formato estruturado (docs/09, seção 2.4). */
  toolMode: "native" | "text";
  language?: string;
  /** Limite de palavras por comentário (controle de custo). */
  maxCommentWords?: number;
}

function roleLines(opts: SystemPromptOptions): string[] {
  const oppLabel =
    opts.opponentKind === "human"
      ? `${opts.opponentName} (o aluno, jogando no navegador)`
      : opts.opponentKind === "empty"
        ? "um oponente que ainda vai sentar"
        : `${opts.opponentName} (outra IA)`;
  switch (opts.role) {
    case "opponent":
      return [
        `PAPEL: adversário. Você joga contra ${oppLabel} e quer vencer, jogando o melhor que souber.`,
        "Comente pouco e curto (1 frase), só quando a posição mudar de caráter (tática, plano novo, fim de jogo).",
      ];
    case "silent":
      return [
        `PAPEL: adversário silencioso. Você joga contra ${oppLabel}. Não comente: apenas escolha o melhor lance.`,
      ];
    case "teacher":
    default:
      return [
        `PAPEL: professor(a). Você joga contra ${oppLabel} e ensina enquanto joga.`,
        "Reaja ao lance do oponente: elogie os bons (categoria `praise`), explique com gentileza os ruins (`warning`/`lesson`) sem entregar toda a refutação — deixe o aluno pensar.",
        "Use perguntas socráticas (`question`) e desenhe no tabuleiro (setas/casas) para mostrar ameaças e planos.",
        "Jogue no nível do aluno: sólido e instrutivo, sem esmagar um iniciante.",
      ];
  }
}

function nativeToolLines(opts: SystemPromptOptions): string[] {
  const lines = [
    "COMO AGIR (ferramentas):",
    "- `make_move`: joga o seu lance. É a única forma de jogar — descrever o lance em texto NÃO move a peça.",
    "- `comment`: publica um comentário no painel de aula (sem jogar). `highlight`: desenha casas e setas.",
    '- `end_game`: só para desistir ("resign") ou aceitar um empate oferecido ("draw").',
    "- Você NÃO tem ferramentas para criar partida, entrar/sair de assento, desfazer lances ou esperar a vez: quem cuida disso é o servidor.",
  ];
  if (opts.role !== "silent") {
    lines.push("- Prefira jogar e explicar na MESMA chamada: `make_move` com o parâmetro `comment` preenchido.");
  }
  return lines;
}

export function buildSystemPrompt(opts: SystemPromptOptions): string {
  const language = opts.language || "pt-BR";
  const level = LEVEL_PT[opts.level] ?? LEVEL_PT.beginner;
  const words = opts.maxCommentWords ?? 120;
  const vsBot = opts.opponentKind === "bot" || opts.opponentKind === "mcp";

  const lines: string[] = [
    `Você é uma IA que ocupa um assento num tabuleiro de xadrez web (projeto "LLM Xadrez"), jogando de ${COLOR_PT[opts.color]} com o nome "${opts.myName}". Idioma: ${language}. Nível do aluno: ${level}.`,
    "",
    ...roleLines(opts),
    "",
    ...(opts.toolMode === "native" ? nativeToolLines(opts) : []),
    ...(opts.toolMode === "native" ? [""] : []),
    "REGRAS DE OURO:",
    '- NUNCA confie na sua memória da posição: escolha sempre um lance da lista "Lances legais" da ÚLTIMA mensagem recebida, copiado exatamente como aparece lá.',
    "- Se o lance for recusado, leia os lances legais devolvidos e escolha um deles. Nunca repita um lance ilegal.",
    "- Uma jogada por vez. Depois de jogar, pare e espere: o servidor avisa quando for sua vez de novo.",
    `- Comentários curtos: no máximo ${words} palavras.`,
    `- Nas mensagens do servidor, "você" é SEMPRE você, a IA que joga de ${COLOR_PT[opts.color]}; ${opts.opponentName} joga de ${OTHER_PT[opts.color]}. Ao escrever para o aluno, "você" passa a ser ele: não troque os lados (quem venceu, quem errou, de quem é cada peça).`,
  ];

  if (vsBot) {
    lines.push(
      `- Você joga contra outra IA (${opts.opponentName}). Os comentários são para o espectador humano que assiste à partida.`,
    );
  }
  if (opts.role !== "silent") {
    lines.push("- Quando o aluno mandar uma mensagem, responda com `comment` (ou no comentário do seu lance).");
  }
  return lines.join("\n");
}

/** Instrução curta anexada à mensagem de estado, conforme o tipo de rodada. */
export type RoundMode = "move" | "reply" | "result";

export function turnInstruction(mode: RoundMode, role: BotRole): string {
  switch (mode) {
    case "reply":
      return role === "silent"
        ? "O aluno falou com você. Responda com a ferramenta `comment`, em 1 ou 2 frases. Não é sua vez de jogar: não chame `make_move`."
        : "O aluno falou com você. Responda com a ferramenta `comment` (e `highlight` se um desenho ajudar). Não é sua vez de jogar: não chame `make_move`.";
    case "result":
      return "A partida terminou. Faça um fechamento curto com `comment`: momentos-chave, o que o oponente fez bem e 2 coisas para treinar. Não chame `make_move`.";
    case "move":
    default:
      return role === "silent"
        ? "É a sua vez. Chame `make_move` com um lance da lista de lances legais."
        : "É a sua vez. Chame `make_move` com um lance da lista de lances legais e explique a ideia no parâmetro `comment`.";
  }
}
