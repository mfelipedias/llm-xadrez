/**
 * Provedor determinístico para testes e para o smoke sem rede (docs/09, seções 2.1 e 8).
 *
 * Dois modos:
 *  - **scriptado**: `script` é consumido rodada a rodada (e repete o último passo se acabar);
 *  - **livro** (default): lê a lista "Lances legais (é a sua vez; N): ..." da última mensagem
 *    `user` — que é o próprio `formatStateForLLM` — e escolhe o primeiro lance de um livro
 *    de aberturas curto, caindo no primeiro lance legal quando nenhum serve. Assim ele joga
 *    uma partida inteira sem saber nada de xadrez e sem depender de rede.
 */
import type { ModelInfo } from "../../../../shared/types.js";
import type { ChatProvider, ChatRequest, ChatResult, ToolCall } from "./types.js";

export interface FakeStep {
  text?: string;
  toolCalls?: { id?: string; name: string; args: Record<string, unknown>; rawArgs?: string }[];
  finishReason?: ChatResult["finishReason"];
  usage?: ChatResult["usage"];
  /** Lança este erro em vez de responder (testes de 401/429). */
  error?: Error;
}

export interface FakeProviderOptions {
  id?: string;
  /** Respostas fixas, na ordem. */
  script?: FakeStep[];
  /** Controle total: tem precedência sobre `script`. */
  onChat?: (req: ChatRequest, callIndex: number) => FakeStep;
  models?: ModelInfo[];
  /** Comentário publicado junto com o lance no modo livro. */
  comment?: string;
  /** Resposta publicada com a tool `comment` quando não é a vez do bot (mensagem do aluno). */
  reply?: string;
  latencyMs?: number;
}

export interface FakeProvider extends ChatProvider {
  /** Todas as requisições recebidas, para asserções nos testes. */
  readonly calls: ChatRequest[];
  reset(): void;
}

/** Livro curtinho: só para o bot falso abrir de um jeito plausível. */
const BOOK = [
  "e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "d3", "d6", "Nc3", "Nf6", "O-O", "O-O",
  "Bg5", "Bg4", "h3", "h6", "a3", "a6", "b4", "b5", "Re1", "Re8",
];

const LEGAL_RE = /Lances legais \(é a sua vez; \d+\):\s*([^\n(]+)/;
const ANY_LEGAL_RE = /^Lances legais[^\n]*/gm;

/**
 * Lances legais anunciados no texto de estado **mais recente** da conversa.
 * É importante parar no primeiro "Lances legais" de trás para frente: o histórico das rodadas
 * anteriores traz listas antigas, e usá-las faria o bot falso tentar jogar fora da vez.
 */
export function legalMovesFromPrompt(req: ChatRequest): string[] {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const msg = req.messages[i];
    const content = msg.role === "tool" ? msg.content : typeof msg.content === "string" ? msg.content : "";
    const lines = content ? content.match(ANY_LEGAL_RE) : null;
    if (!lines?.length) continue;
    // Numa resposta de erro vêm duas linhas ("Lances legais agora …" + o estado): vale a última.
    const mine = LEGAL_RE.exec(lines[lines.length - 1]);
    return mine ? mine[1].trim().split(/\s+/).filter(Boolean) : [];
  }
  return [];
}

function bookMove(legal: string[]): string | null {
  if (!legal.length) return null;
  for (const candidate of BOOK) {
    if (legal.includes(candidate)) return candidate;
  }
  return legal[0];
}

function toToolCalls(step: FakeStep): ToolCall[] {
  return (step.toolCalls ?? []).map((c, i) => {
    const call: ToolCall = { id: c.id ?? `call_${i + 1}`, name: c.name, args: c.args };
    if (c.rawArgs !== undefined) call.rawArgs = c.rawArgs;
    return call;
  });
}

export function createFakeProvider(opts: FakeProviderOptions = {}): FakeProvider {
  const id = opts.id ?? "fake";
  const calls: ChatRequest[] = [];
  const models: ModelInfo[] = opts.models ?? [{ id: "fake-1", name: "Fake 1", supportsTools: true, contextLength: 8192 }];

  const step = (req: ChatRequest, index: number): FakeStep => {
    if (opts.onChat) return opts.onChat(req, index);
    if (opts.script?.length) return opts.script[Math.min(index, opts.script.length - 1)];
    const move = bookMove(legalMovesFromPrompt(req));
    if (!move) {
      // Não é a nossa vez (rodada de resposta a uma mensagem ou de fechamento): comenta.
      return {
        toolCalls: [{ name: "comment", args: { text: opts.reply ?? "Boa pergunta! Estou disputando o centro e desenvolvendo as peças.", category: "lesson" } }],
        finishReason: "tool_calls",
      };
    }
    return {
      toolCalls: [
        {
          name: "make_move",
          args: { move, comment: opts.comment ?? `Jogo ${move} para seguir o plano.` },
        },
      ],
      finishReason: "tool_calls",
    };
  };

  return {
    id,
    kind: "openai",
    supportsTools: true,
    calls,
    reset() {
      calls.length = 0;
    },
    async chat(req: ChatRequest): Promise<ChatResult> {
      const index = calls.length;
      calls.push(req);
      if (opts.latencyMs) await new Promise((resolve) => setTimeout(resolve, opts.latencyMs));
      const current = step(req, index);
      if (current.error) throw current.error;
      const toolCalls = toToolCalls(current);
      return {
        text: current.text ?? "",
        toolCalls,
        finishReason: current.finishReason ?? (toolCalls.length ? "tool_calls" : "stop"),
        usage: current.usage ?? { inputTokens: 100, outputTokens: 20 },
      };
    },
    async listModels(): Promise<ModelInfo[]> {
      return models.map((m) => ({ ...m }));
    },
    async test() {
      return { ok: true as const, latencyMs: 1, models: models.length };
    },
  };
}
