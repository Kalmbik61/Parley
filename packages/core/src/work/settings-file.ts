/**
 * Файл настроек Claude Code для сессий работы — тот, что уезжает в `--settings`
 * (дизайн TUI v2, раздел 4.2). С навигатором — отдельный файл на сессию,
 * иначе прежний файл работы. Адрес хука приходит из окружения процесса.
 *
 * Хук не содержит логики: stdin-JSON от Claude Code дописывается в журнал
 * сессии как есть, состояние выводят читатели. В `~/.claude` при этом ничего не
 * пишется — юридическая граница проекта.
 *
 * Рядом с хуками — `statusLine`: скрипт строки статуса, который забирает лимиты подписки из
 * того, что Claude Code сам присылает (спека комнат Organic, 3.5). Как и хуки, он лежит в этом
 * файле, а не в настройках человека.
 */

import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ENV_PREFIX, LEGACY_ENV_PREFIX } from '../names.js';
import { ensureStateDir } from './state-dir.js';
import { statusLineCommand } from './statusline.js';
import { workPaths } from './store.js';

/** `${PARLEY_<КЛЮЧ>:-$HARNAS_<КЛЮЧ>}` — оболочка берёт новое имя, а нет его — прежнее (R3). */
const fromShellEnv = (key: string): string =>
  `\${${ENV_PREFIX}${key}:-$${LEGACY_ENV_PREFIX}${key}}`;

/**
 * Команда всех хуков. `|| true` держит код выхода нулевым: недоступный каталог
 * событий не должен ронять хук (раздел 10), а код 2 у `UserPromptSubmit` стёр
 * бы промпт пользователя. Адрес — из окружения агента: `PARLEY_WORK_DIR` и
 * `PARLEY_SESSION_ID`, а у процесса, которому положили только прежние, — `HARNAS_*`.
 */
export const HOOK_COMMAND = `cat >> "${fromShellEnv('WORK_DIR')}/events/${fromShellEnv('SESSION_ID')}.jsonl" || true`;

/** Хуки таблицы 4.2: промпты, разрешения, вопросы агента, Stop, субагенты, сессия. */
export const HOOK_EVENTS = [
  'UserPromptSubmit',
  'Notification',
  'PermissionRequest',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'SessionStart',
  'SessionEnd',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * `SessionEnd` придерживает выход процесса, поэтому у него есть предел; у
 * остальных хуков дописывание строки мгновенное, и ограничивать его незачем.
 */
const TIMEOUT_SEC: Partial<Record<HookEvent, number>> = { SessionEnd: 5 };

export interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number;
}

/**
 * HTTP-обработчик ленты (вид «Chat», решение 1): тот же stdin-JSON уходит POST-запросом на приёмник
 * хоста, решение — тело ответа. Токен и id сессии Claude Code подставляет из окружения агента — только
 * переменные из `allowedEnvVars`.
 */
export interface HookHttp {
  type: 'http';
  url: string;
  headers: Record<string, string>;
  allowedEnvVars: string[];
  timeout?: number;
}

export interface HookMatcher {
  /** Только у `PreToolUse` ленты: какие инструменты ждут ответа окна. */
  matcher?: string;
  hooks: (HookCommand | HookHttp)[];
}

export interface StatusLineSetting {
  type: 'command';
  command: string;
}

export interface SettingsFile {
  hooks: Record<string, HookMatcher[]>;
  statusLine: StatusLineSetting;
}

/** События, которые лента получает HTTP-хуками (вид «Chat», решение 1). */
export const FEED_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'MessageDisplay',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Stop',
  'StopFailure',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PostModelSwitch',
] as const;

/**
 * Предел HTTP-хуков, которые ждут нажатия человека в окне: час. Остальные — умолчание Claude Code
 * (`MessageDisplay` держит порцию текста до ответа, и хост отвечает на него сразу). `PreToolUse`
 * идёт для всех инструментов без матчера: обычным вызовам хост отвечает сразу, вопрос и план ждут окна.
 */
const FEED_TIMEOUT_SEC: Readonly<Record<string, number>> = {
  PermissionRequest: 3600,
  PreToolUse: 3600,
};

/** Переменные окружения агента, которые Claude Code подставляет в заголовки HTTP-хука. */
const HOOK_TOKEN_ENV = `${ENV_PREFIX}HOOK_TOKEN`;
const SESSION_ID_ENV = `${ENV_PREFIX}SESSION_ID`;

export interface WorkSettingsOptions {
  /** Optional session-local file; omitted keeps the legacy work settings path. */
  sessionId?: string;
  /**
   * Адрес приёмника хуков хоста (`http://127.0.0.1:<порт>/hooks`). Нет — в файле только прежние
   * хуки и строка статуса, побайтно как до ленты.
   */
  hookUrl?: string;
  /** Какие события слать HTTP; по умолчанию — `FEED_HOOK_EVENTS`. */
  hookEvents?: readonly string[];
}

function feedHook(url: string, event: string): HookHttp {
  const hook: HookHttp = {
    type: 'http',
    url,
    headers: {
      Authorization: `Bearer $${HOOK_TOKEN_ENV}`,
      'X-Parley-Session': `$${SESSION_ID_ENV}`,
    },
    allowedEnvVars: [HOOK_TOKEN_ENV, SESSION_ID_ENV],
  };
  const timeout = FEED_TIMEOUT_SEC[event];
  if (timeout !== undefined) hook.timeout = timeout;
  return hook;
}

