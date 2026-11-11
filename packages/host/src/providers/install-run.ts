/**
 * Установка CLI провайдера из Parley (спека 2026-11-11, §4.2). Хост скачивает установщик вендора по константному
 * HTTPS-адресу из таблицы `CLI_TOOLS` (редирект — только на HTTPS-хост из списка этого CLI, тело до 1 МБ, 15 с), кладёт
 * его в свежую папку `0700` и запускает константным argv без shell: `[интерпретатор…, файл, …константные аргументы]`.
 * Ничего из запроса и настроек в argv не попадает. Окружение — `installerEnv`, процесс — общий раннер с флагом
 * занятости на CLI (его делит обновление), 10 мин, группа убивается по таймауту и при остановке хоста. После выхода
 * бинарь ищется общим резолвером (PATH, затем точный ожидаемый путь; подмена `PARLEY_<CMD>_BIN` важнее), версия
 * пробуется на нём, затем проба из таблицы и перепроверка последней версии. Настоящий установщик и сеть в тестах не
 * участвуют: только локальный HTTPS-стаб с тестовым CA.
 */

import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BinaryNotFoundError, CLI_TOOLS, resolveRunnerBinary, type CliInstallPlan, type CliTool } from '@parley/core';
import type { Log } from '../log.js';
import { cliEnv, createCliRun, installerEnv, type CliRun } from './cli-run.js';
import type { CliUpdates } from './updates.js';
import type { ProviderVersions } from './versions.js';

export const CLI_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
export const CLI_INSTALL_SMOKE_TIMEOUT_MS = 5000;
export const INSTALLER_DOWNLOAD_TIMEOUT_MS = 15_000;
/** Сколько install ждёт перепроверку версии: медленный реестр не должен задерживать итог установки. */
export const CLI_INSTALL_RECHECK_TIMEOUT_MS = 5000;
export const INSTALLER_MAX_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;

/** Команды для ручной установки на Windows: Install из Parley там только показывает команду. */
const WINDOWS_COMMANDS: Readonly<Record<CliTool, string>> = {
  claude: 'irm https://claude.ai/install.ps1 | iex',
  codex: 'npm install -g @openai/codex',
  qwen: 'npm install -g @qwen-code/qwen-code@latest',
};

export interface CliInstallOutcome {
  state: 'done';
  ok: boolean;
  /** Версия найденного после установки бинаря; `null` — бинаря нет или версия не узнана. */
  version: string | null;
  /** Последние 4 КБ вывода установщика. */
  output: string;
  /** Почему установка не удалась (скачивание, таймаут, выход, нет бинаря, проба). */
  error?: string;
  /** При `ok: false`: что человек может выполнить сам. */
  manualCommand?: string;
  /** Бинарь найден только по точному ожидаемому пути: его папки нет в PATH. */
  pathNote?: string;
  /** Проба из таблицы на найденном бинаре. */
  smoke?: { ok: boolean; output: string };
}
export type CliInstallResult = { state: 'busy' } | CliInstallOutcome;

export interface CliInstaller {
  install(command: CliTool, who: string): Promise<CliInstallResult>;
}

export interface CliInstallerOptions {
  log: Log;
  /** Общий раннер: флаг занятости на CLI делят установка и обновление. */
  cli?: CliRun;
  versions: Pick<ProviderVersions, 'fresh'>;
  /** Перепроверка последней версии после установки; без неё — не перепроверяется. */
  updates?: Pick<CliUpdates, 'checkOne'>;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  smokeTimeoutMs?: number;
  recheckTimeoutMs?: number;
  downloadTimeoutMs?: number;
  /** Только для тестов: агент HTTPS (тестовый CA и соединение со стабом). */
  agent?: https.Agent;
}

/** Ручная команда для macOS и Linux: тот же установщик, тот же интерпретатор, те же аргументы. */
export function manualInstallCommand(plan: CliInstallPlan): string {
  const shell = path.basename(plan.interpreter[0] ?? 'sh');
  return plan.args.length === 0 ? `curl -fsSL ${plan.url} | ${shell}` : `curl -fsSL ${plan.url} | ${shell} -s -- ${plan.args.join(' ')}`;
}

class DownloadRefused extends Error {}

/**
 * Скачать установщик: только HTTPS, редирект — только на хост из `allowed`, тело до `maxBytes`, общий срок `timeoutMs`.
 * Возвращает тело и последний адрес.
 */
export async function downloadInstaller(
  url: string,
  allowed: ReadonlySet<string>,
  options: { timeoutMs: number; maxBytes: number; agent?: https.Agent },
): Promise<{ body: Buffer; finalUrl: string }> {
  const signal = AbortSignal.timeout(options.timeoutMs);
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (current.protocol !== 'https:') throw new DownloadRefused(`Refused a non-HTTPS installer address: ${current.origin}`);
    if (!allowed.has(current.hostname)) throw new DownloadRefused(`Refused a redirect to a host outside the installer's list: ${current.hostname}`);
    const reply = await new Promise<{ location: string } | { body: Buffer }>((resolve, reject) => {
      const request = https.get(
        current,
        { signal, headers: { accept: '*/*', 'user-agent': 'parley' }, ...(options.agent === undefined ? {} : { agent: options.agent }) },
        (response) => {
          const status = response.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(status)) {
            response.resume();
            const location = response.headers.location;
            if (location === undefined) reject(new Error(`Redirect ${status} without a location`));
            else resolve({ location });
            return;
          }
          if (status !== 200) {
            response.resume();
            reject(new Error(`Installer download failed: HTTP ${status}`));
            return;
          }
          const declared = Number(response.headers['content-length']);
          if (Number.isFinite(declared) && declared > options.maxBytes) {
            response.destroy();
            reject(new DownloadRefused(`Refused an installer over ${options.maxBytes} bytes`));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > options.maxBytes) {
              response.destroy();
              reject(new DownloadRefused(`Refused an installer over ${options.maxBytes} bytes`));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => resolve({ body: Buffer.concat(chunks) }));
          response.on('error', reject);
        },
      );
      request.on('error', reject);
    });
    if ('body' in reply) return { body: reply.body, finalUrl: current.href };
    current = new URL(reply.location, current);
  }
  throw new DownloadRefused('Too many redirects');
}

