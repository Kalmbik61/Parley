/**
 * Снимок процессов, принадлежащих PTY сессий, для тулбара окна (план
 * `docs/plans/2026-11-09-session-shell-processes-plan.md`, этап A).
 *
 * Один `ps` на тик обслуживает все живые PTY: дерево строится по `ppid`, а не отдельным
 * вызовом на сессию. Наружу уходят только имя исполняемого файла и наблюдаемые метрики;
 * argv, окружение, cwd и полные строки `ps` не покидают модуль (b-030: в argv codex лежит
 * `PARLEY_AGENT_TOKEN`).
 */

import { spawn } from 'node:child_process';
import { byFamily } from '@parley/core';
import { refKey } from '@parley/protocol';
import type { SessionRef } from '@parley/protocol';
import type { Log } from '../log.js';
import type { PtyHandle } from './pty-manager.js';

/**
 * Имя берётся из `ucomm`, не из `comm`: на macOS `comm` отдаёт подменённый `argv[0]` и
 * `process.title` (то есть и токен из `exec -a 'x --token=…'`), `ucomm` — настоящее имя
 * исполняемого файла, до 16 символов с пробелами справа. Архив диагностики
 * (`packages/desktop/src/main/diagnostics/processes.ts`) запрашивает `comm` и держит свой
 * регексп, поэтому `PS_ARGS` хоста и окна различаются намеренно.
 */
export const PS_ARGS = ['-axo', 'pid,ppid,%cpu,%mem,rss,etime,ucomm'] as const;

/** Опрос раз в 2 секунды (решение 2 плана). */
export const POLL_INTERVAL_MS = 2000;

const PS_TIMEOUT_MS = 5000;

/** Шесть колонок до `ucomm`; `ucomm` — остаток строки, в нём бывают пробелы. */
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/;

/** Оболочки: у всех провайдеров, кроме `codex`, команда человека — поддерево первой оболочки (решение 4). */
const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'csh', 'tcsh']);

/**
 * Процесс-команда по решению 4 плана. Остальные процессы дерева — служебные: классификатор проходит
 * сквозь них. У Codex классификация приблизительна (прямой `node`-потомок скрыт, служебные `git`,
 * `zsh` при старте видны).
 */
function isCommandProcess(name: string, provider: string | null): boolean {
  const lower = name.toLowerCase().replace(/^-/, '');
  const shell = SHELLS.has(lower);
  if (provider === null) return shell;
  return byFamily(provider, {
    claude: shell,
    codex: lower !== 'node' && lower !== 'node_repl' && !lower.startsWith('codex'),
    qwen: shell,
    neutral: shell,
  });
}

/** Строка процесса: только безопасные поля, без argv. */
export interface MonitoredProcess {
  pid: number;
  /** `ucomm` без хвостовых пробелов (macOS: до 16 символов). */
  name: string;
  /** `etime` как выдал `ps` (`01:02:03`, `2-03:04:05`): разбор в длительность — дело UI. */
  elapsed: string;
  cpuPct: number | null;
  memPct: number | null;
  rssKb: number | null;
}

/** Снимок процессов одной сессии. `approximate` — классификация неполна (Codex). */
export interface ProcessSnapshot {
  processes: MonitoredProcess[];
  approximate: boolean;
}

interface PsRow {
  pid: number;
  ppid: number;
  cpuPct: number | null;
  memPct: number | null;
  rssKb: number | null;
  elapsed: string;
  name: string;
}

const psNumber = (text: string): number | null => {
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
};

/** Разбор вывода `ps` без заголовка; строки чужого формата пропускаются. */
function parsePsRows(output: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of output.split('\n').slice(1)) {
    const match = PS_ROW.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      cpuPct: psNumber(match[3] as string),
      memPct: psNumber(match[4] as string),
      rssKb: psNumber(match[5] as string),
      elapsed: match[6] as string,
      name: (match[7] as string).trim(),
    });
  }
  return rows;
}

type Listener = (ref: SessionRef, snapshot: ProcessSnapshot | null) => void;

export interface ProcessMonitorDeps {
  log: Log;
  /** Живые PTY на момент тика; пустой список не опрашивается. */
  livePtys: () => PtyHandle[];
  /** Подменяется в тестах. */
  spawn?: typeof spawn;
  intervalMs?: number;
  timeoutMs?: number;
}

export interface ProcessMonitor {
  /**
   * Подписка на снимки сессии; возвращает отписку. `null` в слушателе — опрос не удался (сбой,
   * таймаут, ненулевой код `ps`): данных нет, а не «процессов нет».
   */
  subscribe(ref: SessionRef, listener: Listener): () => void;
  /** Немедленный опрос вне расписания; если опрос уже идёт, ждёт его завершения. */
  refresh(): Promise<void>;
  /** Останавливает опрос, снимает таймер и всех подписчиков. */
  stop(): void;
}

/**
 * Опрашивает `ps` одним вызовом на тик и рассылает подписчикам снимок процессов-команд их PTY.
 * Таймер один на всех и только пока есть подписчики: последний ушёл — таймер снят.
 */
