/**
 * Файл настроек Claude Code для сессий работы — тот, что уезжает в `--settings`
 * (дизайн TUI v2, раздел 4.2). Один на работу: команда хука не зависит от
 * сессии, её адрес приходит из окружения процесса.
 *
 * Хук не содержит логики: stdin-JSON от Claude Code дописывается в журнал
 * сессии как есть, состояние выводят читатели. В `~/.claude` при этом ничего не
 * пишется — юридическая граница проекта.
 *
 * Рядом с хуками — `statusLine`: скрипт строки статуса, который забирает лимиты подписки из
 * того, что Claude Code сам присылает (спека комнат Organic, 3.5). Как и хуки, он лежит в этом
 * файле, а не в настройках человека.
 */

import { mkdir, writeFile } from 'node:fs/promises';
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

export interface HookMatcher {
  hooks: HookCommand[];
}

export interface StatusLineSetting {
  type: 'command';
  command: string;
}

export interface SettingsFile {
  hooks: Record<string, HookMatcher[]>;
  statusLine: StatusLineSetting;
}

/**
 * Содержимое `settings.json` работы. Чужие хуки пользователя не трогаются:
 * `--settings` мержится с его настройками — мерж делает сам Claude Code.
 */
export function workSettings(): SettingsFile {
  const hooks: Record<string, HookMatcher[]> = {};
  for (const event of HOOK_EVENTS) {
    const timeout = TIMEOUT_SEC[event];
    const command: HookCommand = { type: 'command', command: HOOK_COMMAND };
    if (timeout !== undefined) command.timeout = timeout;
    hooks[event] = [{ hooks: [command] }];
  }
  return { hooks, statusLine: { type: 'command', command: statusLineCommand() } };
}

export function workSettingsJson(): string {
  return `${JSON.stringify(workSettings(), null, 2)}\n`;
}

/**
 * Пишет `settings.json` работы и заводит каталог `events/`: хук умеет только
 * дописывать файл, каталог под него создаём мы.
 */
export async function writeWorkSettings(projectPath: string, workId: string): Promise<string> {
  const paths = workPaths(projectPath, workId);
  await ensureStateDir(projectPath);
  await mkdir(paths.events, { recursive: true });
  await writeFile(paths.settings, workSettingsJson(), 'utf8');
  return paths.settings;
}
