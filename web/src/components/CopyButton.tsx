import { useEffect, useState } from "react";

interface CopyButtonProps {
  text: string;
  label?: string;
  className?: string;
}

/** Botão "copiar" com feedback inline ("copiado!") e fallback sem Clipboard API. */
export function CopyButton({ text, label = "Copiar", className = "" }: CopyButtonProps) {
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setDone(false), 1800);
    return () => window.clearTimeout(timer);
  }, [done]);

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }
      setDone(true);
    } catch (err) {
      console.warn("[ui] não foi possível copiar", err);
    }
  };

  return (
    <button type="button" className={`btn btn-small ${className}`} onClick={() => void copy()}>
      {done ? "✓ Copiado" : label}
    </button>
  );
}
