/**
 * Файл настроек Claude Code для сессий работы — тот, что уезжает в `--settings`
 * (дизайн TUI v2, раздел 4.2). Один на работу: команда хука не зависит от
 * сессии, её адрес приходит из окружения процесса.
 *
 * Хук не содержит логики: stdin-JSON от Claude Code дописывается в журнал
 * сессии как есть, состояние выводят читатели. В `~/.claude` при этом ничего не
 * пишется — юридическая граница проекта.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { workPaths } from './store.js';

/**
 * Команда всех хуков. `|| true` держит код выхода нулевым: недоступный каталог
 * событий не должен ронять хук (раздел 10), а код 2 у `UserPromptSubmit` стёр
 * бы промпт пользователя.
 */
export const HOOK_COMMAND = 'cat >> "$HARNAS_WORK_DIR/events/$HARNAS_SESSION_ID.jsonl" || true';

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

export interface SettingsFile {
  hooks: Record<string, HookMatcher[]>;
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
  return { hooks };
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
  await mkdir(paths.events, { recursive: true });
  await writeFile(paths.settings, workSettingsJson(), 'utf8');
  return paths.settings;
}
