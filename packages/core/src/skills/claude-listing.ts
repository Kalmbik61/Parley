/**
 * Рабочий каталог скиллов Claude для `find_skill` (спека навигатора, 2.1, 2.4, 3.2).
 *
 * Что модель может загрузить, знает сам Claude Code: он пишет в транскрипт сессии вложение
 * `attachment.type === 'skill_listing'` с полем `names` — теми именами, что показал модели (с учётом
 * skillOverrides, disable-model-invocation, включённости плагинов и скиллов claude.ai). Поле полное и при
 * сокращённом списке (`SLASH_COMMAND_TOOL_CHAR_BUDGET=1`), когда `content` — одни имена. Доступность берётся
 * оттуда, описания — из SKILL.md на диске. Только чтение: транскрипт читается по известному id сессии и
 * ограниченными окнами, симлинки и чужие пути не открываются.
 */

import { constants, type Dirent } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { claudeProjectRoots } from '../discover.js';
import { discoverClaudeSkills } from './claude.js';
import type { SkillCatalog } from './catalog.js';
import { readMarkdownFrontmatter } from './frontmatter.js';
import type { NativeSkill } from './types.js';

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Окно чтения с каждого конца транскрипта: он бывает в сотни мегабайт, а вложение стоит у начала хода. */
export const LISTING_WINDOW_BYTES = 4 * 1024 * 1024;
/** Потолок на число и длину имён в одном вложении: настоящий список — сотни коротких имён. */
const NAMES_MAX = 5000;
const NAME_MAX_CHARS = 200;

export type ListedNames =
  | { status: 'ok'; names: string[] }
  | { status: 'no-transcript' }
  | { status: 'no-listing' };

/** Файл `<uuid>.jsonl` в каталоге проекта одного из корней истории; симлинки и не-файлы пропускаются. */
async function transcriptFile(uuid: string, roots: readonly string[]): Promise<string | null> {
  for (const root of roots) {
    let projects: Dirent[];
    try { projects = await readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const file = path.join(root, project.name, `${uuid}.jsonl`);
      try {
        const info = await lstat(file);
        if (info.isFile()) return file;
      } catch { /* В этом каталоге проекта такого транскрипта нет. */ }
    }
  }
  return null;
}

