/**
 * Markdown mínimo, implementado à mão (sem dependências):
 * negrito (**x**), itálico (*x* ou _x_), código inline (`x`), listas (-, *, 1.).
 * Nunca usa innerHTML: tudo vira nós React.
 */
import type { ReactNode } from "react";

const INLINE_PATTERN = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_)/g;

export function renderInline(text: string): ReactNode[] {
  const parts = text.split(INLINE_PATTERN);
  return parts.map((part, i) => {
    if (!part) return null;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={i}>{part.slice(1, -1)}</code>;
    }
    if (
      ((part.startsWith("*") && part.endsWith("*")) || (part.startsWith("_") && part.endsWith("_"))) &&
      part.length > 2
    ) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    return <span key={i}>{part}</span>;
  });
}

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "ul" | "ol"; items: string[] };

const UL_PATTERN = /^\s*[-*•]\s+(.*)$/;
const OL_PATTERN = /^\s*\d+[.)]\s+(.*)$/;

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  const flush = () => {
    if (current) blocks.push(current);
    current = null;
  };

  for (const rawLine of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    const ul = UL_PATTERN.exec(line);
    const ol = ul ? null : OL_PATTERN.exec(line);
    if (ul || ol) {
      const kind = ul ? "ul" : "ol";
      const item = (ul ?? ol)?.[1] ?? "";
      if (current && current.kind === kind) {
        current.items.push(item);
      } else {
        flush();
        current = { kind, items: [item] };
      }
      continue;
    }
    if (current && current.kind === "p") {
      current.lines.push(line.trim());
    } else {
      flush();
      current = { kind: "p", lines: [line.trim()] };
    }
  }
  flush();
  return blocks;
}

export function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="md">
      {blocks.map((block, i) => {
        if (block.kind === "p") {
          return <p key={i}>{renderInline(block.lines.join(" "))}</p>;
        }
        const items = block.items.map((item, j) => <li key={j}>{renderInline(item)}</li>);
        return block.kind === "ul" ? <ul key={i}>{items}</ul> : <ol key={i}>{items}</ol>;
      })}
    </div>
  );
}
