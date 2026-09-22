/**
 * Sons sintetizados com Web Audio (sem arquivos de áudio).
 * Ligado por padrão; preferência em localStorage; só toca depois da primeira
 * interação do usuário (regra de autoplay dos navegadores).
 */
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "llm-xadrez.sound";

/**
 * `comment` e `join` nasceram na Fase 4 (docs/10 §4): o "tique" de comentário
 * novo e o "entrou" de assento ocupado. Os dois são discretos de propósito —
 * numa partida IA vs IA eles tocam muitas vezes.
 */
export type SoundKind = "move" | "capture" | "check" | "end" | "comment" | "join";

let context: AudioContext | null = null;
let unlocked = false;
const listeners = new Set<() => void>();

function readPreference(): boolean {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === null ? true : value === "1";
  } catch {
    return true;
  }
}

let enabled = readPreference();

function unlock(): void {
  unlocked = true;
  if (!context) {
    try {
      context = new AudioContext();
    } catch {
      context = null;
    }
  }
  if (context && context.state === "suspended") {
    void context.resume();
  }
}

window.addEventListener("pointerdown", unlock, { once: true, passive: true });
window.addEventListener("keydown", unlock, { once: true });

export function isSoundEnabled(): boolean {
  return enabled;
}

export function setSoundEnabled(value: boolean): void {
  enabled = value;
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
  } catch {
    /* localStorage indisponível: preferência só nesta sessão */
  }
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Hook: [ligado, alternar]. */
export function useSoundPreference(): [boolean, () => void] {
  const value = useSyncExternalStore(subscribe, isSoundEnabled, isSoundEnabled);
  return [value, () => setSoundEnabled(!enabled)];
}

interface Tone {
  frequencyFrom: number;
  frequencyTo?: number;
  duration: number;
  delay?: number;
  type?: OscillatorType;
  gain?: number;
}

function playTones(tones: Tone[]): void {
  if (!context) return;
  const ctx = context;
  const now = ctx.currentTime;
  for (const tone of tones) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const start = now + (tone.delay ?? 0);
    const end = start + tone.duration;
    osc.type = tone.type ?? "sine";
    osc.frequency.setValueAtTime(tone.frequencyFrom, start);
    if (tone.frequencyTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, tone.frequencyTo), end);
    }
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(tone.gain ?? 0.25, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(end + 0.02);
  }
}

export function playSound(kind: SoundKind): void {
  if (!enabled || !unlocked || !context) return;
  if (context.state === "suspended") {
    void context.resume();
  }
  switch (kind) {
    case "move":
      playTones([{ frequencyFrom: 720, frequencyTo: 240, duration: 0.07, type: "triangle", gain: 0.3 }]);
      break;
    case "capture":
      playTones([
        { frequencyFrom: 380, frequencyTo: 90, duration: 0.13, type: "square", gain: 0.18 },
        { frequencyFrom: 900, frequencyTo: 300, duration: 0.05, type: "triangle", gain: 0.15 },
      ]);
      break;
    case "check":
      playTones([
        { frequencyFrom: 880, duration: 0.09, type: "sine", gain: 0.25 },
        { frequencyFrom: 1175, duration: 0.14, delay: 0.1, type: "sine", gain: 0.25 },
      ]);
      break;
    case "end":
      playTones([
        { frequencyFrom: 523.25, duration: 0.7, type: "sine", gain: 0.18 },
        { frequencyFrom: 659.25, duration: 0.7, delay: 0.05, type: "sine", gain: 0.16 },
        { frequencyFrom: 783.99, duration: 0.8, delay: 0.1, type: "sine", gain: 0.16 },
      ]);
      break;
    // "tique" de comentário novo: curto e baixo, para não competir com o lance.
    case "comment":
      playTones([{ frequencyFrom: 1320, frequencyTo: 990, duration: 0.045, type: "sine", gain: 0.12 }]);
      break;
    // "entrou": dois tons subindo, o oposto do som de saída.
    case "join":
      playTones([
        { frequencyFrom: 392, duration: 0.09, type: "triangle", gain: 0.16 },
        { frequencyFrom: 587.33, duration: 0.12, delay: 0.08, type: "triangle", gain: 0.16 },
      ]);
      break;
  }
}