export function createProcessMonitor(deps: ProcessMonitorDeps): ProcessMonitor {
  const spawnFn = deps.spawn ?? spawn;
  const intervalMs = deps.intervalMs ?? POLL_INTERVAL_MS;
  const timeoutMs = deps.timeoutMs ?? PS_TIMEOUT_MS;

  const listeners = new Map<string, Map<Listener, SessionRef>>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Идущий опрос: он же единственный путь к `ps` — второго параллельного не бывает. */
  let inFlight: Promise<void> | null = null;

  const subscriberCount = (): number => {
    let total = 0;
    for (const perRef of listeners.values()) total += perRef.size;
    return total;
  };

  function clearTimer(): void {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  }

  /**
   * Следующий тик ставится только когда нет ни таймера, ни идущего опроса и есть подписчики: цепочка
   * одна, пауза отсчитывается от конца опроса.
   */
  function schedule(): void {
    if (timer !== null || inFlight !== null || subscriberCount() === 0) return;
    timer = setTimeout(() => {
      timer = null;
      void pollNow();
    }, intervalMs);
    timer.unref?.();
  }

  /** Опрос сейчас: идущий не дублируется, ожидающий тик заменяется. */
  function pollNow(): Promise<void> {
    if (inFlight !== null) return inFlight;
    clearTimer();
    inFlight = poll()
      .catch((error: unknown) => {
        deps.log.warn('монитор процессов: опрос упал', { error: String(error) });
      })
      .finally(() => {
        inFlight = null;
        schedule();
      });
    return inFlight;
  }

  /**
   * Запускает `ps` и возвращает его вывод; сбой, таймаут или ненулевой код — `null`, а не
   * исключение и не пустая строка: пустой вывод означал бы «процессов нет» (решение 6 плана).
   * `LC_ALL=C`: в локали ru_RU `%cpu` приходит как `0,4`, и число не разбирается.
   */
  function runPs(): Promise<string | null> {
    return new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawnFn('ps', [...PS_ARGS], {
          stdio: ['ignore', 'pipe', 'ignore'],
          env: { ...process.env, LC_ALL: 'C' },
        });
      } catch (error) {
        deps.log.warn('монитор процессов: не удалось запустить ps', { error: String(error) });
        resolve(null);
        return;
      }

      let settled = false;
      const settle = (text: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(psTimer);
        resolve(text);
      };
      const psTimer = setTimeout(() => {
        child.kill();
        deps.log.warn('монитор процессов: ps не ответил вовремя', { timeoutMs });
        settle(null);
      }, timeoutMs);

      let output = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        output += chunk;
      });
      child.on('error', (error) => {
        deps.log.warn('монитор процессов: ps завершился с ошибкой', { error: error.message });
        settle(null);
      });
      child.on('close', (code) => {
        if (code === 0) settle(output);
        else {
          deps.log.warn('монитор процессов: ps вернул ненулевой код', { code });
          settle(null);
        }
      });
    });
  }

  /**
   * Процессы-команды под корнем PTY: обход идёт сквозь служебные процессы, а первый процесс-команда
   * берётся вместе со всем своим поддеревом. Сам корень не включается.
   */
  function commandsUnder(rows: readonly PsRow[], root: number, provider: string | null): PsRow[] {
    const childrenOf = new Map<number, PsRow[]>();
    for (const row of rows) {
      const siblings = childrenOf.get(row.ppid);
      if (siblings) siblings.push(row);
      else childrenOf.set(row.ppid, [row]);
    }

    const seen = new Set<number>([root]);
    const found: PsRow[] = [];
    const walk = (pid: number, inCommand: boolean): void => {
      for (const child of childrenOf.get(pid) ?? []) {
        if (seen.has(child.pid)) continue;
        seen.add(child.pid);
        const included = inCommand || isCommandProcess(child.name, provider);
        if (included) found.push(child);
        walk(child.pid, included);
      }
    };
    walk(root, false);
    return found;
  }

  const watched = (handles: readonly PtyHandle[]): boolean =>
    handles.some((handle) => (listeners.get(refKey(handle.ref))?.size ?? 0) > 0);

  async function poll(): Promise<void> {
    if (!watched(deps.livePtys())) return;

    const output = await runPs();
    // Живые PTY читаются заново: вышедший, пока шёл `ps`, снимка уже не получает.
    const handles = deps.livePtys();
    const rows = output === null ? null : parsePsRows(output);
    for (const handle of handles) {
      const perRef = listeners.get(refKey(handle.ref));
      if (perRef === undefined || perRef.size === 0) continue;

      const snapshot: ProcessSnapshot | null =
        rows === null
          ? null
          : {
              processes: commandsUnder(rows, handle.pid, handle.provider)
                .map((row): MonitoredProcess => ({
                  pid: row.pid,
                  name: row.name,
                  elapsed: row.elapsed,
                  cpuPct: row.cpuPct,
                  memPct: row.memPct,
                  rssKb: row.rssKb,
                }))
                .sort((a, b) => a.pid - b.pid),
              approximate: handle.provider === 'codex',
            };
      for (const [listener, ref] of Array.from(perRef)) listener(ref, snapshot);
    }
  }

  return {
    subscribe(ref, listener) {
      const key = refKey(ref);
      let perRef = listeners.get(key);
      if (perRef === undefined) {
        perRef = new Map();
        listeners.set(key, perRef);
      }
      perRef.set(listener, ref);
      schedule();

      return () => {
        const current = listeners.get(key);
        if (current !== undefined) {
          current.delete(listener);
          if (current.size === 0) listeners.delete(key);
        }
        if (subscriberCount() === 0) clearTimer();
      };
    },

    refresh: () => pollNow(),

    stop() {
      clearTimer();
      listeners.clear();
    },
  };
}
