/**
 * Onboarding guiado "zero → IA conectada" (docs/10 §3.7).
 *
 * Substitui o par `seat-empty` + modal `ConnectHelp` como caminho principal:
 * enquanto não há IA no assento, a coluna do Caderno (que estaria vazia mesmo)
 * mostra os quatro passos, com detecção automática do progresso:
 *
 *  1. servidor no ar      ← WebSocket conectado
 *  2. cliente registrado  ← `server.mcpSessions` ganhou uma sessão (mesmo sem assento)
 *  3. aula pedida no chat ← a sessão sentou num assento
 *  4. IA na partida       ← idem; aqui o painel se fecha
 *
 * A URL do MCP e o botão copiar — que a Fase 1 tirou do assento livre —
 * voltam aqui, no passo 2.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Color, GameState, ServerInfo } from "@shared/types";
import { isAiSeat } from "../status";
import { CopyButton } from "./CopyButton";

type Client = "code" | "desktop" | "other";

const CLIENT_KEY = "xadrez.client";

const CLIENTS: { id: Client; label: string }[] = [
  { id: "code", label: "Claude Code" },
  { id: "desktop", label: "Claude Desktop" },
  { id: "other", label: "Outro" },
];

const CHAT_PROMPT = "vamos jogar xadrez, eu de brancas, me ensine";

function readClient(): Client {
  try {
    const value = window.localStorage.getItem(CLIENT_KEY);
    if (value === "code" || value === "desktop" || value === "other") return value;
  } catch {
    /* localStorage bloqueado */
  }
  return "code";
}

function snippetFor(client: Client, mcpUrl: string): { code: string; note: string } {
  if (client === "desktop") {
    return {
      code: JSON.stringify(
        { mcpServers: { xadrez: { command: "npx", args: ["-y", "mcp-remote", mcpUrl, "--allow-http"] } } },
        null,
        2,
      ),
      note: "Cole em claude_desktop_config.json e reinicie o app.",
    };
  }
  if (client === "other") {
    return {
      code: `npx -y mcp-remote ${mcpUrl} --allow-http`,
      note: "Clientes com MCP por HTTP aceitam a URL direto; os de stdio usam esta ponte.",
    };
  }
  return {
    code: `claude mcp add --transport http xadrez ${mcpUrl}`,
    note: "Cole no terminal, em qualquer pasta, e abra o claude.",
  };
}

export interface ConnectWizardProps {
  state: GameState;
  server: ServerInfo | null;
  wsConnected: boolean;
  /** Abre o modal com todas as opções de cliente (`ConnectHelp`). */
  onOpenHelp: () => void;
  onNewGame: () => void;
}

export function ConnectWizard({ state, server, wsConnected, onOpenHelp, onNewGame }: ConnectWizardProps) {
  const [client, setClient] = useState<Client>(readClient);
  const sessions = server?.mcpSessions ?? [];
  const seated = (["white", "black"] as Color[]).some((c) => isAiSeat(state.seats[c]));
  const registered = sessions.length > 0;
  const mcpUrl = server?.mcpUrl ?? "";

  useEffect(() => {
    try {
      window.localStorage.setItem(CLIENT_KEY, client);
    } catch {
      /* ignora */
    }
  }, [client]);

  /* "A IA está conectada mas ainda não entrou": 60 s de sessão sem assento. */
  const [stalled, setStalled] = useState(false);
  const sinceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!registered || seated) {
      sinceRef.current = null;
      setStalled(false);
      return;
    }
    if (sinceRef.current === null) sinceRef.current = Date.now();
    const timer = window.setInterval(() => {
      if (sinceRef.current && Date.now() - sinceRef.current > 60_000) setStalled(true);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [registered, seated]);

  const { code, note } = snippetFor(client, mcpUrl);
  const sessionName = sessions[0]?.name ?? "O cliente";

  const steps: { done: boolean; current: boolean; title: string; body: ReactNode }[] = [
    {
      done: wsConnected,
      current: !wsConnected,
      title: "Servidor no ar",
      body: wsConnected ? (
        <p className="wiz-note">Este navegador está falando com o servidor local.</p>
      ) : (
        <p className="wiz-note">
          Servidor parado? Rode <code>npm start</code> (ou <code>npm run dev</code>) na pasta do projeto.
        </p>
      ),
    },
    {
      done: registered,
      current: wsConnected && !registered,
      title: "Registre o servidor no seu cliente",
      body: (
        <>
          <div className="wiz-clients" role="radiogroup" aria-label="Seu cliente de IA">
            {CLIENTS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={client === item.id}
                className={`chip${client === item.id ? " is-active" : ""}`}
                onClick={() => setClient(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="snippet">
            <pre>
              <code>{code}</code>
            </pre>
            <CopyButton text={code} className="snippet-copy" />
          </div>
          <p className="wiz-note">{note}</p>
          <p className="wiz-note">
            Endereço do servidor: <code>{mcpUrl}</code> <CopyButton text={mcpUrl} label="Copiar URL" />
          </p>
          <button type="button" className="link" onClick={onOpenHelp}>
            Ver todas as opções de cliente
          </button>
          {registered && <p className="wiz-ok">{sessionName} conectou. Agora é no chat.</p>}
        </>
      ),
    },
    {
      done: seated,
      current: registered && !seated,
      title: "Peça a aula no chat",
      body: (
        <>
          <div className="snippet">
            <pre>
              <code>{CHAT_PROMPT}</code>
            </pre>
            <CopyButton text={CHAT_PROMPT} className="snippet-copy" />
          </div>
          {stalled && (
            <p className="wiz-warn">
              A IA está conectada mas ainda não entrou na partida. No chat, diga a frase acima.
            </p>
          )}
        </>
      ),
    },
    {
      done: seated,
      current: false,
      title: "A IA entra na partida",
      body: <p className="wiz-note">Detectamos sozinhos: assim que ela sentar, este painel dá lugar ao caderno.</p>,
    },
  ];

  return (
    <section className="wizard" aria-labelledby="wizard-title">
      <h2 id="wizard-title" className="wizard-title">
        Conecte a professora
      </h2>
      <ol className="wiz-steps">
        {steps.map((step, index) => (
          <li
            key={step.title}
            className={`wiz-step${step.done ? " is-done" : ""}${step.current ? " is-current" : ""}`}
          >
            <span className="wiz-mark" aria-hidden="true">
              {step.done ? "✓" : index + 1}
            </span>
            <div className="wiz-body">
              <h3 className="wiz-head">
                {step.title}
                <span className="sr-only">{step.done ? " — concluído" : step.current ? " — passo atual" : ""}</span>
              </h3>
              {step.body}
            </div>
          </li>
        ))}
      </ol>
      <p className="wiz-alt">
        Prefere assistir IA vs IA ou jogar contra outra pessoa?{" "}
        <button type="button" className="link" onClick={onNewGame}>
          Nova partida
        </button>
      </p>
    </section>
  );
}
