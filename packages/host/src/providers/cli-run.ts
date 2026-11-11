/**
 * Общий запуск установщиков и обновлений CLI провайдеров (спека 2026-11-11, §4.2 п. 3 и 5): дочерний процесс без
 * shell и без pty лидером своей группы, таймаут с убийством всей группы, хвост вывода, остановка вместе с хостом,
 * один на CLI флаг занятости, общий для обновления и установки, и политика окружения установщика.
 */

import { spawn } from 'node:child_process';
import { agentEnv, type CliTool } from '@parley/core';

/** Сколько последних байт вывода (stdout и stderr вместе) уходит в ответ и журнал. */
export const CLI_RUN_OUTPUT_BYTES = 4096;

export interface CliExit {
  code: number | null;
  output: string;
  timedOut: boolean;
}

export interface CliRun {
  /** Один дочерний процесс: без shell, stdin закрыт, от вывода хранится только хвост. */
  exec(binary: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<CliExit>;
  /**
   * Работа с CLI под флагом занятости: пока идёт одна (обновление или установка этого CLI), другая сразу получает
   * `busy`. Флаг ставится синхронно в момент вызова и снимается по завершении работы, в том числе по исключению.
   */
  exclusive<T>(tool: CliTool, work: () => Promise<T>): Promise<T | { state: 'busy' }>;
  /** Остановка хоста: идущие процессы убиваются целыми группами, новые после этого не запускаются. */
  stop(): void;
}

/** Окружение обновления: без меток родительской сессии и без унаследованных меток способа установки Codex. */
export function cliEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = agentEnv(env);
  for (const name of Object.keys(clean)) {
    if (name.startsWith('CODEX_MANAGED_BY_') || name === 'CODEX_MANAGED_PACKAGE_ROOT') delete clean[name];
  }
  return clean;
}

/** Переменные запуска оболочки и внедрения в рантайм, которые установщик не наследует (§4.2 п. 3). */
const INJECTION_NAMES = new Set(['BASH_ENV', 'ENV', 'PROMPT_COMMAND', 'NODE_OPTIONS', 'NODE_PATH']);
const INJECTION_PREFIXES = ['npm_config_', 'NPM_CONFIG_', 'npm_package_'];

/**
 * Окружение установщика и npm-обновления: `cliEnv` без переменных внедрения. Прокси и CA (`HTTP(S)_PROXY`,
 * `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`) остаются намеренно.
 */
export function installerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = cliEnv(env);
  for (const name of Object.keys(clean)) {
    if (INJECTION_NAMES.has(name) || INJECTION_PREFIXES.some((prefix) => name.startsWith(prefix))) delete clean[name];
  }
  return clean;
}

/** SIGKILL всей группе процессов `pid` (установщик и его потомки); группы уже нет — не ошибка (ESRCH; на macOS ещё EPERM для пустой группы или группы из зомби). */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH' && code !== 'EPERM') throw error;
  }
}

/** Сколько ждать хвост вывода после выхода процесса, прежде чем закрыть трубы силой. */
const DRAIN_MS = 100;

/**
 * Процесс стартует лидером своей группы (`detached`): установщик запускает потомков, и убить надо всю группу — иначе
 * потомок, держащий трубы, оставил бы вызов висеть, а установку идущей. По таймауту — SIGKILL группе; итог по `exit`,
 * не по `close`; после выхода группа добивается (хвосты установщика), трубы закрываются.
 */
function exec(binary: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number, groups: Set<number>): Promise<CliExit> {
  return new Promise((resolve) => {
    let tail = Buffer.alloc(0);
    let timedOut = false;
    let settled = false;
    let drain: NodeJS.Timeout | undefined;
    const finish = (code: number | null, note = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (drain !== undefined) clearTimeout(drain);
      if (child.pid !== undefined) groups.delete(child.pid);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ code, output: tail.toString('utf8') + note, timedOut });
    };
    const child = spawn(binary, [...args], { shell: false, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: true });
    if (child.pid !== undefined) groups.add(child.pid);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, timeoutMs);
    const collect = (chunk: Buffer): void => {
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > CLI_RUN_OUTPUT_BYTES) tail = tail.subarray(tail.length - CLI_RUN_OUTPUT_BYTES);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => finish(null, `\n${error.message}`));
    child.on('exit', (code) => {
      // Потомки установщика, ещё живые в группе, — тоже конец установки; без них трубы закроются и хвост дочитается.
      killGroup(child.pid);
      drain = setTimeout(() => finish(code), DRAIN_MS);
    });
    child.on('close', (code) => finish(code));
  });
}

export function createCliRun(): CliRun {
  const running = new Set<CliTool>();
  /** Группы живых процессов (`pid` лидера): их добивает `stop()`. */
  const groups = new Set<number>();
  let stopped = false;
  return {
    // Установщик, скачанный уже после остановки хоста, не стартует: процесс пережил бы хост.
    exec: (binary, args, env, timeoutMs) =>
      stopped ? Promise.resolve({ code: null, output: 'The host is stopping; nothing was started.', timedOut: false }) : exec(binary, args, env, timeoutMs, groups),
    async exclusive(tool, work) {
      if (running.has(tool)) return { state: 'busy' };
      running.add(tool);
      try {
        return await work();
      } finally {
        running.delete(tool);
      }
    },
    stop() {
      stopped = true;
      for (const pid of [...groups]) killGroup(pid);
    },
  };
}
