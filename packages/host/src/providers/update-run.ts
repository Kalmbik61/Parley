/**
 * Обновление CLI провайдера из Parley (спека 2026-11-02, раздел 4; спека 2026-11-11, §4.1 и §4.3). План берётся из
 * таблицы `CLI_TOOLS` по способу установки того бинаря, что запускает Parley:
 * - `run` — `<бинарь> <args>` (claude и codex `update`, автономный qwen `update`);
 * - `npm-bound` — npm той самой установки: node и npm-cli.js из её префикса, без npm из PATH;
 * - `manual` — ничего не запускается, человеку уходит команда.
 * Процессы, группа, таймаут и флаг занятости — в `cli-run.ts`. Работающие сессии не трогаются: они остаются на
 * старом бинаре до перезапуска. Настоящий `update` в тестах не запускается никогда — только заглушки.
 */

import { constants, existsSync } from 'node:fs';
import { access, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { CLI_TOOLS, findRunnerBinary, installMethod, isNewer, type CliUpdatePlan } from '@parley/core';
import type { Log } from '../log.js';
import { CLI_RUN_OUTPUT_BYTES, cliEnv, createCliRun, installerEnv, type CliRun } from './cli-run.js';
import type { CliUpdates, UpdateCommand } from './updates.js';
import { UPDATE_COMMANDS } from './updates.js';
import type { ProviderVersions } from './versions.js';

export const CLI_UPDATE_TIMEOUT_MS = 5 * 60 * 1000;
export const CLI_SMOKE_TIMEOUT_MS = 5000;
/** Сколько последних байт вывода (stdout и stderr вместе) уходит в ответ и журнал. */
export const CLI_UPDATE_OUTPUT_BYTES = CLI_RUN_OUTPUT_BYTES;
/** Реестр npm, который получает привязанное npm-обновление вместо настроенного у человека (§4.2 п. 3). */
export const NPM_REGISTRY = 'https://registry.npmjs.org/';
/** Нижняя граница Node для npm-установки qwen (спека, Q25); `engines.node` пакета может поднять её. */
const MIN_NODE_MAJOR = 22;

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
  /** Пробный запуск CLI (`smokeArgs` таблицы) после обновления; нет поля — проба не дошла. */
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
  /** Общий раннер с флагом занятости на CLI (его делит установка); по умолчанию — свой. */
  cli?: CliRun;
  /** Домашняя папка человека: от неё считается способ установки; по умолчанию `os.homedir()`. */
  userHome?: string;
}

/** Что запустить: argv и окружение; или ничего — тогда команда для человека и причина. */
type Route =
  | { kind: 'spawn'; argv: [string, ...string[]]; env: NodeJS.ProcessEnv; manualCommand: string; cleanup?: () => Promise<void> }
  | { kind: 'manual'; manualCommand: string; reason: string };

