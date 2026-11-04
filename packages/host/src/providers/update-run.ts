/**
 * Обновление CLI провайдера из Parley (спека 2026-11-02, раздел 4): хост запускает `<бинарь> update` — тот же
 * абсолютный путь, что запускает Parley, — дочерним процессом без pty и без shell. Способ обновления выбирает сам
 * CLI. Работающие сессии не трогаются: они остаются на старом бинаре до перезапуска. Настоящий `update` в тестах не
 * запускается никогда — только скрипт-заглушка во временной папке.
 */

import { spawn } from 'node:child_process';
import { agentEnv, findRunnerBinary, isNewer } from '@parley/core';
import type { Log } from '../log.js';
import type { CliUpdates, UpdateCommand } from './updates.js';
import { UPDATE_COMMANDS } from './updates.js';
import type { ProviderVersions } from './versions.js';

export const CLI_UPDATE_TIMEOUT_MS = 5 * 60 * 1000;
export const CLI_SMOKE_TIMEOUT_MS = 5000;
/** Сколько последних байт вывода (stdout и stderr вместе) уходит в ответ и журнал. */
export const CLI_UPDATE_OUTPUT_BYTES = 4096;

export interface CliUpdateOutcome {
  state: 'done';
  ok: boolean;
  from: string | null;
  to: string | null;
  output: string;
  /** Активные сессии этого CLI: считаются, но не останавливаются. */
  runningSessions: number;
  /** При `ok: false`: что человек может выполнить сам. */
  manualCommand?: string;
  /** Пробный запуск Codex с флагами Parley после обновления; нет поля — проба не нужна (Claude) или не дошла. */
  smoke?: { ok: boolean; output: string };
}
export type CliUpdateResult = { state: 'busy' } | CliUpdateOutcome;

export interface CliUpdateRunner {
  run(command: UpdateCommand, who: string): Promise<CliUpdateResult>;
  /** Остановка хоста: идущие установщики убиваются целыми группами. */
  stop(): void;
}

export interface CliUpdateRunnerOptions {
  log: Log;
  versions: Pick<ProviderVersions, 'get' | 'fresh'>;
  updates: Pick<CliUpdates, 'latest'>;
  runningSessions: (command: UpdateCommand) => Promise<number>;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  smokeTimeoutMs?: number;
}

interface Exit {
  code: number | null;
  output: string;
  timedOut: boolean;
}

/** Окружение запуска: без меток родительской сессии и без унаследованных меток способа установки Codex. */
function updateEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = agentEnv(env);
  for (const name of Object.keys(clean)) {
    if (name.startsWith('CODEX_MANAGED_BY_') || name === 'CODEX_MANAGED_PACKAGE_ROOT') delete clean[name];
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
 * Один дочерний процесс: без shell, stdin закрыт, от вывода хранится только хвост. Он стартует лидером своей группы
 * (`detached`): установщик запускает потомков, и убить надо всю группу — иначе потомок, держащий трубы, оставил бы вызов
 * висеть, а установку идущей. По таймауту — SIGKILL группе; итог по `exit`, не по `close`; после выхода группа добивается
 * (хвосты установщика), трубы закрываются.
 */
function exec(binary: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, groups: Set<number>): Promise<Exit> {
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
    const child = spawn(binary, args, { shell: false, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: true });
    if (child.pid !== undefined) groups.add(child.pid);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, timeoutMs);
    const collect = (chunk: Buffer): void => {
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > CLI_UPDATE_OUTPUT_BYTES) tail = tail.subarray(tail.length - CLI_UPDATE_OUTPUT_BYTES);
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

export function createCliUpdateRunner(options: CliUpdateRunnerOptions): CliUpdateRunner {
  const running = new Set<UpdateCommand>();
  /** Группы живых установщиков (`pid` лидера): их добивает `stop()`. */
  const groups = new Set<number>();
  const timeoutMs = options.timeoutMs ?? CLI_UPDATE_TIMEOUT_MS;
  const smokeTimeoutMs = options.smokeTimeoutMs ?? CLI_SMOKE_TIMEOUT_MS;

  return {
    stop() {
      for (const pid of [...groups]) killGroup(pid);
    },
    async run(command, who) {
      if (!UPDATE_COMMANDS.includes(command)) throw new Error(`unsupported command: ${command}`);
      if (running.has(command)) return { state: 'busy' };
      running.add(command);
      try {
        const env = updateEnv(options.env ?? process.env);
        const binary = await findRunnerBinary(command, options.env ?? process.env);
        const from = options.versions.get(command);
        const sessions = options.runningSessions(command).catch(() => 0);
        const result = await exec(binary, ['update'], env, timeoutMs, groups);
        const to = await options.versions.fresh(command);
        const latest = await options.updates.latest(command);
        const grew = to !== null && (from === null || isNewer(from, to) || to === latest);
        const ok = result.code === 0 && !result.timedOut && grew;
        let smoke: CliUpdateOutcome['smoke'];
        if (command === 'codex') {
          const check = await exec(binary, ['-c', 'check_for_update_on_startup=false', '--version'], env, smokeTimeoutMs, groups);
          smoke = { ok: check.code === 0 && !check.timedOut, output: check.output };
        }
        const output = result.timedOut ? `${result.output}\n(timed out after ${Math.round(timeoutMs / 1000)} s and killed)` : result.output;
        const outcome: CliUpdateOutcome = {
          state: 'done',
          ok,
          from,
          to,
          output,
          runningSessions: await sessions,
          ...(ok ? {} : { manualCommand: `${binary} update` }),
          ...(smoke === undefined ? {} : { smoke }),
        };
        options.log.info('provider CLI update', {
          who,
          command,
          from,
          to,
          ok,
          exitCode: result.code,
          timedOut: result.timedOut,
          ...(smoke === undefined ? {} : { smokeOk: smoke.ok }),
          output,
        });
        return outcome;
      } finally {
        running.delete(command);
      }
    },
  };
}
