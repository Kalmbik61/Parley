/**
 * Скан скиллов, своих команд и субагентов Claude Code для подсказок поля ввода (живая проверка
 * 2026-10-02; дизайн `docs/specs/2026-10-02-capabilities-design.md`). Только чтение: Parley ничего не
 * заводит, показывает то, что уже лежит у человека и в проекте для самого CLI. Отсутствие папки — не
 * ошибка, битый файл пропускается.
 */
import { open, readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { claudeCommands } from './claude-commands.js';
import { FRONTMATTER_BYTES, parseFrontmatter } from './frontmatter.js';
import type { Capabilities, CapabilityAgent, CapabilitySkill, CapabilitySource } from './types.js';

/** Предел записей (скиллы + субагенты): защита от огромных каталогов плагинов. */
const MAX_ENTRIES = 500;
/** Глубина вложенных папок своих команд: `папка:имя`. */
const MAX_COMMAND_DEPTH = 4;

export interface ScanOptions {
  /** Папка пользователя (хост передаёт `homedir()`). */
  home: string;
  projectPath: string;
}

/** Первые 4 КБ файла или `null`, если не читается. */
async function readHead(file: string): Promise<string | null> {
  try {
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(FRONTMATTER_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, FRONTMATTER_BYTES, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function entries(dir: string): Promise<Dirent[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** Папка ли запись: симлинки следуются (`stat`), если не `strict` (внутри плагинов наружу не ходим). */
async function isDir(dir: string, entry: Dirent, strict: boolean): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (strict || !entry.isSymbolicLink()) return false;
  try {
    return (await stat(path.join(dir, entry.name))).isDirectory();
  } catch {
    return false;
  }
}

async function isMarkdownFile(dir: string, entry: Dirent, strict: boolean): Promise<boolean> {
  if (!entry.name.endsWith('.md')) return false;
  if (entry.isFile()) return true;
  if (strict || !entry.isSymbolicLink()) return false;
  try {
    return (await stat(path.join(dir, entry.name))).isFile();
  } catch {
    return false;
  }
}

interface Budget {
  left: number;
}

type Prefixed = (name: string) => string;

async function scanSkills(
  root: string,
  source: CapabilitySource,
  prefix: Prefixed,
  budget: Budget,
  out: CapabilitySkill[],
): Promise<void> {
  const strict = source === 'plugin';
  for (const entry of await entries(root)) {
    if (budget.left <= 0) return;
    if (!(await isDir(root, entry, strict))) continue;
    const dir = path.join(root, entry.name);
    const head = await readHead(path.join(dir, 'SKILL.md'));
    if (head === null) continue;
    const meta = parseFrontmatter(head);
    out.push({ name: prefix(meta.name ?? entry.name), description: meta.description, source, path: dir });
    budget.left -= 1;
  }
}

async function scanCommands(
  root: string,
  source: CapabilitySource,
  budget: Budget,
  out: CapabilitySkill[],
  parents: string[] = [],
): Promise<void> {
  for (const entry of await entries(root)) {
    if (budget.left <= 0) return;
    const full = path.join(root, entry.name);
    if (await isMarkdownFile(root, entry, false)) {
      const head = await readHead(full);
      if (head === null) continue;
      const name = [...parents, entry.name.slice(0, -'.md'.length)].join(':');
      out.push({ name, description: parseFrontmatter(head).description, source, path: full });
      budget.left -= 1;
    } else if (parents.length < MAX_COMMAND_DEPTH && (await isDir(root, entry, false))) {
      await scanCommands(full, source, budget, out, [...parents, entry.name]);
    }
  }
}

async function scanAgents(
  root: string,
  source: CapabilitySource,
  prefix: Prefixed,
  budget: Budget,
  out: CapabilityAgent[],
): Promise<void> {
  const strict = source === 'plugin';
  for (const entry of await entries(root)) {
    if (budget.left <= 0) return;
    if (!(await isMarkdownFile(root, entry, strict))) continue;
    const file = path.join(root, entry.name);
    const head = await readHead(file);
    if (head === null) continue;
    const meta = parseFrontmatter(head);
    out.push({
      name: prefix(meta.name ?? entry.name.slice(0, -'.md'.length)),
      description: meta.description,
      source,
      path: file,
    });
    budget.left -= 1;
  }
}

/** Папки версий установленных плагинов: `<cache>/<маркетплейс>/<плагин>/<версия>` с именем плагина. */
async function pluginRoots(home: string): Promise<Array<{ plugin: string; dir: string }>> {
  const cache = path.join(home, '.claude', 'plugins', 'cache');
  const found: Array<{ plugin: string; dir: string }> = [];
  for (const market of await entries(cache)) {
    if (!(await isDir(cache, market, true))) continue;
    const marketDir = path.join(cache, market.name);
    for (const plugin of await entries(marketDir)) {
      if (!(await isDir(marketDir, plugin, true))) continue;
      const pluginDir = path.join(marketDir, plugin.name);
      // Новые версии первыми: при дубле имени побеждает более новая.
      const versions = (await entries(pluginDir)).reverse();
      for (const version of versions) {
        if (await isDir(pluginDir, version, true)) {
          found.push({ plugin: plugin.name, dir: path.join(pluginDir, version.name) });
        }
      }
    }
  }
  return found;
}

const RANK: Record<CapabilitySource, number> = { project: 0, user: 1, plugin: 2 };

/** Дубли по имени: project побеждает user, user — plugin; при равенстве остаётся первый найденный. */
function dedupe<T extends { name: string; source: CapabilitySource }>(items: T[]): T[] {
  const best = new Map<string, T>();
  for (const item of items) {
    const current = best.get(item.name);
    if (current === undefined || RANK[item.source] < RANK[current.source]) best.set(item.name, item);
  }
  return [...best.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function scanClaudeCapabilities(options: ScanOptions): Promise<Capabilities> {
  const { home, projectPath } = options;
  const budget: Budget = { left: MAX_ENTRIES };
  const skills: CapabilitySkill[] = [];
  const agents: CapabilityAgent[] = [];
  const plain: Prefixed = (name) => name;
  const userClaude = path.join(home, '.claude');
  const projectClaude = path.join(projectPath, '.claude');

  // Порядок — приоритет при пределе: проект, человек, плагины.
  await scanSkills(path.join(projectClaude, 'skills'), 'project', plain, budget, skills);
  await scanSkills(path.join(projectPath, '.agents', 'skills'), 'project', plain, budget, skills);
  await scanCommands(path.join(projectClaude, 'commands'), 'project', budget, skills);
  await scanAgents(path.join(projectClaude, 'agents'), 'project', plain, budget, agents);
  await scanSkills(path.join(userClaude, 'skills'), 'user', plain, budget, skills);
  await scanCommands(path.join(userClaude, 'commands'), 'user', budget, skills);
  await scanAgents(path.join(userClaude, 'agents'), 'user', plain, budget, agents);
  for (const { plugin, dir } of await pluginRoots(home)) {
    const prefix: Prefixed = (name) => `${plugin}:${name}`;
    await scanSkills(path.join(dir, 'skills'), 'plugin', prefix, budget, skills);
    await scanAgents(path.join(dir, 'agents'), 'plugin', prefix, budget, agents);
  }

  return { commands: [...claudeCommands()], skills: dedupe(skills), agents: dedupe(agents) };
}
