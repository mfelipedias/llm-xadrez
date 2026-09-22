/**
 * Moldura do tabuleiro (docs/10 §2.5, §5.1): as coordenadas saem de dentro das
 * casas e passam a viver numa faixa ao redor, onde também aparece o rótulo do
 * modo revisão. O tabuleiro em si continua sendo o `Board`.
 */
import type { ReactNode } from "react";
import type { Color } from "@shared/types";

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const RANKS = ["8", "7", "6", "5", "4", "3", "2", "1"];

export interface BoardFrameProps {
  orientation: Color;
  /** "live" = partida em curso; "review" = olhando o histórico; "thinking" = IA pensando. */
  mode: "live" | "review" | "thinking";
  reviewLabel?: string;
  children: ReactNode;
}

export function BoardFrame({ orientation, mode, reviewLabel, children }: BoardFrameProps) {
  const files = orientation === "white" ? FILES : [...FILES].reverse();
  const ranks = orientation === "white" ? RANKS : [...RANKS].reverse();

  return (
    <div className={`board-frame frame-${mode}`}>
      {mode === "review" && reviewLabel && (
        <p className="frame-label" role="status">
          {reviewLabel}
        </p>
      )}
      <div className="frame-grid">
        <div className="frame-ranks" aria-hidden="true">
          {ranks.map((rank) => (
            <span key={rank}>{rank}</span>
          ))}
        </div>
        <div className="frame-board">{children}</div>
        <div className="frame-files" aria-hidden="true">
          {files.map((file) => (
            <span key={file}>{file}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