/**
 * Содержимое `settings.json` работы. Чужие хуки пользователя не трогаются:
 * `--settings` мержится с его настройками — мерж делает сам Claude Code.
 *
 * С `hookUrl` к прежним хукам добавляются HTTP-обработчики ленты: у событий из обоих списков —
 * в той же группе после `cat >>`, у новых — своей группой. Журнал `events/` остаётся как был: по
 * нему считается активность.
 */
export function workSettings({
  hookUrl,
  hookEvents = FEED_HOOK_EVENTS,
}: WorkSettingsOptions = {}): SettingsFile {
  const hooks: Record<string, HookMatcher[]> = {};
  for (const event of HOOK_EVENTS) {
    const timeout = TIMEOUT_SEC[event];
    const command: HookCommand = { type: 'command', command: HOOK_COMMAND };
    if (timeout !== undefined) command.timeout = timeout;
    hooks[event] = [{ hooks: [command] }];
  }
  if (hookUrl !== undefined) {
    for (const event of hookEvents) {
      const http = feedHook(hookUrl, event);
      const group = hooks[event]?.[0];
      if (group !== undefined) {
        group.hooks.push(http);
      } else {
        hooks[event] = [{ hooks: [http] }];
      }
    }
  }
  return { hooks, statusLine: { type: 'command', command: statusLineCommand() } };
}

export function workSettingsJson(options: WorkSettingsOptions = {}): string {
  return `${JSON.stringify(workSettings(options), null, 2)}\n`;
}

/**
 * Session files never follow an existing settings symlink or truncate a hard-linked
 * file. Directory handles and repeated identity checks bound path redirects; Node's
 * portable rename API still has a final parent-check/rename race (no openat/renameat).
 */
async function writeSessionSettings(stateRoot: string, workDir: string, file: string, json: string): Promise<void> {
  const unsafe = (): Error => new Error('unsafe-session-settings-path');
  const same = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;
  const rootStat = await lstat(stateRoot);
  if (!rootStat.isDirectory()) throw unsafe();
  const canonicalRoot = await realpath(stateRoot);
  const relative = path.relative(stateRoot, workDir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw unsafe();
  const canonicalWork = path.join(canonicalRoot, relative);
  // Check every work-relative component, not only the final work directory.
  let component = canonicalRoot;
  const directories: { file: string; stat: Stats }[] = [{ file: component, stat: rootStat }];
  for (const part of relative.split(path.sep)) {
    component = path.join(component, part);
    const current = await lstat(component);
    if (!current.isDirectory()) throw unsafe();
    directories.push({ file: component, stat: current });
  }
  const parent = path.join(canonicalWork, 'settings');
  try { await mkdir(parent, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const noFollow = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const parentHandle = await open(parent, noFollow);
  let temporary: string | undefined;
  try {
    const parentStat = await parentHandle.stat();
    if (!parentStat.isDirectory()) throw unsafe();
    directories.push({ file: parent, stat: parentStat });
    const verifyParents = async (): Promise<void> => {
      if (await realpath(stateRoot) !== canonicalRoot || await realpath(workDir) !== canonicalWork) throw unsafe();
      for (const directory of directories) {
        const current = await lstat(directory.file);
        if (!current.isDirectory() || !same(current, directory.stat)) throw unsafe();
      }
      if (await realpath(parent) !== parent) throw unsafe();
    };
    const target = path.join(parent, path.basename(file));
    const leaf = async (): Promise<Stats | undefined> => {
      let current: Stats;
      try { current = await lstat(target); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
      if (!current.isFile()) throw unsafe();
      const handle = await open(target, noFollow);
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || !same(current, opened)) throw unsafe();
        return opened;
      } finally { await handle.close(); }
    };
    await verifyParents();
    const before = await leaf();
    temporary = path.join(parent, `.settings-${randomUUID()}.tmp`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(json, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await verifyParents();
    const after = await leaf();
    if (before === undefined ? after !== undefined : after === undefined || !same(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw unsafe();
    await rename(temporary, target);
    temporary = undefined;
    await verifyParents();
  } finally {
    // Never remove through a redirected parent, even when cleaning up a failed write.
    try {
      if (temporary !== undefined) {
        const current = await lstat(parent).catch(() => undefined);
        const opened = await parentHandle.stat();
        if (current?.isDirectory() && same(current, opened) && await realpath(parent).catch(() => undefined) === parent) await unlink(temporary).catch(() => undefined);
      }
    } finally { await parentHandle.close(); }
  }
}

/**
 * Пишет `settings.json` работы и заводит каталог `events/`: хук умеет только
 * дописывать файл, каталог под него создаём мы.
 */
export async function writeWorkSettings(
  projectPath: string,
  workId: string,
  options: WorkSettingsOptions = {},
): Promise<string> {
  if (options.sessionId !== undefined && !/^s-\d+$/.test(options.sessionId)) throw new Error('invalid-session-id');
  const paths = workPaths(projectPath, workId);
  const file = options.sessionId === undefined ? paths.settings : path.join(paths.dir, 'settings', `${options.sessionId}.json`);
  const root = await ensureStateDir(projectPath);
  if (options.sessionId !== undefined) await writeSessionSettings(root, paths.dir, file, workSettingsJson(options));
  await mkdir(paths.events, { recursive: true });
  if (options.sessionId === undefined) await writeFile(file, workSettingsJson(options), 'utf8');
  return file;
}
