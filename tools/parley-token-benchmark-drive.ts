#!/usr/bin/env -S pnpm exec tsx
/**
 * Оператор живого прогона стенда замера (P32): один прогон от `begin` до `accept` одной командой.
 *
 * Вынесено из скрипта пилота 2026-10-06 (четыре живые сессии): `begin` стенда → хост Parley с чистым окружением →
 * одна сессия с одним запросом сценария → ожидание конца хода по журналу хуков → остановка сессии и хоста →
 * `accept` стенда. Провайдер сессии — из `begin.json` (`claude`, `glm` или `codex`): GLM — тот же `claude` с ключом
 * Z.ai, который хост берёт из дома стенда (ссылкой `--link-secrets` на время прогона), Codex — свой CLI, свои экраны
 * запуска и свой журнал. Платный ход модели здесь есть, поэтому запускать только с явного разрешения человека (P32).
 *
 * Запуск: `pnpm exec tsx tools/parley-token-benchmark-drive.ts <id> [--out DIR] [--home DIR] [--claude-bin PATH]
 * [--trust-copies] [--link-secrets PATH] [--timeout-min N]`, справка — `--help`. Последняя строка stdout —
 * `RESULT <json>`.
 *
 * Чистые части (распознавание экранов, окружение хоста, псевдоним модели, разбор журнала хуков, список изменённых
 * файлов, поиск транскрипта, ссылка на ключ) вынесены в функции и покрыты тестом без живых процессов.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { hostEnv } from './parley-token-benchmark.js';
import type { PlannedRun, Provider, Scenario } from './parley-token-benchmark.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = path.join(repoRoot, 'docs/research/2026-10-04-parley-token-benchmark');
const DEFAULT_OUT = path.join(repoRoot, '.parley/benchmark');
const HOST_MAIN = path.join(repoRoot, 'packages/host/dist/main.js');
const START_TIMEOUT_MS = 180_000;
const HOST_EXIT_WAIT_MS = 5_000;

// ---------- Чистые части ----------

const squash = (text: string): string => text.replace(/\s+/g, '');

/**
 * Выделенный пункт диалога доверия: строка с `❯` (Claude Code) или с `›` либо `❯` (Codex); `null` — выделения на
 * экране нет. У Claude доверие — «Yes, I trust this folder», у Codex — любой пункт, начинающийся с «Yes,»
 * (формулировка в живом CLI не проверена: незнакомый пункт — `other`, и драйвер остановится).
 */
export function selectedOption(text: string, provider: Provider = 'claude'): 'yes' | 'no' | 'other' | null {
  const marker = provider === 'codex' ? /[❯›]/ : /❯/;
  const line = text.split(/\r?\n/).find((l) => marker.test(l));
  if (line === undefined) return null;
  const flat = squash(line);
  const tail = flat.slice(flat.search(marker));
  if (provider === 'codex') {
    if (/^[❯›](?:\d+\.)?Yes,/i.test(tail)) return 'yes';
    if (/^[❯›](?:\d+\.)?No,/i.test(tail)) return 'no';
    return 'other';
  }
  if (/^❯(?:\d+\.)?Yes,Itrustthisfolder/i.test(tail)) return 'yes';
  if (/^❯(?:\d+\.)?No,exit/i.test(tail)) return 'no';
  return 'other';
}

export type Screen =
  | { kind: 'trust'; selected: 'yes' | 'no' | 'other' | null; ours: boolean }
  | { kind: 'mcp' }
  | { kind: 'channel' }
  | { kind: 'update' }
  | { kind: 'other' };

/**
 * Распознавание экрана запуска по снимку. В снимке пропадают пробелы между словами (курсорные сдвиги вместо
 * пробелов), поэтому текст сверяется без пробелов. `ours` — в диалоге доверия показан путь копии, и копия лежит под
 * `workRoot` (`<out>/work`): только такие копии пилот разрешает доверять. `update` — предложение обновиться у Codex
 * (оба признака сразу: «Update available» и подсказка «esc skip»); у других провайдеров этого экрана драйвер не знает.
 */
