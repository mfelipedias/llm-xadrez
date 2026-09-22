import { Modal } from "./Modal";
import { CopyButton } from "./CopyButton";

interface ConnectHelpProps {
  mcpUrl: string;
  onClose: () => void;
  /** Abre a tela de provedores; ausente quando o servidor não tem bots (docs/09 §4.3). */
  onOpenProviders?: () => void;
}

export function ConnectHelp({ mcpUrl, onClose, onOpenProviders }: ConnectHelpProps) {
  const claudeCode = `claude mcp add --transport http xadrez ${mcpUrl}`;
  const claudeDesktop = JSON.stringify(
    {
      mcpServers: {
        xadrez: {
          command: "npx",
          args: ["-y", "mcp-remote", mcpUrl, "--allow-http"],
        },
      },
    },
    null,
    2,
  );
  const generic = `npx -y mcp-remote ${mcpUrl} --allow-http`;

  return (
    <Modal title="Como conectar uma IA" onClose={onClose} wide>
      <p className="help-intro">
        Qualquer cliente MCP pode jogar. O endpoint deste servidor é <code>{mcpUrl}</code>{" "}
        <CopyButton text={mcpUrl} label="Copiar URL" />. Depois de conectar, diga no chat:{" "}
        <em>“vamos jogar xadrez, eu de brancas, me ensine”</em>.
      </p>

      <section className="help-section">
        <h3>Claude Code (CLI)</h3>
        <p>Em qualquer pasta, registre o servidor e use <code>/mcp</code> para conferir a conexão:</p>
        <Snippet code={claudeCode} />
        <p className="help-note">Dica: em <code>/mcp → xadrez</code> existe o prompt <code>chess_teacher</code>, que já instrui a IA a dar aula.</p>
      </section>

      <section className="help-section">
        <h3>Claude Desktop</h3>
        <p>
          Opção A: Settings → Connectors → <em>Add custom connector</em> com a URL acima. Se o app recusar URL local,
          use a ponte <code>mcp-remote</code> em <code>claude_desktop_config.json</code>{" "}
          (<code>%APPDATA%\Claude\claude_desktop_config.json</code> no Windows) e reinicie o app:
        </p>
        <Snippet code={claudeDesktop} />
      </section>

      <section className="help-section">
        <h3>Outros clientes (Cursor, Windsurf, Cline, Continue…)</h3>
        <p>
          Clientes com suporte a MCP remoto/HTTP: use a URL <code>{mcpUrl}</code> diretamente. Clientes só-stdio: use a
          ponte abaixo como comando do servidor.
        </p>
        <Snippet code={generic} />
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
          que está esperando, você é as pretas”. Você assiste aqui e pode mandar perguntas para cada uma.
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
