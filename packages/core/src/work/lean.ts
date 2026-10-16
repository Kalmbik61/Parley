/**
 * Облегчённый запуск агентов Parley (lean, спека «меньше ходов и легче контекст», C2.2, спайк C0).
 * Только запуск: флаги, переменные окружения и свой файл `--settings` сессии. В `~/.claude` и `~/.codex`
 * ничего не пишется — их файлы только читаются, чтобы узнать, что выключать.
 *
 * - Claude Code, GLM: `--strict-mcp-config` оставляет только сервер из `--mcp-config` (`parley`);
 *   `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` убирает автопамять проекта; плагины пользователя выключает
 *   `enabledPlugins` со значением `false` в файле настроек сессии (`settings-file.ts`).
 * - Codex: `-c mcp_servers.<id>.enabled=false` для чужих серверов из его `config.toml`.
 * Хуки Parley, `--append-system-prompt`, `PARLEY.md` и `CLAUDE.md` проекта не затрагиваются.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { MCP_SERVER_NAME } from '../names.js';

/** Значение подстановки `{leanFlags}` у Claude Code. */
export const CLAUDE_LEAN_FLAGS: readonly string[] = ['--strict-mcp-config'];

/** Окружение процесса Claude Code при lean: автопамять проекта (`MEMORY.md`) не загружается. */
export const CLAUDE_LEAN_ENV = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } as const;

/** Объект JSON-файла; нет файла или он не читается и не разбирается — `null`: выключать нечего, запуск идёт как был. */
async function readJsonObject(file: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Ключи `enabledPlugins` из `settings.json` в каталоге конфигурации Claude Code (по умолчанию `~/.claude`), а также из
 * `settings.json` и `settings.local.json` проекта в его каталоге `.claude`: id плагинов, которые Claude Code загрузил
 * бы в сессию. Только чтение; нет файла, он не читается или поле другого вида — вклад пустой. Порядок отсортирован:
 * файл настроек сессии получается одинаковым между запусками.
 */
export async function readUserPluginIds(cwd: string, configDir: string): Promise<string[]> {
  const files = [
    path.join(configDir, 'settings.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json'),
  ];
  const ids = new Set<string>();
  for (const file of files) {
    const plugins = (await readJsonObject(file))?.['enabledPlugins'];
    if (plugins === null || typeof plugins !== 'object' || Array.isArray(plugins)) continue;
    for (const id of Object.keys(plugins)) ids.add(id);
  }
  return [...ids].sort();
}

/** Имена серверов `[mcp_servers.<id>]` из `<codexHome>/config.toml`; нет файла, битый TOML или нет таблицы — пусто. */
export async function readCodexMcpServerIds(codexHome: string): Promise<string[]> {
  try {
    const servers = parseToml(await readFile(path.join(codexHome, 'config.toml'), 'utf8'))['mcp_servers'];
    return servers !== null && typeof servers === 'object' && !Array.isArray(servers) ? Object.keys(servers) : [];
  } catch {
    return [];
  }
}

/** Простой ключ TOML: пускается в `-c mcp_servers.<id>.enabled=…` без кавычек. */
const BARE_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * Значение подстановки `{leanFlags}` у Codex: пара `-c mcp_servers.<id>.enabled=false` на каждый чужой сервер.
 * Свой `parley` остаётся. Id не из простых ключей (точка, пробел) пропускается: как Codex разбирает такой путь в
 * `-c`, не проверено, а лишний включённый сервер безопаснее неверной пары.
 */
export function codexLeanFlags(serverIds: readonly string[]): string[] {
  return serverIds
    .filter((id) => id !== MCP_SERVER_NAME && BARE_KEY.test(id))
    .flatMap((id) => ['-c', `mcp_servers.${id}.enabled=false`]);
}
