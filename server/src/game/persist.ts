/**
 * Persistência em DATA_DIR: `current-game.json` (debounce 100 ms) e `games/<id>.pgn`
 * quando uma partida com ≥ 2 lances termina ou é substituída.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { GameState } from "../../../shared/types.js";
import type { ArchiveEvent, GameStore } from "./store.js";
import { createLogger } from "../log.js";

const log = createLogger("store");

export interface GameSummary {
  id: string;
  date: string;
  white: string;
  black: string;
  result: string;
}

export interface Persistence {
  /** Grava imediatamente o que estiver pendente (shutdown). */
  flush(): Promise<void>;
  listGames(): GameSummary[];
  readGamePgn(id: string): string | null;
  detach(): void;
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export function parsePgnHeaders(pgn: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const re = /^\[(\w+)\s+"([^"]*)"\]/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pgn)) !== null) headers[m[1]] = m[2];
  return headers;
}

export function attachPersistence(store: GameStore, dataDir: string, opts: { debounceMs?: number } = {}): Persistence {
  const debounceMs = opts.debounceMs ?? 100;
  const gamesDir = path.join(dataDir, "games");
  const currentFile = path.join(dataDir, "current-game.json");
  fs.mkdirSync(gamesDir, { recursive: true });

  // Carrega a partida salva, se houver.
  if (fs.existsSync(currentFile)) {
    try {
      const raw = fs.readFileSync(currentFile, "utf8");
      const saved = JSON.parse(raw) as GameState;
      store.loadState(saved);
      log.info(`partida restaurada de ${currentFile} (${saved.ply} meio-lances)`);
    } catch (err) {
      log.warn(`não foi possível restaurar ${currentFile}: ${(err as Error).message}`);
    }
  }

  let timer: NodeJS.Timeout | null = null;
  let dirty = false;
  let writing: Promise<void> = Promise.resolve();

  const writeNow = (): Promise<void> => {
    dirty = false;
    const state = store.getState();
    const json = JSON.stringify(state, null, 2);
    const tmp = `${currentFile}.tmp`;
    writing = writing
      .then(async () => {
        await fsp.writeFile(tmp, json, "utf8");
        await fsp.rename(tmp, currentFile);
      })
      .catch((err: unknown) => {
        log.error(`falha ao salvar ${currentFile}: ${(err as Error).message}`);
      });
    return writing;
  };

  const onChange = (): void => {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void writeNow();
    }, debounceMs);
  };

  const onArchive = (ev: ArchiveEvent): void => {
    const id = SAFE_ID.test(ev.id) ? ev.id : ev.id.replace(/[^A-Za-z0-9_-]/g, "_");
    const file = path.join(gamesDir, `${id}.pgn`);
    try {
      fs.writeFileSync(file, `${ev.pgn.trim()}\n`, "utf8");
      log.info(`PGN arquivado em ${file}`);
    } catch (err) {
      log.error(`falha ao arquivar PGN em ${file}: ${(err as Error).message}`);
    }
  };

  store.on("change", onChange);
  store.on("archive", onArchive);

  return {
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (dirty) await writeNow();
      else await writing;
    },
    listGames() {
      let files: string[] = [];
      try {
        files = fs.readdirSync(gamesDir).filter((f) => f.toLowerCase().endsWith(".pgn"));
      } catch {
        return [];
      }
      const out: GameSummary[] = [];
      for (const f of files) {
        try {
          const pgn = fs.readFileSync(path.join(gamesDir, f), "utf8");
          const h = parsePgnHeaders(pgn);
          out.push({
            id: f.slice(0, -4),
            date: h.Date ?? "",
            white: h.White ?? "?",
            black: h.Black ?? "?",
            result: h.Result ?? "*",
          });
        } catch {
          /* ignora arquivo ilegível */
        }
      }
      return out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    },
    readGamePgn(id: string) {
      if (!SAFE_ID.test(id)) return null;
      const file = path.join(gamesDir, `${id}.pgn`);
      try {
        return fs.readFileSync(file, "utf8");
      } catch {
        return null;
      }
    },
    detach() {
      store.off("change", onChange);
      store.off("archive", onArchive);
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
