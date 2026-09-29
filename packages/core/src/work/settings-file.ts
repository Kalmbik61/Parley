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
import { fileURLToPath } from 'node:url';
import { STATUSLINE_BIN } from './statusline.js';
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

export interface StatusLineSetting {
  type: 'command';
  command: string;
}

export interface SettingsFile {
  hooks: Record<string, HookMatcher[]>;
  statusLine: StatusLineSetting;
}

/**
 * Скрипт строки статуса лежит рядом с этим модулем, в `work/`: тем же способом, что и сервер MCP
 * (`mcp-config.ts`), — абсолютный путь к собранному файлу, а не имя из PATH.
 */
export const STATUSLINE_ENTRY = fileURLToPath(new URL(`./${STATUSLINE_BIN}.js`, import.meta.url));

/** Строка для оболочки: Claude Code запускает команду через неё, а в путях бывают пробелы. */
const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Команда строки статуса: node текущего процесса (хост запущен системным node, и тот же стоит у
 * агента) и скрипт по абсолютному пути — без надежды на PATH, как у сервера MCP. Адрес работы и
 * сессии скрипт берёт из окружения агента, как хуки.
 */
export const statusLineCommand = (): string =>
  `${shellQuote(process.execPath)} ${shellQuote(STATUSLINE_ENTRY)}`;

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
  await mkdir(paths.events, { recursive: true });
  await writeFile(paths.settings, workSettingsJson(), 'utf8');
  return paths.settings;
}
