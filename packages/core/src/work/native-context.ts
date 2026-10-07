import { randomUUID } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { stateDir } from './state-dir.js';
import { tomlString } from './mcp-config.js';
import type { SkillCatalog } from '../skills/catalog.js';
import type { NativeSkill, SkillUnavailableReason } from '../skills/types.js';

/** LOCAL-only launch projection. No prompts, raw config, secrets or computed model defaults. */
export interface NativeContextDescriptor {
  version: 1;
  revision: string;
  provider: string;
  cwd: string;
  verified: boolean;
  command?: string;
  configArgs: string[];
  roots: { homeDir: string; codexHome?: string; claudeConfigDir?: string };
  process?: { pid: number; startedAtProcess: string };
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
/** Re-serialize only approved human selectors/root markers; never retain raw -c text/comments. */
export function projectNativeSkillConfigArgs(args: readonly string[]): string[] | null {
  if (args.length > 128 || args.length % 2 !== 0) return null;
  const projected: string[] = [];
  const quote = tomlString;
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] !== '-c' || typeof args[i + 1] !== 'string') return null;
    const text = args[i + 1]!;
    const key = text.slice(0, text.indexOf('=')).trim();
    let parsed: Record<string, unknown>;
    try { parsed = parseToml(text); } catch { return null; }
    if (key === 'project_root_markers') {
      const markers = parsed.project_root_markers;
      if (!Array.isArray(markers) || markers.length > 128 || !markers.every(value => typeof value === 'string' && value.length > 0 &&
        !path.isAbsolute(value) && !value.replaceAll(String.fromCharCode(92), '/').split('/').includes('..'))) return null;
      projected.push('-c', `project_root_markers=[${markers.map(value => quote(value as string)).join(',')}]`);
    } else if (key === 'skills.config') {
      if (!record(parsed.skills) || !Array.isArray(parsed.skills.config) || parsed.skills.config.length > 2000) return null;
      const entries: string[] = [];
      for (const entry of parsed.skills.config) {
        if (!record(entry) || typeof entry.enabled !== 'boolean' ||
          Object.keys(entry).some(key => !['name', 'path', 'enabled'].includes(key)) ||
          (Object.hasOwn(entry, 'name') === Object.hasOwn(entry, 'path'))) return null;
        const selector = Object.hasOwn(entry, 'name') ? 'name' : 'path';
        const value = entry[selector];
        if (typeof value !== 'string' || !value || (selector === 'path' && !path.isAbsolute(value))) return null;
        entries.push(`{${selector}=${quote(value)},enabled=${entry.enabled}}`);
      }
      projected.push('-c', `skills.config=[${entries.join(',')}]`);
    } else return null;
  }
  return projected;
}
function valid(value: unknown): value is NativeContextDescriptor {
  if (!record(value) || value.version !== 1 || typeof value.revision !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(value.revision) || typeof value.provider !== 'string' ||
    typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd) || typeof value.verified !== 'boolean' ||
    (value.command !== undefined && (typeof value.command !== 'string' || !path.isAbsolute(value.command))) ||
    !Array.isArray(value.configArgs) || value.configArgs.length > 128 || !value.configArgs.every(arg => typeof arg === 'string') ||
    !record(value.roots) || typeof value.roots.homeDir !== 'string' || !path.isAbsolute(value.roots.homeDir)) return false;
  for (const key of ['codexHome', 'claudeConfigDir']) if (value.roots[key] !== undefined &&
    (typeof value.roots[key] !== 'string' || !path.isAbsolute(value.roots[key]))) return false;
  if (Object.keys(value).some(key => !['version', 'revision', 'provider', 'cwd', 'verified', 'command', 'configArgs', 'roots', 'process'].includes(key)) ||
    Object.keys(value.roots).some(key => !['homeDir', 'codexHome', 'claudeConfigDir'].includes(key))) return false;
  if (value.configArgs.length % 2 !== 0) return false;
  if (JSON.stringify(projectNativeSkillConfigArgs(value.configArgs as string[])) !== JSON.stringify(value.configArgs)) return false;
  if (value.process !== undefined && (!record(value.process) || !Number.isSafeInteger(value.process.pid) ||
    Number(value.process.pid) < 1 || typeof value.process.startedAtProcess !== 'string' || !value.process.startedAtProcess)) return false;
  return true;
}
function location(projectPath: string, workId: string, sessionId: string, suffix = '.json'): string {
  if (!/^w-\d+$/.test(workId) || !/^s-\d+$/.test(sessionId)) throw new Error('context-unverified');
  return path.join(stateDir(projectPath), 'local', 'native-context', workId, `${sessionId}${suffix}`);
}
async function directory(file: string, create: boolean): Promise<void> {
  const dir = path.dirname(file);
  // Check each parent before making its child; never mkdir through an occupied symlink.
  const parents: string[] = [];
  let current = dir;
  for (let i = 0; i < 4; i++) { parents.unshift(current); current = path.dirname(current); }
  for (const parent of parents) {
    try {
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('context-unverified');
    } catch (error) {
      if (!create || !record(error) || error.code !== 'ENOENT') throw error;
      try { await mkdir(parent, { mode: 0o700 }); }
      catch (error) { if (!record(error) || error.code !== 'EEXIST') throw error; }
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('context-unverified');
    }
  }
}
/** Атомарная приватная запись (`.tmp` + `rename`, режим 0600) под проверкой родительских папок. */
async function storePrivate(file: string, body: string): Promise<void> {
  let temporary: string | undefined;
  try {
    await directory(file, true);
    temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(body, 'utf8'); } finally { await handle.close(); }
    await rename(temporary, file);
  } finally { if (temporary) await unlink(temporary).catch(() => {}); }
}
/** Чтение приватного файла без симлинков: режим без доступа группе и прочим, размер в пределе, строгий UTF-8 и JSON. */
async function loadPrivate(file: string, limit: number): Promise<unknown> {
  await directory(file, false);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit || (info.mode & 0o077) !== 0) throw new Error('context-unverified');
    const bytes = Buffer.alloc(info.size + 1);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    // Файл вырос между `stat` и чтением: целиком его уже не доверяем.
    if (read.bytesRead > info.size) throw new Error('context-unverified');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, read.bytesRead)));
  } finally { await handle.close(); }
}
/** A failed descriptor write never blocks a plain provider launch. Own env revision prevents stale reuse. */
export async function writeNativeContext(projectPath: string, workId: string, sessionId: string, value: NativeContextDescriptor): Promise<boolean> {
  try {
    if (!valid(value)) return false;
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > 32768) return false;
    await storePrivate(location(projectPath, workId, sessionId), body);
    return true;
  } catch { return false; }
}
export async function readNativeContext(projectPath: string, workId: string, sessionId: string): Promise<NativeContextDescriptor | null> {
  try {
    const value = await loadPrivate(location(projectPath, workId, sessionId), 32768);
    return valid(value) ? value : null;
  } catch { return null; }
}