async function isExecutableFile(file: string): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** `[major, minor, patch]` из `v22.1.0` или `22.1.0`; чужая форма — `null`. */
function parseVersion(raw: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(have: readonly number[], need: readonly number[]): boolean {
  for (let index = 0; index < 3; index += 1) {
    const delta = (have[index] ?? 0) - (need[index] ?? 0);
    if (delta !== 0) return delta > 0;
  }
  return true;
}

/** Нижняя граница `engines.node` вида `>=X[.Y[.Z]]`, но не ниже `MIN_NODE_MAJOR`. */
async function requiredNode(packageJson: string): Promise<[number, number, number]> {
  const floor: [number, number, number] = [MIN_NODE_MAJOR, 0, 0];
  try {
    const data = JSON.parse(await readFile(packageJson, 'utf8')) as { engines?: { node?: unknown } };
    const range = data.engines?.node;
    const match = typeof range === 'string' ? /^\s*>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(range) : null;
    if (match === null) return floor;
    const declared: [number, number, number] = [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
    return atLeast(declared, floor) ? declared : floor;
  } catch {
    return floor;
  }
}

export function createCliUpdateRunner(options: CliUpdateRunnerOptions): CliUpdateRunner {
  const cli = options.cli ?? createCliRun();
  const timeoutMs = options.timeoutMs ?? CLI_UPDATE_TIMEOUT_MS;
  const smokeTimeoutMs = options.smokeTimeoutMs ?? CLI_SMOKE_TIMEOUT_MS;
  const source = (): NodeJS.ProcessEnv => options.env ?? process.env;

  /**
   * Привязка npm-обновления к запускаемой установке (§4.3): префикс из настоящего пути пакета, node и npm-cli.js из
   * этого префикса, версия node против `engines.node`. Чего-то нет — ручная команда и ничего не запускается; npm из
   * PATH не берётся никогда.
   */
  const bindNpm = async (real: string, plan: Extract<CliUpdatePlan, { kind: 'npm-bound' }>): Promise<Route> => {
    const manual = (reason: string): Route => ({ kind: 'manual', manualCommand: plan.manualCommand, reason });
    if (process.platform === 'win32') return manual('Parley does not run npm updates on Windows.');
    const name = plan.packageSpec.slice(0, plan.packageSpec.lastIndexOf('@'));
    const marker = `/lib/node_modules/${name}/`;
    const at = real.indexOf(marker);
    if (at <= 0) return manual(`Cannot find the npm prefix of ${real}.`);
    const prefix = real.slice(0, at);
    const node = path.join(prefix, 'bin', 'node');
    const npmCli = path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!(await isExecutableFile(node))) return manual(`No node next to this install: ${node} is missing.`);
    if (!(await isFile(npmCli))) return manual(`No npm next to this install: ${npmCli} is missing.`);
    const env = installerEnv(source());
    const need = await requiredNode(path.join(prefix, 'lib', 'node_modules', name, 'package.json'));
    const probe = await cli.exec(node, ['--version'], env, smokeTimeoutMs);
    const have = probe.code === 0 && !probe.timedOut ? parseVersion(probe.output) : null;
    if (have === null) return manual(`Cannot read the version of ${node}.`);
    if (!atLeast(have, need)) {
      return manual(`Node ${have.join('.')} at ${node} is below the required >=${need.join('.')}.`);
    }
    // Пустой userconfig: настройки npm человека (реестр, токены, скрипты) в обновление не попадают.
    const dir = await mkdtemp(path.join(tmpdir(), 'parley-npm-'));
    const userconfig = path.join(dir, 'npmrc');
    await writeFile(userconfig, '', { mode: 0o600 });
    return {
      kind: 'spawn',
      argv: [node, npmCli, 'install', '-g', '--prefix', prefix, `--registry=${NPM_REGISTRY}`, '--userconfig', userconfig, plan.packageSpec],
      env,
      manualCommand: plan.manualCommand,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  };

  /** План обновления по способу установки бинаря, который запускает Parley. */
  const route = async (command: UpdateCommand, binary: string): Promise<{ route: Route; plan: CliUpdatePlan['kind']; method: string }> => {
    const real = await realpath(binary);
    const userHome = options.userHome ?? homedir();
    const home = await realpath(userHome).catch(() => userHome);
    const method = installMethod(command, real, home, existsSync);
    const plan = CLI_TOOLS[command].updatePlan(method);
    if (plan.kind === 'run') {
      return {
        plan: plan.kind,
        method,
        route: { kind: 'spawn', argv: [binary, ...plan.args], env: cliEnv(source()), manualCommand: [binary, ...plan.args].join(' ') },
      };
    }
    if (plan.kind === 'npm-bound') return { plan: plan.kind, method, route: await bindNpm(real, plan) };
    return {
      plan: plan.kind,
      method,
      route: { kind: 'manual', manualCommand: plan.manualCommand, reason: `This ${command} install (${method}) is not updated by Parley.` },
    };
  };

  const update = async (command: UpdateCommand, who: string): Promise<CliUpdateOutcome> => {
    const binary = await findRunnerBinary(command, source());
    const from = options.versions.get(command);
    const sessions = options.runningSessions(command).catch(() => 0);
    const chosen = await route(command, binary);
    if (chosen.route.kind === 'manual') {
      const outcome: CliUpdateOutcome = {
        state: 'done',
        ok: false,
        from,
        to: from,
        output: chosen.route.reason,
        runningSessions: await sessions,
        manualCommand: chosen.route.manualCommand,
      };
      options.log.info('provider CLI update', { who, command, method: chosen.method, plan: chosen.plan, from, ok: false, output: chosen.route.reason });
      return outcome;
    }
    const [program, ...args] = chosen.route.argv;
    let result;
    try {
      result = await cli.exec(program, args, chosen.route.env, timeoutMs);
    } finally {
      await chosen.route.cleanup?.().catch(() => undefined);
    }
    const to = await options.versions.fresh(command, { force: true });
    const latest = await options.updates.latest(command);
    // Тот же бинарь сообщает выросшую версию или равную найденной; прежняя или откат — неудача.
    const grew = to !== null && (from === null || isNewer(from, to) || to === latest);
    const ok = result.code === 0 && !result.timedOut && grew;
    const check = await cli.exec(binary, CLI_TOOLS[command].smokeArgs, cliEnv(source()), smokeTimeoutMs);
    const smoke = { ok: check.code === 0 && !check.timedOut, output: check.output };
    const output = result.timedOut ? `${result.output}\n(timed out after ${Math.round(timeoutMs / 1000)} s and killed)` : result.output;
    const outcome: CliUpdateOutcome = {
      state: 'done',
      ok,
      from,
      to,
      output,
      runningSessions: await sessions,
      ...(ok ? {} : { manualCommand: chosen.route.manualCommand }),
      smoke,
    };
    options.log.info('provider CLI update', {
      who,
      command,
      method: chosen.method,
      plan: chosen.plan,
      from,
      to,
      ok,
      exitCode: result.code,
      timedOut: result.timedOut,
      smokeOk: smoke.ok,
      output,
    });
    return outcome;
  };

  return {
    stop() {
      cli.stop();
    },
    run(command, who) {
      if (!UPDATE_COMMANDS.includes(command)) return Promise.reject(new Error(`unsupported command: ${command}`));
      return cli.exclusive(command, () => update(command, who));
    },
  };
}
