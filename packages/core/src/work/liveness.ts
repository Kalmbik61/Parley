/**
 * Живость сессии: жив ли процесс агента и тот ли это процесс (дизайн TUI v2,
 * раздел 5.4). Нужна после перезапуска харнесса, когда PTY-детей у него нет, и
 * по событию watcher, чтобы поймать процесс, убитый снаружи.
 *
 * Проверяем по паре `pid` + время старта процесса из ОС: один pid ОС
 * переиспользует, и без второго признака чужой процесс сошёл бы за нашего
 * (раздел 10). Таймера здесь нет — вызывающий сам решает, когда сверяться.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { DEFAULT_CONFIG } from '../config.js';
import { finishSession, readSessionMetrics, silenceMs, type MetricsRoots } from './metrics.js';
import { readMap } from './store.js';
import type { WorkSession } from './types.js';

const run = promisify(execFile);

/** Допуск на расхождение записанного и настоящего времени старта процесса. */
export const START_TOLERANCE_MS = 2000;

/**
 * Во сколько раз молчание лога должно превысить порог `activity`, чтобы сессию
 * без pid считать завершившейся (раздел 5.4): у неё нет второго признака жизни,
 * и торопиться с приговором нельзя.
 */
const DEAD_SILENCE_FACTOR = 10;

/** Тики ядра в секунде: `USER_HZ` на Linux практически всегда 100. */
const USER_HZ = 100;

/** Жив ли процесс. `EPERM` — процесс есть, просто он не наш. */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** macOS: `ps` печатает локальное время старта с точностью до секунды. */
async function startedAtBsd(pid: number): Promise<string | null> {
  const { stdout } = await run('ps', ['-o', 'lstart=', '-p', String(pid)]);
  const at = new Date(stdout.trim());
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** Linux: 22-е поле `/proc/<pid>/stat` — тики от загрузки, `btime` — её момент. */
async function startedAtLinux(pid: number): Promise<string | null> {
  const [raw, boot] = await Promise.all([
    readFile(`/proc/${pid}/stat`, 'utf8'),
    readFile('/proc/stat', 'utf8'),
  ]);
  // Имя команды в скобках может содержать пробелы и скобки — режем по последней.
  const fields = raw
    .slice(raw.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/);
  const ticks = Number(fields[19]);
  const btime = Number(/^btime (\d+)$/m.exec(boot)?.[1]);
  if (!Number.isFinite(ticks) || !Number.isFinite(btime)) return null;
  return new Date((btime + ticks / USER_HZ) * 1000).toISOString();
}

/**
 * Время старта процесса по данным ОС. `null` — процесса нет или система такого
 * не рассказывает; тогда сверять нечего и расхождением это не считается.
 */
export async function processStartedAt(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'linux') return await startedAtLinux(pid);
    if (process.platform === 'darwin') return await startedAtBsd(pid);
    return null;
  } catch {
    return null;
  }
}

export interface Liveness {
  alive: boolean;
}

export interface LivenessOptions {
  now?: number;
  /** Порог молчания лога из настроек: сессия без pid живёт до него × 10. */
  silenceThresholdMs?: number;
  /** Время последней записи лога — единственная ось живости сессии без pid. */
  lastRecordAt?: string | null;
}

/**
 * Жива ли сессия. У сессии с pid ответ точный; у сессии без pid (её поднимала
 * напечатанная команда CLI) — по молчанию лога, а если лога нет вовсе, по
 * времени старта: иначе такая запись осталась бы `active` навсегда.
 */
export async function checkSession(
  session: WorkSession,
  {
    now = Date.now(),
    silenceThresholdMs = DEFAULT_CONFIG.silenceThresholdMs,
    lastRecordAt = null,
  }: LivenessOptions = {},
): Promise<Liveness> {
  if (session.pid === null) {
    const silence = silenceMs(lastRecordAt ?? session.startedAt, now);
    return { alive: silence === null || silence <= silenceThresholdMs * DEAD_SILENCE_FACTOR };
  }
  if (!isAlive(session.pid)) return { alive: false };

  const actual = await processStartedAt(session.pid);
  const expected = session.startedAtProcess;
  if (actual === null || expected === null) return { alive: true };
  const diff = Math.abs(Date.parse(actual) - Date.parse(expected));
  return { alive: Number.isNaN(diff) || diff <= START_TOLERANCE_MS };
}

export interface ReconcileOptions extends MetricsRoots {
  now?: number;
  silenceThresholdMs?: number;
}

/** Время последней записи лога сессии; `null` — лога такого провайдера мы не читаем. */
async function lastRecordOf(session: WorkSession, roots: MetricsRoots): Promise<string | null> {
  if (session.providerSessionId === null) return null;
  const live = await readSessionMetrics(session.provider, session.providerSessionId, roots);
  return live?.lastRecordAt ?? null;
}

/**
 * Сверяет все `active` сессии работы с состоянием ОС и переводит мёртвые в
 * `exited` (харнесс процесс не ждал, и код выхода в записи `history` — `null`).
 * Возвращает id тех, кого перевела. Вызывается при старте харнесса и по
 * событию watcher, но не по таймеру (раздел 8.2).
 */
export async function reconcileMap(
  projectPath: string,
  workId: string,
  {
    now = Date.now(),
    silenceThresholdMs = DEFAULT_CONFIG.silenceThresholdMs,
    ...roots
  }: ReconcileOptions = {},
): Promise<string[]> {
  const map = await readMap(projectPath, workId);
  const dead: string[] = [];

  for (const session of map.sessions) {
    if (session.status !== 'active') continue;
    // Лог читаем только там, где он и решает: у сессии с pid ответ даёт ОС.
    const lastRecordAt = session.pid === null ? await lastRecordOf(session, roots) : null;
    const { alive } = await checkSession(session, { now, silenceThresholdMs, lastRecordAt });
    if (!alive) dead.push(session.id);
  }

  const at = new Date(now).toISOString();
  for (const id of dead) {
    await finishSession(projectPath, workId, id, 'exited', { at, exitCode: null, ...roots });
  }
  return dead;
}