/** Предел файла каталога навыков: байты и число записей. */
const SKILLS_MAX_BYTES = 4 * 1024 * 1024;
const SKILLS_MAX_ENTRIES = 20000;
// Записи на `Record<…, true>`: набор значений синхронен с типами и проверяется при сборке.
const SKILL_SOURCES: Record<Exclude<NativeSkill['source'], 'claude.ai'>, true> = { user: true, project: true, plugin: true, system: true, admin: true, extra: true };
const SKILL_REASONS: Record<SkillUnavailableReason, true> = {
  'human-disabled': true, 'user-invocable-only': true, 'implicit-invocation-disabled': true, 'disable-model-invocation': true,
  'plugin-disabled': true, shadowed: true, 'availability-unverified': true, 'invalid-metadata': true, 'load-tool-unavailable': true,
};
const SKILL_KEYS = ['name', 'description', 'source', 'path', 'modelAvailable', 'unavailableReason'];
/** Запись каталога строго той формы, которую пишет запуск; доступность и причина согласованы. */
function validSkill(value: unknown): value is Omit<NativeSkill, 'provider' | 'documentKind'> {
  if (!record(value) || Object.keys(value).length !== SKILL_KEYS.length || !SKILL_KEYS.every(key => Object.hasOwn(value, key))) return false;
  const { name, description, source, path: file, modelAvailable, unavailableReason } = value;
  return typeof name === 'string' && name !== '' && !name.includes('\0') && typeof description === 'string' &&
    typeof source === 'string' && Object.hasOwn(SKILL_SOURCES, source) && typeof file === 'string' && path.isAbsolute(file) &&
    typeof modelAvailable === 'boolean' &&
    (unavailableReason === null || (typeof unavailableReason === 'string' && Object.hasOwn(SKILL_REASONS, unavailableReason))) &&
    modelAvailable === (unavailableReason === null);
}
/**
 * Каталог навыков Codex этого запуска рядом с дескриптором: MCP-серверу `parley` не нужно самому запускать
 * `codex app-server`. Привязан к ревизии запуска. Неудачная запись никогда не мешает запуску — вернёт `false`.
 */