export function classifyScreen(text: string, copyPath: string, workRoot: string, provider: Provider = 'claude'): Screen {
  const flat = squash(text);
  // Вопрос доверия у Codex — «Do you trust the contents of this directory?»; других экранов Codex драйвер не знает.
  const trustQuestion = provider === 'codex'
    ? /Doyoutrustthecontentsofthisdirectory|Doyoutrustthisdirectory|Doyoutrustthisfolder/i
    : /Isthisaprojectyoucreatedoroneyoutrust|Itrustthisfolder|Quicksafetycheck/i;
  if (trustQuestion.test(flat)) {
    const ours = copyPath.startsWith(workRoot + path.sep) && flat.includes(squash(copyPath));
    return { kind: 'trust', selected: selectedOption(text, provider), ours };
  }
  if (/newMCPservers?foundinthisproject/i.test(flat) && /Esctorejectall/i.test(flat)) return { kind: 'mcp' };
  if (/developmentchannel/i.test(flat)) return { kind: 'channel' };
  // Предложение обновиться у Codex: по умолчанию выделено «Update now», и Enter запустил бы глобальную установку npm.
  // Вопрос доверия проверен выше и важнее: он идёт после этого экрана, а текст прежнего экрана мог остаться в снимке.
  if (provider === 'codex' && /Updateavailable/i.test(flat) && /escskip/i.test(flat)) return { kind: 'update' };
  return { kind: 'other' };
}

/** Эту модель хост принимает только псевдонимом из списка провайдера (`claude-sonnet-…` → `sonnet`). */
export function modelAlias(model: string): string {
  const match = /^(?:claude-)?(sonnet|opus|haiku)(?:-|$)/.exec(model);
  if (match === null) throw new Error(`модель ${model}: нет псевдонима провайдера (ждём claude-sonnet-…, claude-opus-…, claude-haiku-…)`);
  return match[1]!;
}

/**
 * Модель для `sessions.create`: у Claude хост принимает только псевдоним из списка провайдера; у GLM и Codex — id из
 * списка провайдера как есть (`glm-5.3[1m]`, `gpt-6-luna`).
 */
export function sessionModel(provider: Provider, model: string): string {
  return provider === 'claude' ? modelAlias(model) : model;
}

/**
 * Готов ли провайдер к сессии по `providers.list` хоста; текст проблемы или `null`. Без этого сессия GLM без ключа
 * или Codex без CLI упала бы позже, уже внутри платного прогона.
 */
export function providerProblem(list: readonly { id: string; available?: boolean; needs?: 'cli' | 'key' | null }[], provider: string): string | null {
  const entry = list.find((item) => item.id === provider);
  if (entry === undefined) return `хост не знает провайдера ${provider}`;
  if (entry.needs === 'key') return `провайдер ${provider}: хост не видит ключ (--link-secrets ведёт не на файл ключа дома Parley?)`;
  if (entry.needs === 'cli') return `провайдер ${provider}: нет CLI нужной версии`;
  if (entry.available === false) return `провайдер ${provider}: недоступен`;
  return null;
}

/** Метки родительской сессии Claude Code, ключи API и прочее окружение оператора хосту не передаются. */
const isForbiddenKey = (key: string): boolean =>
  key === 'CLAUDECODE' || (key.startsWith('CLAUDE_CODE_') && key !== 'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS') || key.startsWith('ANTHROPIC_');

/**
 * Окружение хоста: только разрешённый список плюс `PARLEY_HOME` и строка `hostEnv` прогона. `DISABLE_AUTOUPDATER=1`
 * всегда: без него Claude Code обновился посреди пилота, и пары перестали совпадать по версии. `claudeBinDir` встаёт
 * первым в `PATH` (закреплённая версия claude). `LANG` и `TERM` фиксированы, как в пилоте: прогоны не зависят от
 * терминала оператора.
 */
export function buildHostEnv(input: {
  base: NodeJS.ProcessEnv;
  home: string;
  runEnv: readonly string[];
  tmpDir: string;
  claudeBinDir?: string | null;
}): Record<string, string> {
  const { base } = input;
  const env: Record<string, string> = {};
  for (const key of ['HOME', 'USER', 'LOGNAME']) {
    const value = base[key];
    if (value !== undefined) env[key] = value;
  }
  const basePath = base['PATH'] ?? '';
  env['PATH'] = input.claudeBinDir ? `${input.claudeBinDir}${path.delimiter}${basePath}` : basePath;
  env['SHELL'] = base['SHELL'] ?? '/bin/zsh';
  env['LANG'] = 'en_US.UTF-8';
  env['TERM'] = 'xterm-256color';
  env['TMPDIR'] = input.tmpDir;
  env['PARLEY_HOME'] = input.home;
  for (const entry of input.runEnv) {
    const at = entry.indexOf('=');
    const key = entry.slice(0, at);
    if (at <= 0 || isForbiddenKey(key)) throw new Error(`строка окружения прогона «${entry}» не годится для хоста`);
    env[key] = entry.slice(at + 1);
  }
  env['DISABLE_AUTOUPDATER'] = '1';
  return env;
}

