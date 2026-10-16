import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { HostDiagnostics, MethodName, ProfileStatus } from '@parley/protocol';
import type { DiagnosticsSaveResult } from '../../shared/bridge.js';
import { processTree as defaultProcessTree, systemSummary as defaultSystemSummary } from './processes.js';
import type { RpcRecord } from './rpc-ring.js';
import { writeZip as defaultWriteZip } from './zip.js';

/** Сколько ждём ответ хоста на один вызов: зависший хост не должен подвесить кнопку (спека A6). */
export const DIAGNOSTICS_CALL_TIMEOUT_MS = 5000;
/** Профили CPU старше суток в архив не кладём (спека A2). */
export const PROFILES_MAX_AGE_MS = 24 * 3600 * 1000;

/** Длина записываемого профиля, когда окно просит «с профилем» (спека A1). */
const PROFILE_SECONDS = 20;
const PROFILE_POLL_MS = 500;
/** Запас сверх длины профиля: хост пишет файл после остановки профилировщика. */
const PROFILE_GRACE_MS = 10_000;
const PROFILE_EXT = '.cpuprofile';

export interface SaveDiagnosticsDeps {
  call: (method: MethodName, params: unknown) => Promise<unknown>;
  recentCalls: () => RpcRecord[];
  /** Каталог хоста `~/.parley/host`: логи, `host.pid`, `diagnostics/`. */
  hostDir: string;
  /** Куда класть архив (`~/Downloads`). */
  outDir: string;
  appInfo: () => Record<string, unknown>;
  readme: string;
  now?: () => Date;
  callTimeoutMs?: number;
  profileSeconds?: number;
  profilePollMs?: number;
  /** Запас сверх длины профиля, после которого ожидание прекращается (по умолчанию `PROFILE_GRACE_MS`). */
  profileGraceMs?: number;
  processTree?: typeof defaultProcessTree;
  systemSummary?: typeof defaultSystemSummary;
  writeZip?: typeof defaultWriteZip;
}

/** Хост не ответил за срок: отличается от отказа хоста, чтобы `host-info.json` не путал «завис» и «не умеет». */
class DiagnosticsTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`no response in ${timeoutMs} ms`);
    this.name = 'DiagnosticsTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Ждёт `promise` не дольше `timeoutMs`; по сроку отклоняет `DiagnosticsTimeoutError`. Если вызов так и не вернулся,
 * его позднее отклонение никем не обрабатывается — гасим, чтобы оно не стало unhandled rejection в main.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  promise.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DiagnosticsTimeoutError(timeoutMs)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Профиль CPU хоста: старт и опрос статуса до `done`/`failed`. Любой сбой (старый хост без метода, обрыв
 * связи, таймаут) тихо кончает ожидание: архив собирается и без профиля.
 */
async function recordProfile(
  deps: SaveDiagnosticsDeps,
  callTimeoutMs: number,
  seconds: number,
  pollMs: number,
): Promise<void> {
  const deadline = Date.now() + seconds * 1000 + (deps.profileGraceMs ?? PROFILE_GRACE_MS);
  try {
    let status = (await withTimeout(deps.call('host.profile.start', { seconds }), callTimeoutMs)) as ProfileStatus;
    while (status.state === 'running' && Date.now() < deadline) {
      await sleep(pollMs);
      status = (await withTimeout(deps.call('host.profile.status', {}), callTimeoutMs)) as ProfileStatus;
    }
  } catch {
    // Профиля нет — остальное содержимое архива от этого не зависит.
  }
}

/**
 * Содержимое `host-info.json`: ответ `host.diagnostics` или причина, по которой его нет — только `timeoutMs`, если
 * хост не ответил за срок, и только `error`, если он отказал. `pid` — из ответа хоста (положительное целое), иначе `null`.
 */
async function hostInfo(
  deps: SaveDiagnosticsDeps,
  callTimeoutMs: number,
): Promise<{ info: Record<string, unknown>; responded: boolean; pid: number | null }> {
  try {
    const result = (await withTimeout(deps.call('host.diagnostics', {}), callTimeoutMs)) as HostDiagnostics;
    const pid = Number.isInteger(result.pid) && result.pid > 0 ? result.pid : null;
    return { info: { responded: true, ...result }, responded: true, pid };
  } catch (error) {
    const reason = error instanceof DiagnosticsTimeoutError ? { timeoutMs: error.timeoutMs } : { error: errorMessage(error) };
    return { info: { responded: false, ...reason }, responded: false, pid: null };
  }
}

