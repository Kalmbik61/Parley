/**
 * Сокращение родного каталога скиллов при включённом навигаторе (спека навигатора, 2.1–2.4, 6.1; живая проба
 * 2026-10-05). Только запуск: ничего не пишется в `~/.claude` и `~/.codex`, чужие файлы читаются.
 *
 * - Claude Code: переменная `SLASH_COMMAND_TOOL_CHAR_BUDGET=1` в окружении процесса агента оставляет в каталоге
 *   одни имена, а мод jev выключается записью `enabledPlugins` в файле настроек сессии.
 * - Codex: `-c skills.include_instructions=false` убирает каталог целиком (подстановка `{skillCatalog}`), но только
 *   если `find_skill` покрывает все навыки родного списка (решение человека 2026-10-06): иначе список остаётся.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { readCodexListCoverage, type SkillContextOptions } from '../skills/context.js';

/** Окружение процесса агента Claude Code при сокращённом списке: в каталоге остаются имена. */
export const CLAUDE_SKILL_BUDGET_ENV = { SLASH_COMMAND_TOOL_CHAR_BUDGET: '1' } as const;

/**
 * Выключатель сокращения списка Claude. Сокращённый список оставляет Claude имена, а описания отдаёт `find_skill`
 * (спека, 2.3): его каталог Claude берётся из вложения `skill_listing` транскрипта сессии и описаний на диске
 * (`skills/claude-listing.ts`), поэтому сокращение включено по умолчанию. Выключатель остаётся для тестов и как
 * рубильник: `false` оставляет список Claude полным, переменная бюджета и мод jev не трогаются.
 */
export const claudeSkillRoute = { catalogReady: true };

/**
 * Чтение каталога Codex запуска: покрывает ли `find_skill` весь родной список. Швом служит объект, как
 * `claudeSkillRoute`: тесты подменяют чтение, настоящий запуск спрашивает `codex app-server`. Ошибка чтения —
 * `unreadable`, список остаётся полным.
 */
export const codexSkillRoute: { coverage: (options: SkillContextOptions) => Promise<'covered' | 'uncovered' | 'unreadable'> } = {
  coverage: (options) => readCodexListCoverage(options).catch(() => 'unreadable' as const),
};

/** Значение подстановки `{skillCatalog}`: целое присваивание TOML для `-c` Codex. */
export const CODEX_SKILL_CATALOG_OVERRIDE = 'skills.include_instructions=false';

const JEV_PLUGIN_NAME = 'jev-skill-suggestion';
/** Манифест плагина читается целиком: настоящий весит несколько килобайт, больший — не наш случай. */
const MANIFEST_MAX_BYTES = 1048576;

/** Нет файла или на его месте не папка (запись `skills/` — файл): манифеста нет, это не сбой чтения. */
const isMissing = (error: unknown): boolean => {
  const code = typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/** Текст файла; `null` — файла нет, исключение — прочитать не вышло (доступ, не файл, слишком большой). */
async function readText(file: string): Promise<string | null> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MANIFEST_MAX_BYTES) throw new Error('manifest-unreadable');
    return await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/**
 * Точные id мода jev там, где он установлен: плагин-папка в `skills/` конфигурации Claude или проекта
 * (`<имя из .claude-plugin/plugin.json>@skills-dir`, как её грузит сам Claude Code) и записи реестра
 * `plugins/installed_plugins.json`. Id не угадывается: нет установки — пустой список, отключать нечего.
 *
 * `null` — прочитать место установки не удалось, и мод может быть включён незаметно: сокращать список нельзя.
 */
export async function findJevPluginIds(cwd: string, configDir: string): Promise<string[] | null> {
  const ids = new Set<string>();
  try {
    for (const base of [configDir, path.join(cwd, '.claude')]) {
      const skills = path.join(base, 'skills');
      let entries: string[];
      try {
        entries = await readdir(skills);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      for (const entry of entries) {
        if (entry.startsWith('.')) continue;
        const manifest = await readText(path.join(skills, entry, '.claude-plugin', 'plugin.json'));
        if (manifest === null) continue;
        let name: unknown;
        try { name = (JSON.parse(manifest) as { name?: unknown }).name; } catch { continue; }
        if (name === JEV_PLUGIN_NAME) ids.add(`${JEV_PLUGIN_NAME}@skills-dir`);
      }
    }
    const registry = await readText(path.join(configDir, 'plugins', 'installed_plugins.json'));
    if (registry !== null) {
      let plugins: unknown;
      try { plugins = (JSON.parse(registry) as { plugins?: unknown }).plugins; } catch { plugins = undefined; }
      if (plugins !== null && typeof plugins === 'object') {
        for (const id of Object.keys(plugins)) if (id.startsWith(`${JEV_PLUGIN_NAME}@`)) ids.add(id);
      }
    }
  } catch {
    return null;
  }
  return [...ids].sort();
}

/**
 * Можно ли сократить список Claude в этом запуске и что для этого выключить. Путь загрузки подтверждён, когда
 * у `find_skill` есть каталог Claude (`claudeSkillRoute.catalogReady`), сессия без нативной роли (у неё
 * список инструментов свой, Skill и `find_skill` не гарантированы), сервер
 * `parley` доставляется шаблоном, а мод jev либо не установлен, либо выключается файлом настроек сессии.
 */
export async function claudeSkillReduction(input: {
  nativeRole: boolean;
  mcpRoute: boolean;
  settingsFile: boolean;
  cwd: string;
  configDir: string;
}): Promise<{ reduced: false } | { reduced: true; disablePlugins: string[] }> {
  if (!claudeSkillRoute.catalogReady || input.nativeRole || !input.mcpRoute) return { reduced: false };
  const jev = await findJevPluginIds(input.cwd, input.configDir);
  if (jev === null || (jev.length > 0 && !input.settingsFile)) return { reduced: false };
  return { reduced: true, disablePlugins: jev };
}