export interface HookRow {
  hook_event_name?: string;
}

/** Журнал хуков сессии — jsonl; битые и пустые строки пропускаются. */
export function parseJournal(text: string): HookRow[] {
  const rows: HookRow[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line) as HookRow);
    } catch {
      // недописанная строка: дочитаем на следующем опросе
    }
  }
  return rows;
}

/** Ход закончен: `Stop` после последнего `UserPromptSubmit`. */
export function turnEnded(rows: readonly HookRow[]): boolean {
  let submitted = -1;
  rows.forEach((row, i) => {
    if (row.hook_event_name === 'UserPromptSubmit') submitted = i;
  });
  return submitted !== -1 && rows.slice(submitted + 1).some((row) => row.hook_event_name === 'Stop');
}

/** Сколько строк `Stop` в журнале. */
export const stopCount = (rows: readonly HookRow[]): number => rows.filter((row) => row.hook_event_name === 'Stop').length;

/**
 * Конец хода у Codex: `UserPromptSubmit` в его журнале нет (строки пишет `notify`, только `Stop` — после хода), и
 * времени в строках нет, только порядок. Поэтому конец хода — первая `Stop` сверх тех, что уже были в журнале в момент
 * отправки запроса (`stopsBefore`).
 */
export const codexTurnEnded = (rows: readonly HookRow[], stopsBefore: number): boolean => stopCount(rows) > stopsBefore;

/** Изменённые файлы копии по `git status --porcelain`; служебное (`.parley/`, `PARLEY.md`, `.omc/`) не считается. */
export function changedFiles(porcelain: string): string[] {
  const files: string[] = [];
  for (const line of porcelain.split('\n')) {
    if (line.length < 4) continue;
    let file = line.slice(3);
    const arrow = file.indexOf(' -> ');
    if (arrow !== -1) file = file.slice(arrow + 4);
    file = file.replace(/^"|"$/g, '');
    if (file.startsWith('.parley/') || file.startsWith('.omc/') || file === 'PARLEY.md') continue;
    files.push(file);
  }
  return files;
}