/** Целые строки из окон файла: у края окна строка может быть оборвана, её отбрасываем. */
async function windowLines(file: string, windowBytes: number): Promise<string[] | null> {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const read = async (start: number, length: number): Promise<string> => {
      const buffer = Buffer.alloc(length);
      let got = 0;
      while (got < length) {
        const { bytesRead } = await handle.read(buffer, got, length - got, start + got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      return buffer.subarray(0, got).toString('utf8');
    };
    if (info.size <= windowBytes * 2) return (await read(0, info.size)).split('\n');
    const head = await read(0, windowBytes);
    const tail = await read(info.size - windowBytes, windowBytes);
    // Голова кончается обрывом строки, хвост им начинается.
    return [...head.slice(0, head.lastIndexOf('\n')).split('\n'), ...tail.slice(tail.indexOf('\n') + 1).split('\n')];
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Имена, которые Claude Code показал модели этой сессии: последний полный список (`isInitial` не `false`)
 * плюс добавки (`isInitial: false`) после него. Битые строки пропускаются.
 */
export async function readClaudeListedNames(
  uuid: string,
  options: { roots?: readonly string[]; windowBytes?: number } = {},
): Promise<ListedNames> {
  if (!SESSION_UUID.test(uuid)) return { status: 'no-transcript' };
  const file = await transcriptFile(uuid, options.roots ?? claudeProjectRoots());
  if (file === null) return { status: 'no-transcript' };
  const lines = await windowLines(file, options.windowBytes ?? LISTING_WINDOW_BYTES);
  if (lines === null) return { status: 'no-transcript' };
  let names: Set<string> | null = null;
  for (const line of lines) {
    if (!line.includes('"skill_listing"')) continue;
    let attachment: unknown;
    try { attachment = (JSON.parse(line) as { attachment?: unknown }).attachment; } catch { continue; }
    if (attachment === null || typeof attachment !== 'object') continue;
    const { type, names: listed, isInitial } = attachment as { type?: unknown; names?: unknown; isInitial?: unknown };
    if (type !== 'skill_listing' || !Array.isArray(listed) || listed.length > NAMES_MAX) continue;
    const valid = listed.filter((name): name is string => typeof name === 'string' && name !== '' && name.length <= NAME_MAX_CHARS);
    names = isInitial === false && names !== null ? new Set([...names, ...valid]) : new Set(valid);
  }
  return names === null ? { status: 'no-listing' } : { status: 'ok', names: [...names] };
}

/** Описание скилла claude.ai: папка `skills/synced/<аккаунт>/<имя>/SKILL.md`, первый аккаунт по имени. */
async function syncedDescription(configDir: string, name: string): Promise<{ description: string; file: string } | null> {
  const skill = name.slice('anthropic-skills:'.length);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(skill)) return null;
  const root = path.join(configDir, 'skills', 'synced');
  let accounts: Dirent[];
  try { accounts = await readdir(root, { withFileTypes: true }); } catch { return null; }
  let realRoot: string;
  try { realRoot = await realpath(root); } catch { return null; }
  for (const account of accounts.filter(item => item.isDirectory() && !item.name.startsWith('.')).sort((a, b) => a.name < b.name ? -1 : 1)) {
    try {
      const file = await realpath(path.join(root, account.name, skill, 'SKILL.md'));
      if (!file.startsWith(realRoot + path.sep)) continue;
      const header = await readMarkdownFrontmatter(file);
      const description = header.status === 'valid' && typeof header.data.description === 'string' ? header.data.description : '';
      return { description, file };
    } catch { /* У этого аккаунта такого скилла нет. */ }
  }
  return null;
}

export interface ClaudeCatalogOptions {
  cwd: string;
  homeDir: string;
  configDir?: string;
  providerSessionId: string | null;
  roots?: readonly string[];
  windowBytes?: number;
}

/**
 * Каталог скиллов Claude-сессии: перечень имён из транскрипта, описания с диска. Скилл, которого на диске
 * нет (встроенный), остаётся с именем без описания: загрузить его можно инструментом Skill по имени. Скилл
 * с диска, которого нет в перечне, модели недоступен и в каталог не входит. Нет транскрипта или вложения —
 * причина вместо каталога (повторить позже можно: вложение появляется с первым запросом к модели).
 */
export async function readClaudeSkillCatalog(options: ClaudeCatalogOptions): Promise<{ catalog: SkillCatalog } | { reason: string }> {
  if (options.providerSessionId === null) return { reason: 'This session has no Claude conversation id yet.' };
  const listed = await readClaudeListedNames(options.providerSessionId, {
    ...(options.roots ? { roots: options.roots } : {}),
    ...(options.windowBytes === undefined ? {} : { windowBytes: options.windowBytes }),
  });
  if (listed.status === 'no-transcript') return { reason: 'The Claude transcript of this session is not readable yet; use the native skill list.' };
  if (listed.status === 'no-listing') return { reason: 'Claude has not listed skills for this session yet (it does so with the first model request); use the native skill list.' };
  const configDir = options.configDir ?? path.join(options.homeDir, '.claude');
  const disk = await discoverClaudeSkills({ cwd: options.cwd, homeDir: options.homeDir, ...(options.configDir ? { configDir: options.configDir } : {}) });
  const byName = new Map<string, NativeSkill>();
  // Побеждает не тенью затёртая запись; из равных — первая в порядке каталога.
  for (const skill of disk.skills) {
    const known = byName.get(skill.name);
    if (known === undefined || (known.unavailableReason === 'shadowed' && skill.unavailableReason !== 'shadowed')) byName.set(skill.name, skill);
  }
  const skills: NativeSkill[] = [];
  for (const name of listed.names) {
    const found = byName.get(name);
    const synced = found === undefined && name.startsWith('anthropic-skills:') ? await syncedDescription(configDir, name) : null;
    skills.push({
      provider: 'claude',
      documentKind: found?.documentKind ?? 'skill',
      name,
      description: found?.description ?? synced?.description ?? '',
      source: found?.source ?? (synced ? 'claude.ai' : name.includes(':') ? 'plugin' : 'system'),
      path: found?.path ?? synced?.file ?? '',
      modelAvailable: true,
      unavailableReason: null,
    });
  }
  return { catalog: { provider: 'claude', skills, diagnostics: [], partial: false } };
}