export function createCliInstaller(options: CliInstallerOptions): CliInstaller {
  const cli = options.cli ?? createCliRun();
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? CLI_INSTALL_TIMEOUT_MS;
  const smokeTimeoutMs = options.smokeTimeoutMs ?? CLI_INSTALL_SMOKE_TIMEOUT_MS;
  const source = (): NodeJS.ProcessEnv => options.env ?? process.env;

  const install = async (command: CliTool, who: string): Promise<CliInstallOutcome> => {
    const descriptor = CLI_TOOLS[command];
    const plan = descriptor.install;
    const manualCommand = manualInstallCommand(plan);
    const fail = (error: string, output = '', extra: Partial<CliInstallOutcome> = {}): CliInstallOutcome => {
      options.log.info('provider CLI install', { who, command, ok: false, error, output });
      return { state: 'done', ok: false, version: null, output, error, manualCommand, ...extra };
    };

    const allowed = new Set([new URL(plan.url).hostname, ...plan.redirectHosts]);
    let download;
    try {
      download = await downloadInstaller(plan.url, allowed, {
        timeoutMs: options.downloadTimeoutMs ?? INSTALLER_DOWNLOAD_TIMEOUT_MS,
        maxBytes: INSTALLER_MAX_BYTES,
        ...(options.agent === undefined ? {} : { agent: options.agent }),
      });
    } catch (error) {
      return fail(error instanceof DownloadRefused ? error.message : `Installer download failed: ${(error as Error).message}`);
    }
    const sha256 = createHash('sha256').update(download.body).digest('hex');
    options.log.info('provider CLI installer downloaded', { who, command, url: plan.url, finalUrl: download.finalUrl, bytes: download.body.length, sha256 });

    const dir = await mkdtemp(path.join(tmpdir(), 'parley-install-'));
    let result;
    try {
      await chmod(dir, 0o700);
      const file = path.join(dir, 'install.sh');
      await writeFile(file, download.body, { mode: 0o600 });
      const [interpreter, ...flags] = plan.interpreter;
      if (interpreter === undefined) return fail('No interpreter for this installer');
      result = await cli.exec(interpreter, [...flags, file, ...plan.args], installerEnv(source()), timeoutMs);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
    const output = result.timedOut ? `${result.output}\n(timed out after ${Math.round(timeoutMs / 1000)} s and killed)` : result.output;
    if (result.timedOut) return fail('The installer timed out and was stopped', output);
    if (result.code !== 0) return fail(`The installer exited with code ${result.code ?? 'unknown'}`, output);

    let found;
    try {
      found = await resolveRunnerBinary(command, source());
    } catch (error) {
      if (error instanceof BinaryNotFoundError) return fail(`The installer finished, but ${command} was not found`, output);
      throw error;
    }
    const pathNote =
      found.source === 'expected' ? `${path.dirname(found.path)} is not on your shell PATH; Parley finds ${command} there` : undefined;
    const version = await options.versions.fresh(command, { force: true });
    const check = await cli.exec(found.path, descriptor.smokeArgs, cliEnv(source()), smokeTimeoutMs);
    const smoke = { ok: check.code === 0 && !check.timedOut, output: check.output };
    // Способ установки (`method`) пишет эта перепроверка: ждём её до рассылки `providers.changed`, но недолго.
    if (options.updates !== undefined) {
      const recheck = options.updates.checkOne(command, { force: true }).catch((error: unknown) => {
        options.log.warn('CLI latest re-check after install failed', { command, error: String(error) });
      });
      let timer: NodeJS.Timeout | undefined;
      const limit = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, options.recheckTimeoutMs ?? CLI_INSTALL_RECHECK_TIMEOUT_MS);
      });
      await Promise.race([recheck, limit]);
      clearTimeout(timer);
    }
    const extra = { ...(pathNote === undefined ? {} : { pathNote }), smoke };
    if (version === null) return { ...fail(`The installed ${command} did not report a version`, output, extra), version: null };
    if (!smoke.ok) return { ...fail(`The installed ${command} failed its check run`, output, extra), version };
    options.log.info('provider CLI install', { who, command, ok: true, version, sha256, ...(pathNote === undefined ? {} : { pathNote }), output });
    return { state: 'done', ok: true, version, output, ...extra };
  };

  return {
    install(command, who) {
      if (!Object.hasOwn(CLI_TOOLS, command)) return Promise.reject(new Error(`unsupported command: ${command}`));
      if (platform === 'win32') {
        options.log.info('provider CLI install', { who, command, ok: false, error: 'windows' });
        return Promise.resolve({
          state: 'done',
          ok: false,
          version: null,
          output: '',
          error: 'Parley does not run installers on Windows',
          manualCommand: WINDOWS_COMMANDS[command],
        });
      }
      return cli.exclusive(command, () => install(command, who));
    },
  };
}