/** Транскрипт Claude Code: `<uuid>.jsonl` в одном из каталогов `<root>/*`. */
export function findTranscript(root: string, uuid: string): string | null {
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root)) {
    const candidate = path.join(root, dir, `${uuid}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Журнал Codex (rollout) с id треда: файл `rollout-<время>-<id>.jsonl` в любом подкаталоге `root`. Читаются только
 * имена файлов, не содержимое журналов.
 */
export function findCodexRollout(root: string, threadId: string): string | null {
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root, { recursive: true })) {
    const name = String(entry);
    if (path.basename(name).startsWith('rollout-') && name.endsWith(`-${threadId}.jsonl`)) return path.join(root, name);
  }
  return null;
}

/** `--link-secrets` нужен прогону glm и только ему: без опции у glm ключа нет, у остальных ссылка — лишний доступ к ключу. */
export function checkSecretsOption(provider: Provider, option: string | null): void {
  if (provider !== 'glm' && option !== null) throw new Error('--link-secrets нужен только прогону с провайдером glm');
  if (provider === 'glm' && option === null) {
    throw new Error('провайдер glm: ключ Z.ai хосту стенда дать нечем; передайте --link-secrets PATH (файл ключа в доме Parley человека; ссылка живёт только на время прогона, файл не читается и не копируется) — только с разрешения человека');
  }
}

/**
 * Ссылка на файл ключа GLM в доме стенда на время прогона: хост читает ключ из дома, а сам файл остаётся там, где
 * лежит. Файл не читается, не копируется и не печатается: проверяется только, что он есть. Имя ссылки — имя исходного
 * файла (хост ищет ключ под именем, которое ему известно; если оно другое, `providers.list` скажет `needs: key`, и
 * драйвер остановится). Поверх существующего файла или ссылки не пишет. `remove` убирает ссылку, повторный вызов безвреден.
 */
export function linkSecrets(source: string, home: string): { link: string; remove: () => void } {
  const target = path.resolve(source);
  if (!existsSync(target)) throw new Error(`--link-secrets ${target}: файла нет`);
  mkdirSync(home, { recursive: true });
  const link = path.join(home, path.basename(target));
  if (lstatSync(link, { throwIfNoEntry: false }) !== undefined) throw new Error(`${link}: в доме стенда уже что-то лежит; уберите это или возьмите другой --home`);
  symlinkSync(target, link);
  return { link, remove: () => rmSync(link, { force: true }) };
}

const strip = (text: string): string =>
  text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[=>78]/g, '');

// ---------- Клиент сокета хоста ----------

interface Ref {
  projectPath: string;
  workId: string;
  sessionId: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Живой ли хост на сокете: подключение удалось — да; нет файла или отказ — нет. */
export function hostAlive(socketPath: string): Promise<boolean> {
  if (!existsSync(socketPath)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const probe = net.connect(socketPath);
    const done = (alive: boolean): void => {
      probe.destroy();
      resolve(alive);
    };
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
    probe.setTimeout(1000, () => done(false));
  });
}

export class HostClient {
  lastActivity: string | null = null;
  private nextId = 1;
  private buffer = '';
  private readonly waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  private constructor(
    private readonly socket: net.Socket,
    private readonly log: (...parts: unknown[]) => void,
  ) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('close', () => {
      for (const { reject } of this.waiting.values()) reject(new Error('сокет хоста закрыт'));
      this.waiting.clear();
    });
    socket.on('error', () => undefined);
  }

  /** Сокет появляется не сразу: подключаемся с повторами, пока хост не примет соединение. */
  static async connect(socketPath: string, log: (...parts: unknown[]) => void, waitMs = 20_000): Promise<HostClient> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const socket = await new Promise<net.Socket | null>((resolve) => {
        if (!existsSync(socketPath)) return resolve(null);
        const candidate = net.connect(socketPath);
        candidate.once('connect', () => resolve(candidate));
        candidate.once('error', () => resolve(null));
      });
      if (socket !== null) return new HostClient(socket, log);
      if (Date.now() > deadline) throw new Error(`хост не принял подключение на ${socketPath} за ${waitMs / 1000} с`);
      await sleep(500);
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let at: number;
    while ((at = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      if (line === '') continue;
      const message = JSON.parse(line) as {
        id?: number;
        result?: unknown;
        error?: unknown;
        event?: string;
        data: { ref: Ref; activity: { activity: string; source: string }; kind: string; text: string };
      };
      if (message.id !== undefined && this.waiting.has(message.id)) {
        const { resolve, reject } = this.waiting.get(message.id)!;
        this.waiting.delete(message.id);
        if (message.error !== undefined) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      } else if (message.event === 'activity.changed') {
        this.lastActivity = message.data.activity.activity;
        this.log(`activity ${message.data.ref.sessionId}: ${this.lastActivity} (${message.data.activity.source})`);
      } else if (message.event === 'host.notice') {
        this.log(`NOTICE ${message.data.kind}: ${message.data.text}`);
      } else if (message.event === 'pty.exit') {
        this.log(`pty.exit ${JSON.stringify(message.data)}`);
      }
    }
  }

  call<T = unknown>(method: string, params: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  notify(method: string, params: unknown): void {
    this.socket.write(`${JSON.stringify({ method, params })}\n`);
  }

  /** Экран сессии: `pty.attach` отдаёт снимок, `pty.detach` сразу отпускает. */
  async screen(ref: Ref): Promise<string> {
    const attached = await this.call<{ snapshot: string }>('pty.attach', { ref });
    await this.call('pty.detach', { ref });
    return strip(attached.snapshot);
  }

  close(): void {
    this.socket.end();
  }
}

// ---------- Прогон ----------

export interface DriveOptions {
  id: string;
  out: string;
  home: string;
  claudeBin: string | null;
  trustCopies: boolean;
  /** Файл ключа GLM, на который до старта хоста ставится ссылка в доме стенда; нужен только прогону glm. */
  linkSecrets: string | null;
  timeoutMin: number | null;
}

export type Outcome =
  | 'turn-ended'
  | 'turn-timeout'
  | 'blocked'
  | 'start-timeout'
  | 'trust-not-allowed'
  | 'trust-unexpected'
  | 'mcp-prompt-stuck'
  | 'channel-dialog'
  | 'update-prompt-stuck'
  | `send-${string}`;

interface BeginJson {
  scenario: string;
  conditions: { arm: PlannedRun['arm']; jev: PlannedRun['jev']; provider: Provider; model: string; effort: string };
  projectDir: string;
}

function dump(text: string, lines = 30): void {
  const tail = text.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line !== '').slice(-lines);
  for (const line of tail) console.log(`   | ${line.slice(0, 160)}`);
}

function tempDir(): string {
  if (process.platform === 'darwin') {
    const result = spawnSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout.trim() !== '') return result.stdout.trim();
  }
  return tmpdir();
}

/** Предел пути сокета берём у хоста: его модуль тянет ядро из `dist`, поэтому подгружается здесь. */
async function hostLayout(home: string): Promise<{ socket: string; token: string }> {
  const { hostPaths, MAX_SOCKET_PATH_BYTES } = await import('../packages/host/src/paths.js');
  const paths = hostPaths(home);
  const bytes = Buffer.byteLength(paths.socket, 'utf8');
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`${paths.socket}: путь сокета хоста ${bytes} байт при пределе ${MAX_SOCKET_PATH_BYTES}; передайте более короткий --home DIR`);
  }
  return { socket: paths.socket, token: paths.token };
}

/** Остановка хоста: `host.shutdown`; не вышел за 5 с — SIGTERM (известная ошибка хоста, чинится отдельно). */
async function stopHost(client: HostClient, child: ChildProcess, exited: Promise<void>): Promise<void> {
  await client.call('host.shutdown', {}).catch(() => undefined);
  client.close();
  const gone = await Promise.race([exited.then(() => true), sleep(HOST_EXIT_WAIT_MS).then(() => false)]);
  if (!gone) {
    console.log('(хост после shutdown не вышел за 5 с: SIGTERM)');
    child.kill('SIGTERM');
    await exited;
  }
}

interface SessionSummary {
  providerSessionId: string | null;
  outcome: Outcome;
  sentAt: number | null;
  endedAt: number | null;
  trustAnswered: boolean;
  mcpRejected: boolean;
  updateSkipped: boolean;
}

/**
 * Запуск и ход одной сессии: диалоги запуска по снимку экрана, один запрос, ожидание `Stop` в журнале хуков.
 * Экспорт — для теста цикла запуска на подставном клиенте хоста.
 */
export async function runSession(
  client: HostClient,
  ref: Ref,
  ctx: { copy: string; workRoot: string; prompt: string; trustCopies: boolean; timeoutMin: number; provider: Provider },
): Promise<SessionSummary> {
  const summary: SessionSummary = { providerSessionId: null, outcome: 'start-timeout', sentAt: null, endedAt: null, trustAnswered: false, mcpRejected: false, updateSkipped: false };
  const stop = async (outcome: Outcome, text: string | null): Promise<SessionSummary> => {
    if (text !== null) dump(text);
    summary.outcome = outcome;
    return summary;
  };

  const journal = path.join(ctx.copy, '.parley', 'works', ref.workId, 'events', `${ref.sessionId}.jsonl`);
  const rows = (): HookRow[] => (existsSync(journal) ? parseJournal(readFileSync(journal, 'utf8')) : []);
  // Codex: Stop, уже лежащие в журнале к моменту отправки (см. `codexTurnEnded`).
  let stopsBefore = 0;
  const startDeadline = Date.now() + START_TIMEOUT_MS;
  let trustMoves = 0;
  let afterAnswer = 0;
  let mcpRejects = 0;
  let updateSkips = 0;
  while (summary.sentAt === null) {
    if (Date.now() > startDeadline) {
      console.log('start timeout');
      return stop('start-timeout', await client.screen(ref));
    }
    await sleep(2000);
    const text = await client.screen(ref);
    const screen = classifyScreen(text, ctx.copy, ctx.workRoot, ctx.provider);
    if (screen.kind === 'trust') {
      if (summary.trustAnswered) {
        // Enter уже нажат: диалог мог не успеть исчезнуть; второй Enter не нажимаем.
        if (++afterAnswer <= 5) continue;
        return stop('trust-unexpected', text);
      }
      if (!ctx.trustCopies) {
        console.log('folder trust prompt: ответ только с --trust-copies (разрешение человека)');
        return stop('trust-not-allowed', text);
      }
      if (screen.ours && screen.selected === 'yes') {
        console.log('folder trust prompt for the benchmark copy: confirming "Yes, I trust this folder"');
        client.notify('pty.input', { ref, data: '\r' });
        summary.trustAnswered = true;
        continue;
      }
      // У Codex выделение не двигаем: оно должно стоять на варианте доверия само, иначе стоп со снимком.
      if (screen.ours && screen.selected === 'no' && ctx.provider !== 'codex' && trustMoves < 2) {
        console.log('folder trust prompt for the benchmark copy: moving the selection to "Yes"');
        client.notify('pty.input', { ref, data: '\x1b[B' });
        trustMoves += 1;
        continue;
      }
      console.log('folder trust prompt in an unexpected state');
      return stop('trust-unexpected', text);
    }
    if (screen.kind === 'mcp') {
      if (mcpRejects >= 2) {
        console.log('project MCP servers prompt did not go away');
        return stop('mcp-prompt-stuck', text);
      }
      // Esc — самый осторожный ответ, ничего не включает; у обеих рук одинаково.
      console.log('project MCP servers prompt: rejecting all (Esc)');
      client.notify('pty.input', { ref, data: '\x1b' });
      mcpRejects += 1;
      summary.mcpRejected = true;
      continue;
    }
    if (screen.kind === 'channel') {
      console.log('development channel dialog — not answering');
      return stop('channel-dialog', text);
    }
    if (screen.kind === 'update') {
      if (updateSkips >= 2) {
        console.log('Codex update prompt did not go away');
        return stop('update-prompt-stuck', text);
      }
      // Только Esc («Skip»): ничего не устанавливает и не записывает. Enter и выбор пунктов — никогда: по умолчанию
      // выделено «Update now», то есть глобальная установка npm.
      console.log('Codex update prompt: skipping (Esc)');
      client.notify('pty.input', { ref, data: '\x1b' });
      updateSkips += 1;
      summary.updateSkipped = true;
      continue;
    }
    stopsBefore = stopCount(rows());
    const sent = await client.call<{ inserted: boolean; submitted: boolean; reason: string | null }>('pty.send', { ref, text: ctx.prompt, submit: true });
    console.log(`pty.send ${JSON.stringify(sent)}`);
    if (sent.submitted) {
      summary.sentAt = Date.now();
      client.lastActivity = null;
    } else if (sent.inserted) return stop(`send-${sent.reason ?? 'unknown'}`, await client.screen(ref));
  }

  const turnDeadline = summary.sentAt + ctx.timeoutMin * 60_000;
  for (;;) {
    await sleep(3000);
    if (ctx.provider === 'codex' ? codexTurnEnded(rows(), stopsBefore) : turnEnded(rows())) {
      summary.endedAt = Date.now();
      summary.outcome = 'turn-ended';
      break;
    }
    if (client.lastActivity === 'blocked') {
      console.log('session is blocked (permission or question)');
      return stop('blocked', await client.screen(ref));
    }
    if (Date.now() > turnDeadline) {
      console.log('turn timeout');
      dump(await client.screen(ref));
      summary.outcome = 'turn-timeout';
      break;
    }
  }
  await sleep(3000);
  const works = await client.call<{ entries: { projectPath: string; map: { work: { id: string }; sessions: { id: string; providerSessionId?: string | null }[] } }[] }>('works.list', {});
  for (const entry of works.entries) {
    if (entry.projectPath !== ref.projectPath || entry.map.work.id !== ref.workId) continue;
    summary.providerSessionId = entry.map.sessions.find((s) => s.id === ref.sessionId)?.providerSessionId ?? null;
  }
  console.log('final screen:');
  dump(await client.screen(ref), 20);
  return summary;
}

function standCli(command: 'begin' | 'accept', id: string, out: string, env: NodeJS.ProcessEnv): number {
  const result = spawnSync('pnpm', ['exec', 'tsx', 'tools/parley-token-benchmark.ts', command, id, '--out', out], { cwd: repoRoot, env, encoding: 'utf8' });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.status ?? 1;
}

export async function drive(options: DriveOptions): Promise<{ result: Record<string, unknown>; code: number }> {
  const out = path.resolve(options.out);
  const home = path.resolve(options.home);
  const workRoot = path.join(out, 'work');
  const workDir = path.join(workRoot, options.id);
  const t0 = Date.now();
  const log = (...parts: unknown[]): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...parts);

  // До begin (он стирает копию): сокет влезает в предел и на нём нет живого хоста.
  const layout = await hostLayout(home);
  if (await hostAlive(layout.socket)) throw new Error(`${layout.socket}: на сокете уже живой хост; остановите его или возьмите другой --home`);
  if (!existsSync(HOST_MAIN)) throw new Error(`${HOST_MAIN}: хост не собран (pnpm --filter @parley/host build)`);

  let claudeBinDir: string | null = null;
  if (options.claudeBin !== null) {
    claudeBinDir = mkdtempSync(path.join(tmpdir(), 'parley-bench-bin-'));
    symlinkSync(path.resolve(options.claudeBin), path.join(claudeBinDir, 'claude'));
  }
  let keepBinDir = false;
  let secrets: { link: string; remove: () => void } | null = null;
  const removeSecrets = (): void => secrets?.remove();
  const onSignal = (): void => process.exit(1);
  try {
    const base = { ...process.env, PATH: claudeBinDir ? `${claudeBinDir}${path.delimiter}${process.env['PATH'] ?? ''}` : (process.env['PATH'] ?? '') };
    log(`begin ${options.id}`);
    if (standCli('begin', options.id, out, base) !== 0) throw new Error('begin стенда завершился с ошибкой');
    const begin = JSON.parse(readFileSync(path.join(workDir, 'begin.json'), 'utf8')) as BeginJson;
    const scenarios = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'scenarios.json'), 'utf8')) as { scenarios: Scenario[]; tasks: { id: string; accept: { kind: string; criteria?: string } }[] };
    const budget = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'budget.json'), 'utf8')) as { perSession: { maxMinutes: number } };
    const scenario = scenarios.scenarios.find((s) => s.id === begin.scenario);
    if (scenario === undefined) throw new Error(`нет сценария ${begin.scenario}`);
    const provider = begin.conditions.provider;
    if (provider !== 'claude' && provider !== 'glm' && provider !== 'codex') throw new Error(`провайдер ${String(provider)}: драйвер ведёт claude, glm и codex`);
    const model = sessionModel(provider, begin.conditions.model);
    const effort = begin.conditions.effort;
    if (effort !== 'low' && effort !== 'medium' && effort !== 'high') throw new Error(`усилие ${effort}: хост принимает low, medium или high`);

    // Ключ GLM — ссылка в доме стенда до старта хоста; она нужна только прогону glm и убирается при любом выходе.
    checkSecretsOption(provider, options.linkSecrets);
    if (options.linkSecrets !== null) {
      secrets = linkSecrets(options.linkSecrets, home);
      process.on('exit', removeSecrets);
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
      log(`ссылка на ключ GLM: ${secrets.link}`);
    }

    const env = buildHostEnv({
      base: process.env,
      home,
      runEnv: hostEnv({ arm: begin.conditions.arm, jev: begin.conditions.jev }, scenario),
      tmpDir: tempDir(),
      claudeBinDir,
    });
    const logFile = path.join(workDir, 'host.log');
    const fd = openSync(logFile, 'w');
    const child = spawn(process.execPath, [HOST_MAIN], { cwd: repoRoot, env, stdio: ['ignore', fd, fd], detached: true });
    child.unref();
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    log(`host pid ${child.pid}, PARLEY_HOME=${home}, лог ${logFile}`);

    let client: HostClient;
    try {
      client = await HostClient.connect(layout.socket, log);
      await client.call('hello', { token: readFileSync(layout.token, 'utf8').trim(), protocol: 1, client: 'bench-drive' });
    } catch (error) {
      child.kill('SIGTERM');
      console.error(readFileSync(logFile, 'utf8').split('\n').slice(-20).join('\n'));
      throw error;
    }

    let summary: SessionSummary;
    let ref: Ref | null = null;
    try {
      if (provider !== 'claude') {
        const listed = await client.call<{ providers: { id: string; available?: boolean; needs?: 'cli' | 'key' | null }[] }>('providers.list', {});
        const problem = providerProblem(listed.providers, provider);
        if (problem !== null) throw new Error(problem);
      }
      const created = await client.call<{ ref: Ref }>('sessions.create', {
        projectPath: begin.projectDir, workId: null, provider, label: 'bench', task: '', parent: null, model, effort,
      });
      ref = created.ref;
      log(`created ${JSON.stringify(ref)}`);
      summary = await runSession(client, ref, {
        copy: begin.projectDir, workRoot, prompt: scenario.prompt, trustCopies: options.trustCopies, provider,
        timeoutMin: options.timeoutMin ?? budget.perSession.maxMinutes,
      });
    } catch (error) {
      await stopHost(client, child, exited);
      throw error;
    }

    if (summary.outcome === 'blocked') {
      // Сессия ждёт решения человека: хост оставляем живым, остановка — явная.
      keepBinDir = true;
      console.log(`== сессия ждёт решения: хост оставлен живым (pid ${child.pid}, PARLEY_HOME=${home}); остановить: kill ${child.pid}${secrets === null ? '' : '; ссылка на ключ GLM снята, новые сессии GLM этот хост не запустит'}`);
    } else {
      if (ref !== null) await client.call('sessions.stop', { ref }).then(() => log('session stopped'), () => undefined);
      await stopHost(client, child, exited);
    }
    client.close();

    const task = scenarios.tasks.find((t) => t.id === scenario.task);
    if (summary.outcome === 'turn-ended' || summary.outcome === 'turn-timeout') {
      if (task?.accept.kind === 'command') standCli('accept', options.id, out, base);
      else console.log(`принимает человек: ${task?.accept.criteria ?? '(критерии не найдены)'}`);
    }

    const status = spawnSync('git', ['status', '--porcelain', '-uall'], { cwd: begin.projectDir, encoding: 'utf8' });
    const result = {
      id: options.id,
      provider,
      providerSessionId: summary.providerSessionId,
      transcript: summary.providerSessionId === null
        ? null
        : provider === 'codex'
          ? findCodexRollout(path.join(homedir(), '.codex/sessions'), summary.providerSessionId)
          : findTranscript(path.join(homedir(), '.claude/projects'), summary.providerSessionId),
      outcome: summary.outcome,
      turnSeconds: summary.sentAt === null || summary.endedAt === null ? null : Math.round((summary.endedAt - summary.sentAt) / 1000),
      changedFiles: changedFiles(status.stdout),
      dialogs: { trustAnswered: summary.trustAnswered, mcpRejected: summary.mcpRejected, updateSkipped: summary.updateSkipped },
    };
    return { result, code: summary.outcome === 'turn-ended' ? 0 : 1 };
  } finally {
    if (claudeBinDir !== null && !keepBinDir) rmSync(claudeBinDir, { recursive: true, force: true });
    removeSecrets();
    process.off('exit', removeSecrets);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

const HELP = `parley-token-benchmark-drive — оператор живого прогона стенда замера (P32)

  pnpm exec tsx tools/parley-token-benchmark-drive.ts <id> [--out DIR] [--home DIR] [--claude-bin PATH]
                                                        [--trust-copies] [--link-secrets PATH] [--timeout-min N]

  id                   id прогона из плана стенда (begin, хост, сессия, accept — одна команда)
  --out DIR            каталог стенда (по умолчанию .parley/benchmark)
  --home DIR           PARLEY_HOME хоста (по умолчанию <out>/home); сокет <home>/host/host.sock должен влезать
                       в предел пути хоста, иначе отказ — берите короткий путь, например /tmp/pbh
  --claude-bin PATH    закрепить версию claude: каталог со ссылкой на этот бинарь ставится первым в PATH
  --trust-copies       отвечать «Yes, I trust this folder» на вопрос доверия к папке КОПИИ прогона (под <out>/work).
                       Оператор ставит флаг только с разрешения человека; без флага диалог доверия — стоп
  --link-secrets PATH  только для прогона glm: до старта хоста поставить в доме стенда (<home>) символическую ссылку на
                       файл ключа Z.ai по этому пути, а после прогона и при любом выходе снять. Файл не читается,
                       не копируется и не печатается. Без опции прогон glm — отказ. Только с разрешения человека
  --timeout-min N      потолок времени хода (по умолчанию budget.perSession.maxMinutes)

Провайдер берётся из begin.json прогона (волны wq-codex и wq-glm плана): у claude и glm экраны запуска и конец хода как
у Claude Code; у codex драйвер отвечает только на вопрос доверия к копии (при выделенном «Yes», только с
--trust-copies) и пропускает предложение обновиться клавишей Esc («Skip», не больше двух раз; Enter там запустил бы
установку npm), на любом другом экране, не ушедшем за срок старта, — стоп со снимком; конец хода — первая строка
журнала Stop после отправки запроса.

Платный ход модели: запускать только с явного разрешения человека. Последняя строка stdout — RESULT <json>;
код выхода 0 только при outcome turn-ended.
`;

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' }, home: { type: 'string' }, 'claude-bin': { type: 'string' },
      'trust-copies': { type: 'boolean' }, 'link-secrets': { type: 'string' }, 'timeout-min': { type: 'string' }, help: { type: 'boolean' },
    },
  });
  const [id] = positionals;
  if (values.help === true || id === undefined) {
    console.log(HELP);
    return values.help === true ? 0 : 1;
  }
  const out = path.resolve(values.out ?? DEFAULT_OUT);
  const timeout = values['timeout-min'] === undefined ? null : Number(values['timeout-min']);
  if (timeout !== null && !(timeout > 0)) throw new Error('--timeout-min: ждём положительное число минут');
  const { result, code } = await drive({
    id, out, home: values.home ?? path.join(out, 'home'), claudeBin: values['claude-bin'] ?? null,
    trustCopies: values['trust-copies'] === true, linkSecrets: values['link-secrets'] ?? null, timeoutMin: timeout,
  });
  console.log(`RESULT ${JSON.stringify(result)}`);
  return code;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; },
  );
}