/** pid хоста из `host.pid` (первая строка; вторая — время старта процесса); `null`, если файла нет или он не число. */
async function readHostPid(hostDir: string): Promise<number | null> {
  try {
    const text = await readFile(path.join(hostDir, 'host.pid'), 'utf8');
    const pid = Number.parseInt(text.split('\n')[0] ?? '', 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Файлы `*.cpuprofile` каталога профилей хоста, изменённые не раньше `PROFILES_MAX_AGE_MS` назад. */
async function freshProfiles(hostDir: string, now: Date): Promise<string[]> {
  const dir = path.join(hostDir, 'diagnostics');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of names) {
    if (!name.endsWith(PROFILE_EXT)) continue;
    try {
      const info = await stat(path.join(dir, name));
      if (info.isFile() && now.getTime() - info.mtimeMs <= PROFILES_MAX_AGE_MS) files.push(name);
    } catch {
      // Файл исчез между readdir и stat (хост держит только 5 последних) — пропускаем.
    }
  }
  return files.sort();
}

/** `YYYYMMDD-HHMMSS` по локальному времени: так имя совпадает с тем, что человек видит в Finder. */
function stamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * Собирает zip диагностики (спека A2, A6): профиль при `profile`, снимок хоста с таймаутом, дерево
 * процессов хоста, логи с диска потоками и кольцо RPC окна. В архив не попадает ничего, кроме `comm`
 * процессов, версий, счётчиков и длин (приватность, спека A7): тексты сообщений, вывод терминалов,
 * `providers.json`, ключи и окружение сюда не читаются вовсе.
 */
export async function saveDiagnostics(
  deps: SaveDiagnosticsDeps,
  options: { profile: boolean },
): Promise<DiagnosticsSaveResult> {
  const now = deps.now ?? (() => new Date());
  const callTimeoutMs = deps.callTimeoutMs ?? DIAGNOSTICS_CALL_TIMEOUT_MS;
  const processTree = deps.processTree ?? defaultProcessTree;
  const systemSummary = deps.systemSummary ?? defaultSystemSummary;
  const writeZip = deps.writeZip ?? defaultWriteZip;

  if (options.profile) {
    await recordProfile(deps, callTimeoutMs, deps.profileSeconds ?? PROFILE_SECONDS, deps.profilePollMs ?? PROFILE_POLL_MS);
  }

  const { info, responded, pid: reportedPid } = await hostInfo(deps, callTimeoutMs);

  // pid из ответа хоста точнее файла: `host.pid` может остаться от прошлого процесса.
  const pid = reportedPid ?? (await readHostPid(deps.hostDir));
  const processes = pid === null ? 'host.pid: missing' : await processTree([pid]);

  const created = now();
  const profiles = await freshProfiles(deps.hostDir, created);
  const actions = deps.recentCalls().map((record) => JSON.stringify(record));

  await mkdir(deps.outDir, { recursive: true });
  const file = path.join(deps.outDir, `parley-diagnostics-${stamp(created)}.zip`);
  await writeZip(
    file,
    [
      { name: 'README.txt', source: deps.readme },
      { name: 'host.log', source: { file: path.join(deps.hostDir, 'host.log') } },
      { name: 'host.log.1', source: { file: path.join(deps.hostDir, 'host.log.1') } },
      { name: 'host.err', source: { file: path.join(deps.hostDir, 'host.err') } },
      { name: 'host-info.json', source: JSON.stringify(info, null, 2) },
      { name: 'app-info.json', source: JSON.stringify({ ...deps.appInfo(), hostResponded: responded }, null, 2) },
      { name: 'processes.txt', source: `${processes}\n\n${systemSummary()}` },
      { name: 'actions.jsonl', source: actions.length === 0 ? '' : `${actions.join('\n')}\n` },
      ...profiles.map((name) => ({ name, source: { file: path.join(deps.hostDir, 'diagnostics', name) } })),
    ],
    created,
  );

  return { file, hostResponded: responded };
}
