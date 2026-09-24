/**
 * "Como conectar uma IA": todas as opções de cliente MCP, com os snippets do
 * runtime atual (Docker ou Node) e do modo de autenticação (`mcpAuth`). Texto
 * de referência: docs/05-conectar-clientes.md.
 */
import type { GameState, ServerInfo } from "@shared/types";
import {
  chatPrompt,
  claudeCodeSnippet,
  claudeDesktopSnippet,
  codexSnippet,
  connectContext,
  cursorSnippet,
  mcpRemoteSnippet,
  publicConnectorUrl,
  TOKEN_PLACEHOLDER,
  tunnelSnippet,
} from "../connect";
import { Modal } from "./Modal";
import { CopyButton } from "./CopyButton";

interface ConnectHelpProps {
  server: ServerInfo | null;
  state?: GameState | null;
  onClose: () => void;
  /** Abre a tela de provedores; ausente quando o servidor não tem bots (docs/09 §4.3). */
  onOpenProviders?: () => void;
}

export function ConnectHelp({ server, state = null, onClose, onOpenProviders }: ConnectHelpProps) {
  const ctx = connectContext(server);
  const { mcpUrl } = ctx;
  const prompt = chatPrompt(state);

  return (
    <Modal title="Como conectar uma IA" onClose={onClose} wide>
      <p className="help-intro">
        Qualquer cliente MCP pode jogar. O endpoint deste servidor é <code>{mcpUrl}</code>{" "}
        <CopyButton text={mcpUrl} label="Copiar URL" />. Depois de conectar, diga no chat: <em>“{prompt}”</em>.
      </p>

      {ctx.token && (
        <p className="help-note cost-warning">
          Este servidor exige token (<code>MCP_TOKEN</code>). Esta página não conhece o valor — ele está no{" "}
          <code>.env</code> do servidor. Nos exemplos, troque <code>{TOKEN_PLACEHOLDER}</code> por ele. Clientes que
          mandam header usam <code>Authorization: Bearer</code>; os que não mandam, <code>?token=</code> na URL.
        </p>
      )}

      <section className="help-section">
        <h3>Claude Code (CLI)</h3>
        <p>
          Em qualquer pasta (<code>-s user</code> registra para todas), rode o comando e confira com <code>/mcp</code>:
        </p>
        <Snippet code={claudeCodeSnippet(ctx)} />
        <p className="help-note">
          Dica: em <code>/mcp → xadrez</code> existe o prompt <code>chess_teacher</code>, que já instrui a IA a dar aula.
        </p>
      </section>

      <section className="help-section">
        <h3>Claude Desktop</h3>
        <p>
          Use a ponte <code>mcp-remote</code> em <code>claude_desktop_config.json</code> (Settings → Developer → Edit
          Config; no Windows fica em <code>%APPDATA%\Claude\</code>) e reinicie o app:
        </p>
        <Snippet code={claudeDesktopSnippet(ctx)} />
        <p className="help-note">
          <strong>“Add custom connector” não serve para localhost:</strong> o conector customizado do Claude Desktop e
          do Claude.ai é chamado a partir da nuvem da Anthropic, não do seu computador. Ele só funciona com uma URL
          pública <code>https</code> (túnel, abaixo).
        </p>
      </section>

      <section className="help-section">
        <h3>Claude.ai (web e celular) e ChatGPT (modo desenvolvedor)</h3>
        <p>
          Os dois chamam o servidor da nuvem, então precisam de uma <strong>URL pública HTTPS</strong> e de um token.
          Como não mandam header, o token vai na própria URL:
        </p>
        {!ctx.publicUrl && <Snippet code={tunnelSnippet(ctx)} />}
        <p>
          {ctx.publicUrl ? "Use" : "Depois, use"} esta URL no conector (autenticação: nenhuma / “No auth”):
        </p>
        <Snippet code={publicConnectorUrl(ctx)} />
        <p className="help-note">
          Claude.ai: Settings → Connectors → Add custom connector. ChatGPT: Settings → Apps &amp; Connectors → Advanced
          settings → Developer mode → Create. Enquanto o túnel estiver aberto, a interface web também fica acessível por
          ele — feche-o ao terminar.
        </p>
      </section>

      <section className="help-section">
        <h3>OpenAI Codex (CLI e app)</h3>
        <p>
          <code>tool_timeout_sec</code> precisa passar dos 25 s do <code>wait_for_turn</code>:
        </p>
        <Snippet code={codexSnippet(ctx)} />
      </section>

      <section className="help-section">
        <h3>Jan, Cursor e outros (Windsurf, Cline, Continue…)</h3>
        <p>
          Com MCP por HTTP, use a URL <code>{mcpUrl}</code> direto (no Jan: Settings → MCP Servers → tipo HTTP). Formato
          do Cursor (<code>~/.cursor/mcp.json</code>):
        </p>
        <Snippet code={cursorSnippet(ctx)} />
        <p>Clientes só-stdio usam a ponte como comando do servidor:</p>
        <Snippet code={mcpRemoteSnippet(ctx)} />
      </section>

      {onOpenProviders && (
        <section className="help-section">
          <h3>Ou deixe o servidor jogar</h3>
          <p>
            Em vez de conectar um cliente, o próprio servidor pode falar com um provedor de LLM (OpenRouter, Ollama,
            LM Studio, Anthropic…) e ocupar o assento como <strong>bot</strong>. A chave de API fica no{" "}
            <code>.env</code> do servidor e nunca passa por esta tela.{" "}
            <button type="button" className="link" onClick={onOpenProviders}>
              Configurar provedores
            </button>
            .
          </p>
        </section>
      )}

      <section className="help-section">
        <h3>Duas IAs na mesma partida</h3>
        <p>
          No chat A: “crie uma partida de xadrez de brancas contra outra IA”. No chat B: “entre na partida de xadrez
          que está esperando (join_game), você é as pretas”. Você assiste aqui e pode mandar perguntas para cada uma.
        </p>
      </section>
    </Modal>
  );
}

function Snippet({ code }: { code: string }) {
  return (
    <div className="snippet">
      <pre>
        <code>{code}</code>
      </pre>
      <CopyButton text={code} className="snippet-copy" />
    </div>
  );
}
