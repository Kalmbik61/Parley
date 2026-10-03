/**
 * Скан скиллов, своих команд и субагентов Claude Code для подсказок поля ввода (живая проверка
 * 2026-10-02; дизайн `docs/specs/2026-10-02-capabilities-design.md`). Только чтение: Parley ничего не
 * заводит, показывает то, что уже лежит у человека и в проекте для самого CLI. Отсутствие папки — не
 * ошибка, битый файл пропускается.
 */
import { constants } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { resolveSkillCatalog } from '../skills/catalog.js';
import type { ClaudeDiscoveryOptions } from '../skills/claude.js';
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
  configDir?: string;
  settings?: ClaudeDiscoveryOptions['settings'];
  /** Explicit reusable session evidence, never inferred from installed files. */
  nativeEvidence?: ClaudeDiscoveryOptions['nativeEvidence'];
}

/** Первые 4 КБ файла или `null`, если не читается. */
async function readHead(file: string): Promise<string | null> {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) return null;
      const buffer = Buffer.alloc(FRONTMATTER_BYTES);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length), {
        stream: length === FRONTMATTER_BYTES,
      });
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
async function pluginRoots(configDir: string): Promise<Array<{ plugin: string; dir: string }>> {
  const cache = path.join(configDir, 'plugins', 'cache');
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
  const catalog = await resolveSkillCatalog({
    provider: 'claude',
    cwd: projectPath,
    homeDir: home,
    ...(options.configDir !== undefined ? { configDir: options.configDir } : {}),
    ...(options.settings !== undefined ? { settings: options.settings } : {}),
    ...(options.nativeEvidence !== undefined ? { nativeEvidence: options.nativeEvidence } : {}),
    limits: { maxCommandDepth: MAX_COMMAND_DEPTH },
  });
  const cwd = await realpath(projectPath).catch(() => null);
  if (cwd === null || catalog.diagnostics.some(item => item.code === 'missing-context'))
    return { commands: [...claudeCommands()], skills: [], agents: [] };
  // Manual slash suggestions retain hidden/unknown inventory; model search has its own filter.
  // New native source labels cannot be represented by the unchanged legacy wire enum.
  const skills: CapabilitySkill[] = [];
  for (const skill of catalog.skills) {
    const source = skill.source;
    if (source !== 'user' && source !== 'project' && source !== 'plugin') continue;
    if (skill.unavailableReason === 'shadowed') continue;
    skills.push({
      name: skill.name,
      description: skill.description || null,
      source,
      path: skill.documentKind === 'skill' ? path.dirname(skill.path) : skill.path,
    });
  }
  const inventory = dedupe(skills);
  const manualSkills: CapabilitySkill[] = [];
  const budget: Budget = { left: MAX_ENTRIES };
  const appendSkills = (source: CapabilitySource): void => {
    for (const skill of inventory) {
      if (skill.source !== source || budget.left <= 0) continue;
      manualSkills.push(skill);
      budget.left -= 1;
    }
  };
  const agents: CapabilityAgent[] = [];
  const plain: Prefixed = (name) => name;
  const userClaude = path.resolve(cwd, options.configDir ?? path.join(home, '.claude'));
  const projectClaude = path.join(projectPath, '.claude');
  // Keep the existing agent sources, priority, plugin safety and combined output budget.
  appendSkills('project');
  await scanAgents(path.join(projectClaude, 'agents'), 'project', plain, budget, agents);
  appendSkills('user');
  await scanAgents(path.join(userClaude, 'agents'), 'user', plain, budget, agents);
  appendSkills('plugin');
  for (const { plugin, dir } of await pluginRoots(userClaude)) {
    const prefix: Prefixed = (name) => `${plugin}:${name}`;
    await scanAgents(path.join(dir, 'agents'), 'plugin', prefix, budget, agents);
  }
  return { commands: [...claudeCommands()], skills: dedupe(manualSkills), agents: dedupe(agents) };
}