export async function writeNativeSkillCatalog(projectPath: string, workId: string, sessionId: string, revision: string, catalog: SkillCatalog): Promise<boolean> {
  try {
    if (catalog.provider !== 'codex' || !/^[a-f0-9-]{36}$/.test(revision) || catalog.skills.length > SKILLS_MAX_ENTRIES) return false;
    const skills = catalog.skills.map(skill => ({ name: skill.name, description: skill.description, source: skill.source,
      path: skill.path, modelAvailable: skill.modelAvailable, unavailableReason: skill.unavailableReason }));
    if (!skills.every(validSkill)) return false;
    const body = JSON.stringify({ version: 1, revision, skills });
    if (Buffer.byteLength(body) > SKILLS_MAX_BYTES) return false;
    await storePrivate(location(projectPath, workId, sessionId, '.skills.json'), body);
    return true;
  } catch { return false; }
}
/** Сохранённый каталог ровно этой ревизии запуска; чужая ревизия, не та форма или любой отказ проверки — `null`. */
export async function readNativeSkillCatalog(projectPath: string, workId: string, sessionId: string, revision: string): Promise<SkillCatalog | null> {
  try {
    const value = await loadPrivate(location(projectPath, workId, sessionId, '.skills.json'), SKILLS_MAX_BYTES);
    if (!record(value) || Object.keys(value).length !== 3 || value.version !== 1 || value.revision !== revision ||
      !/^[a-f0-9-]{36}$/.test(revision) || !Array.isArray(value.skills) || value.skills.length > SKILLS_MAX_ENTRIES ||
      !value.skills.every(validSkill)) return null;
    return { provider: 'codex', diagnostics: [], partial: false,
      skills: value.skills.map(skill => ({ provider: 'codex' as const, documentKind: 'skill' as const, ...skill })) };
  } catch { return null; }
}
/** Bind only a new unbound descriptor. A previous launch's stamp must never be rewritten. */
export async function stampNativeContext(projectPath: string, workId: string, sessionId: string,
  process: { pid: number; startedAtProcess: string | null }, revision?: string): Promise<void> {
  if (process.startedAtProcess === null || revision === undefined) return;
  const current = await readNativeContext(projectPath, workId, sessionId);
  if (current === null || current.process !== undefined || current.revision !== revision) return;
  await writeNativeContext(projectPath, workId, sessionId, { ...current, process: { pid: process.pid, startedAtProcess: process.startedAtProcess } });
}
export async function nativeContextMatches(value: NativeContextDescriptor, provider: string, cwd: string,
  revision?: string, process?: { pid: number | null; startedAtProcess: string | null; lifecycle?: string }): Promise<boolean> {
  try {
    if (value.provider !== provider || value.cwd !== await realpath(cwd)) return false;
    if (revision !== undefined) return value.revision === revision;
    return value.process !== undefined && process !== undefined && (value.process.pid === process.pid || (process.pid === null && process.lifecycle === 'closed')) &&
      value.process.startedAtProcess === process.startedAtProcess;
  } catch { return false; }
}
